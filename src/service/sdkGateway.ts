/**
 * DriveGateway backed by the official Proton Drive SDK (`ProtonDriveClient`).
 *
 * Responsibilities:
 *  - Map WebDAV paths ("/a/b") onto Proton nodes under a configured root
 *    (default `/my-files`), resolving one segment at a time by listing
 *    children (the same approach as the CLI's Paths class, without the CLI's
 *    string-escaping rules) with a short-lived UID cache.
 *  - Expose only committed content: files without an active revision (drafts,
 *    i.e. unfinished uploads) are invisible to listings and stat().
 *  - Uploads resolve only after `UploadController.completion()` — Proton has
 *    confirmed the revision commit. Interrupted uploads leave a draft that the
 *    SDK recovers automatically on the next attempt when it carries this
 *    client's UID; another client's draft is replaced only with explicit,
 *    path-scoped consent (`overrideOtherClientDraftForPath`).
 *  - Immutable semantics: an identical re-upload (same SHA-1) is reported as
 *    skipped, a differing one is refused with 412 unless immutability is off,
 *    in which case a new revision is created (previous revision kept by Proton).
 *  - Downloads: full reads use the SDK's verified download path; ranged reads
 *    use the SDK seekable stream (block-level, unverified by design — rclone
 *    still compares SHA-1 after full transfers).
 *  - Deletion is always trash (recoverable) and never touches drafts.
 */
import { createHash } from 'node:crypto';

import {
    AbortError,
    ConnectionError,
    IntegrityError,
    type Logger,
    type NodeEntity,
    NodeType,
    NodeWithSameNameExistsValidationError,
    type ProtonDriveClient,
    RateLimitedError,
    ServerError,
    ValidationError,
} from '@protontech/drive-sdk';

import { getName } from '../cli';
import { getLocalFileMediaType } from '../commands/fileSystem/mediaType';
import type { ServiceSession } from './bootstrap';
import {
    AlreadyExistsError,
    ConflictError,
    DraftConflictError,
    type DriveEntry,
    type DriveGateway,
    GatewayError,
    ImmutablePreconditionError,
    IntegrityFailedError,
    NotFoundError,
    type PutOptions,
    type PutResult,
    type ReadResult,
} from './gateway';
import { baseName, isRoot, isSafeSegment, join, normalize, parentPath, segments } from './paths';

const SHA1_RE = /^[0-9a-f]{40}$/;
const RESOLVE_CACHE_TTL_MS = 30_000;
const SEEK_READ_CHUNK = 1024 * 1024;

type Resolved = { uid: string; parentUid?: string; expiresAt: number };

/**
 * Bound on the path->uid cache. A long-lived daemon listing large trees would
 * otherwise grow without limit; the oldest entries are dropped first.
 */
const RESOLVE_CACHE_MAX_ENTRIES = 20_000;

export interface SdkGatewayOptions {
    /** Proton path acting as WebDAV root, e.g. "/my-files" or "/my-files/backups". */
    rootPath: string;
}

export class SdkGateway implements DriveGateway {
    private readonly sdk: ProtonDriveClient;
    private readonly logger: Logger;
    private rootUid?: string;
    private readonly resolveCache = new Map<string, Resolved>();

    constructor(
        private readonly session: ServiceSession,
        private readonly options: SdkGatewayOptions,
    ) {
        this.sdk = session.sdk;
        this.logger = session.logger;
    }

    // ---- path resolution -------------------------------------------------

    private async getRootUid(): Promise<string> {
        if (this.rootUid) {
            return this.rootUid;
        }
        const node = await this.session.paths.getNode(this.options.rootPath);
        if (node.type !== NodeType.Folder) {
            throw new GatewayError(`Configured root ${this.options.rootPath} is not a folder`, 500);
        }
        this.rootUid = node.uid;
        return node.uid;
    }

    private cachePath(path: string, uid: string, parentUid?: string): void {
        if (this.resolveCache.size >= RESOLVE_CACHE_MAX_ENTRIES) {
            // Map preserves insertion order, so this evicts the oldest entries.
            let toDrop = Math.max(1, Math.floor(RESOLVE_CACHE_MAX_ENTRIES / 10));
            for (const key of this.resolveCache.keys()) {
                this.resolveCache.delete(key);
                if (--toDrop <= 0) {
                    break;
                }
            }
        }
        this.resolveCache.set(path, { uid, parentUid, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
    }

    private invalidate(path: string): void {
        const p = normalize(path);
        for (const key of [...this.resolveCache.keys()]) {
            if (key === p || key.startsWith(p + '/')) {
                this.resolveCache.delete(key);
            }
        }
    }

    /**
     * Resolve a WebDAV path to a NodeEntity, or null if any segment is
     * missing. Draft files (no active revision) resolve for internal use
     * (`includeDrafts`) but are hidden from stat()/list().
     */
    private async resolve(path: string, includeDrafts = false): Promise<NodeEntity | null> {
        const p = normalize(path);
        const segs = segments(p);
        for (const s of segs) {
            if (!isSafeSegment(s)) {
                throw new GatewayError(`Invalid path segment`, 400);
            }
        }
        const rootUid = await this.getRootUid();
        if (segs.length === 0) {
            return this.sdk.getNode(rootUid);
        }
        const cached = this.resolveCache.get(p);
        if (cached && cached.expiresAt > Date.now()) {
            try {
                const node = await this.sdk.getNode(cached.uid);
                // Re-validate parent as well as name: another client may have
                // moved this node elsewhere, and serving it under the old path
                // would let a later DELETE trash a file in a different folder.
                const parentStillMatches = cached.parentUid === undefined || node.parentUid === cached.parentUid;
                if (
                    getName(node) === baseName(p) &&
                    parentStillMatches &&
                    !node.trashTime &&
                    (includeDrafts || node.type !== NodeType.File || node.activeRevision)
                ) {
                    return node;
                }
            } catch {
                // fall through to a fresh walk
            }
            this.resolveCache.delete(p);
        }
        const parent = segs.length === 1 ? await this.sdk.getNode(rootUid) : await this.resolve(parentPath(p));
        if (!parent || parent.type !== NodeType.Folder) {
            return null;
        }
        const name = baseName(p);
        let found: NodeEntity | null = null;
        for await (const child of this.sdk.iterateFolderChildren(parent)) {
            if (getName(child) === name) {
                found = child;
                break;
            }
        }
        if (!found) {
            return null;
        }
        if (found.type === NodeType.File && !found.activeRevision && !includeDrafts) {
            return null;
        }
        if (found.trashTime) {
            return null;
        }
        this.cachePath(p, found.uid, parent.uid);
        return found;
    }

    private async resolveOrThrow(path: string): Promise<NodeEntity> {
        const node = await this.resolve(path);
        if (!node) {
            throw new NotFoundError(`Not found: ${path}`);
        }
        return node;
    }

    // ---- metadata ----------------------------------------------------------

    private toEntry(node: NodeEntity, nameOverride?: string): DriveEntry | null {
        if (node.type !== NodeType.File && node.type !== NodeType.Folder) {
            return null;
        }
        if (node.trashTime) {
            // Trashed nodes are not live content and must not be listed, read,
            // or receive a new revision.
            return null;
        }
        const name = nameOverride ?? getName(node);
        if (!node.name.ok) {
            this.logger.warn(`Skipping node ${node.uid}: name cannot be decrypted`);
            return null;
        }
        if (!isSafeSegment(name)) {
            this.logger.warn(`Skipping node ${node.uid}: name not representable over WebDAV`);
            return null;
        }
        if (node.type === NodeType.Folder) {
            return {
                name,
                isDir: true,
                size: 0,
                mtime: node.folder?.claimedModificationTime ?? node.modificationTime,
            };
        }
        const rev = node.activeRevision;
        if (!rev) {
            return null; // draft / unfinished upload: not committed content
        }
        if (rev.claimedSize === undefined) {
            // Reporting 0 here would make rclone copy the file as empty and
            // consider it complete -- silent truncation. Omitting the entry makes
            // the gap visible instead.
            this.logger.warn(
                `Skipping node ${node.uid} (${name}): Proton reports no clear-text size for the active revision`,
            );
            return null;
        }
        const digest = rev.claimedDigests?.sha1?.toLowerCase();
        return {
            name,
            isDir: false,
            size: rev.claimedSize,
            mtime: rev.claimedModificationTime ?? node.modificationTime,
            ...(digest && SHA1_RE.test(digest) ? { sha1: digest } : {}),
        };
    }

    async stat(path: string): Promise<DriveEntry | null> {
        const node = await this.mapErrors(() => this.resolve(path));
        if (!node) {
            return null;
        }
        if (isRoot(path)) {
            return { name: '', isDir: true, size: 0, mtime: node.modificationTime };
        }
        return this.toEntry(node);
    }

    async list(path: string): Promise<DriveEntry[]> {
        const node = await this.mapErrors(() => this.resolveOrThrow(path));
        if (node.type !== NodeType.Folder) {
            throw new NotFoundError(`Not a directory: ${path}`);
        }
        const out: DriveEntry[] = [];
        const seen = new Set<string>();
        for await (const child of this.mapErrorsIterable(this.sdk.iterateFolderChildren(node))) {
            const entry = this.toEntry(child);
            if (!entry) {
                continue;
            }
            if (seen.has(entry.name)) {
                this.logger.warn(`Duplicate name in ${path}: ${entry.name} (keeping first)`);
                continue;
            }
            seen.add(entry.name);
            this.cachePath(join(path, entry.name), child.uid, node.uid);
            out.push(entry);
        }
        return out;
    }

    /** Run an SDK call, translating SDK errors into gateway/HTTP errors. */
    private async mapErrors<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn();
        } catch (error: unknown) {
            throw mapGenericError(error);
        }
    }

    private async *mapErrorsIterable<T>(iterable: AsyncIterable<T>): AsyncGenerator<T> {
        try {
            yield* iterable;
        } catch (error: unknown) {
            throw mapGenericError(error);
        }
    }

    // ---- read --------------------------------------------------------------

    async read(path: string, range?: { start: number; end: number }, signal?: AbortSignal): Promise<ReadResult> {
        const node = await this.resolveOrThrow(path);
        if (node.type !== NodeType.File || !node.activeRevision) {
            throw new NotFoundError(`Not a file: ${path}`);
        }
        const rev = node.activeRevision;
        const totalSize = rev.claimedSize;
        if (totalSize === undefined) {
            // Such revisions are hidden from listings (see toEntry); reaching
            // here means a direct request for one. Refuse rather than guess a
            // length, which would make rclone store a truncated file.
            throw new GatewayError(`${path}: Proton reports no clear-text size for this revision`, 409);
        }

        if (range) {
            return this.readRange(path, node, range, totalSize, signal);
        }
        return this.readWhole(path, node, totalSize, signal);
    }

    /**
     * Whole-file read through the SDK's verified download path.
     *
     * Two runtime facts drive the shape of this, both measured rather than assumed:
     *
     *  1. The SDK does NOT close the WritableStream it is handed. On success it
     *     only calls `writer.releaseLock()`; on failure it leaves the writer
     *     locked (internal/download/fileDownloader.ts). Ending the stream is the
     *     caller's job, so the readable is driven directly from `completion()`.
     *  2. Erroring a Bun response body is only visible to the client once bytes
     *     have started flowing. Measured against Bun 1.3.14 over a Unix socket:
     *     a stream that errors AFTER its first chunk resets the connection, which
     *     a client reports as a failed transfer; a stream that errors BEFORE any
     *     chunk yields `200 OK` with a cleanly terminated EMPTY chunked body, so
     *     a failed download would look like a successful zero-byte file. Bun also
     *     computes its own Content-Length and ignores the one set here, so there
     *     is no header-level length contract to fall back on.
     *
     * So the first byte is committed before the response exists: this method does
     * not resolve until the download has produced its first chunk, or has
     * finished (an empty file), or has failed. A failure before that point
     * becomes a real HTTP error status; a failure after it resets the connection.
     * Either way the client cannot mistake it for success.
     */
    private async readWhole(
        path: string,
        node: NodeEntity,
        totalSize: number,
        signal?: AbortSignal,
    ): Promise<ReadResult> {
        const rev = node.activeRevision!;
        const expectedSha1 = rev.claimedDigests?.sha1?.toLowerCase();
        const enforceSha1 = !!expectedSha1 && !!rev.claimedDigests?.sha1Verified;
        const hash = createHash('sha1');
        let produced = 0;

        const abort = new AbortController();
        let readableController!: ReadableStreamDefaultController<Uint8Array>;
        let resumeProducer: (() => void) | null = null;
        const wakeProducer = () => {
            const resume = resumeProducer;
            resumeProducer = null;
            resume?.();
        };
        // Waking the parked producer on cancel matters: without it a consumer that
        // goes away mid-stream leaves the producer blocked on backpressure, and the
        // SDK's download-queue slot is held until the whole revision has been
        // fetched. Five of those and every later download blocks.
        const release = () => {
            abort.abort();
            wakeProducer();
        };
        linkAbort(signal, { abort: release } as AbortController);

        // Resolves once the transfer is demonstrably underway (or legitimately
        // finished); rejects if it fails before that.
        let committed = false;
        let commitResolve!: () => void;
        let commitReject!: (error: unknown) => void;
        const commit = new Promise<void>((resolve, reject) => {
            commitResolve = () => {
                if (!committed) {
                    committed = true;
                    resolve();
                }
            };
            commitReject = (error: unknown) => {
                if (!committed) {
                    committed = true;
                    reject(error);
                }
            };
        });

        const readable = new ReadableStream<Uint8Array>(
            {
                start: (controller) => {
                    readableController = controller;
                },
                pull: () => {
                    wakeProducer();
                },
                cancel: () => {
                    release();
                },
            },
            { highWaterMark: 8 * 1024 * 1024, size: (chunk?: Uint8Array) => chunk?.byteLength ?? 0 },
        );

        const writable = new WritableStream<Uint8Array>({
            write: async (chunk) => {
                hash.update(chunk);
                produced += chunk.byteLength;
                readableController.enqueue(chunk);
                // Commit before parking, so awaiting the first byte can never
                // deadlock against backpressure.
                commitResolve();
                if ((readableController.desiredSize ?? 1) <= 0) {
                    await new Promise<void>((resolve) => {
                        resumeProducer = resolve;
                    });
                }
            },
        });

        const downloader = await this.sdk.getFileDownloader(node, abort.signal);
        const controller = downloader.downloadToStream(writable);
        void controller
            .completion()
            .then(() => {
                const actual = hash.digest('hex');
                if (produced !== totalSize) {
                    const error = new IntegrityFailedError(
                        `${path}: size mismatch, got ${produced}, expected ${totalSize}`,
                    );
                    commitReject(error);
                    readableController.error(error);
                    return;
                }
                if (expectedSha1 && actual !== expectedSha1) {
                    if (enforceSha1) {
                        const error = new IntegrityFailedError(
                            `${path}: SHA-1 mismatch against verified claimed digest`,
                        );
                        commitReject(error);
                        readableController.error(error);
                        return;
                    }
                    // Proton marks this digest unverified, so a mismatch is not
                    // proof of corruption and the official CLI tolerates it too.
                    // Never swallow it silently; rclone also compares its own
                    // computed hash against the same digest after the transfer.
                    this.logger.warn(
                        `${path}: downloaded content does not match the unverified claimed SHA-1 ` +
                            `(claimed ${expectedSha1}, got ${actual})`,
                    );
                }
                // An empty file produces no chunks, so this is also the commit
                // point for a legitimately zero-byte read.
                commitResolve();
                readableController.close();
            })
            .catch((error: unknown) => {
                const mapped = mapGenericError(error);
                commitReject(mapped);
                // Erroring the body truncates the response, so a client that has
                // already started receiving sees a failed transfer.
                readableController.error(mapped);
            });

        await commit;
        return { stream: readable, size: totalSize, totalSize };
    }

    /**
     * Ranged read via the SDK's seekable stream.
     *
     * The seekable stream holds a slot in the SDK's download queue
     * (MAX_CONCURRENT_DOWNLOADS = 5) and, unlike downloadToStream, has no
     * terminal hook that frees it -- the only release paths are an abort on the
     * signal it was created with, or stream cancellation. Without the explicit
     * abort below, five ranged reads exhaust the queue and every later download
     * blocks forever, which `rclone mount` would hit within seconds.
     *
     * As with readWhole, the first chunk is fetched before the response exists so
     * that an early failure is an HTTP error rather than a clean empty body.
     */
    private async readRange(
        path: string,
        node: NodeEntity,
        range: { start: number; end: number },
        totalSize: number,
        signal?: AbortSignal,
    ): Promise<ReadResult> {
        const start = range.start;
        const end = Math.min(range.end, Math.max(totalSize - 1, 0));
        const wanted = totalSize === 0 ? 0 : Math.max(0, end - start + 1);

        const abort = new AbortController();
        linkAbort(signal, abort);
        const downloader = await this.sdk.getFileDownloader(node, abort.signal);
        let seekable;
        try {
            seekable = downloader.getSeekableStream();
        } catch {
            // Revisions uploaded by older clients carry no claimed block sizes, so
            // the SDK cannot seek and getSeekableStream throws.
            //
            // Releasing the download slot here is not as simple as aborting: the
            // SDK registers its abort listener INSIDE getSeekableStream, after the
            // block-sizes check that just threw, so nothing is listening and the
            // slot this downloader holds would be held forever. Five legacy-file
            // ranged reads would then block every later download. The only other
            // release hook is downloadToStream's own finally, so drive that with an
            // already-aborted signal and a sink that cannot accept data: the SDK
            // fails fast and runs its cleanup.
            abort.abort();
            await forceReleaseDownloadSlot(downloader);
            this.logger.info(`${path}: seeking unsupported for this revision, falling back to a full read`);
            return this.readRangeByFullRead(path, node, start, wanted, totalSize, signal);
        }

        let released = false;
        const release = () => {
            if (!released) {
                released = true;
                abort.abort();
            }
        };

        if (wanted === 0) {
            release();
            return { stream: new Response(new Uint8Array()).body!, size: 0, totalSize };
        }

        // Fetch the first chunk up front: a failure here becomes a proper error
        // status instead of a cleanly terminated empty 200.
        let remaining = wanted;
        let pending: Uint8Array | null = null;
        try {
            await seekable.seek(start);
            const { value } = await seekable.read(Math.min(SEEK_READ_CHUNK, remaining));
            if (!value || value.byteLength === 0) {
                throw new IntegrityFailedError(`${path}: no data at offset ${start}`);
            }
            pending = value.byteLength > remaining ? value.subarray(0, remaining) : value;
            remaining -= pending.byteLength;
        } catch (error: unknown) {
            release();
            throw mapGenericError(error);
        }

        const stream = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                try {
                    if (pending) {
                        const chunk = pending;
                        pending = null;
                        controller.enqueue(chunk);
                        if (remaining <= 0) {
                            release();
                            controller.close();
                        }
                        return;
                    }
                    const { value, done } = await seekable.read(Math.min(SEEK_READ_CHUNK, remaining));
                    if (value && value.byteLength > 0) {
                        const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
                        remaining -= slice.byteLength;
                        controller.enqueue(slice);
                    }
                    if (remaining <= 0) {
                        release();
                        controller.close();
                        return;
                    }
                    if (done) {
                        release();
                        controller.error(new IntegrityFailedError(`${path}: short read, ${remaining} bytes missing`));
                    }
                } catch (error: unknown) {
                    release();
                    controller.error(mapGenericError(error));
                }
            },
            cancel: () => {
                release();
            },
        });
        return { stream, size: wanted, totalSize };
    }

    /** Serve a byte range by reading the whole revision and discarding the rest. */
    private async readRangeByFullRead(
        path: string,
        node: NodeEntity,
        start: number,
        wanted: number,
        totalSize: number,
        signal?: AbortSignal,
    ): Promise<ReadResult> {
        const whole = await this.readWhole(path, node, totalSize, signal);
        const reader = whole.stream.getReader();
        let skipped = 0;
        let remaining = wanted;
        const stream = new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                while (remaining > 0) {
                    const { value, done } = await reader.read();
                    if (done || value === undefined) {
                        controller.error(new IntegrityFailedError(`${path}: short read while serving a range`));
                        return;
                    }
                    let chunk: Uint8Array = value;
                    if (skipped < start) {
                        const drop = Math.min(start - skipped, chunk.byteLength);
                        skipped += drop;
                        chunk = chunk.subarray(drop);
                        if (chunk.byteLength === 0) {
                            continue;
                        }
                    }
                    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
                    remaining -= slice.byteLength;
                    controller.enqueue(slice);
                    if (remaining <= 0) {
                        void reader.cancel().catch(() => {});
                        controller.close();
                    }
                    return;
                }
                void reader.cancel().catch(() => {});
                controller.close();
            },
            cancel: () => {
                void reader.cancel().catch(() => {});
            },
        });
        return { stream, size: wanted, totalSize };
    }

    // ---- write -------------------------------------------------------------

    async put(path: string, body: ReadableStream<Uint8Array>, opts: PutOptions): Promise<PutResult> {
        const p = normalize(path);
        // Every early rejection must release the request body, otherwise the
        // connection is left half-read and the client waits on a stream nobody
        // will drain.
        const reject = async (error: GatewayError): Promise<never> => {
            await body.cancel().catch(() => {});
            throw error;
        };
        if (isRoot(p)) {
            return reject(new GatewayError('Cannot PUT to the root collection', 405));
        }
        const name = baseName(p);
        if (!isSafeSegment(name)) {
            return reject(new GatewayError('Invalid file name', 400));
        }
        if (opts.sha1 && !SHA1_RE.test(opts.sha1)) {
            return reject(new GatewayError('Malformed OC-Checksum SHA1', 400));
        }
        const parent = await this.resolve(parentPath(p)).catch(async (error: unknown) => {
            await body.cancel().catch(() => {});
            throw mapGenericError(error);
        });
        if (!parent || parent.type !== NodeType.Folder) {
            await body.cancel().catch(() => {});
            throw new ConflictError(`Parent collection does not exist: ${parentPath(p)}`);
        }
        const existing = await this.resolve(p, true);
        if (existing && existing.type === NodeType.Folder) {
            await body.cancel().catch(() => {});
            throw new GatewayError('A collection exists at this path', 405);
        }

        let revisionOfUid: string | undefined;
        if (existing && existing.type === NodeType.File && existing.activeRevision) {
            const currentSha1 = existing.activeRevision.claimedDigests?.sha1?.toLowerCase();
            const currentSize = existing.activeRevision.claimedSize;
            if (opts.sha1 && currentSha1 === opts.sha1 && (opts.size === undefined || currentSize === opts.size)) {
                if (!existing.activeRevision.claimedDigests?.sha1Verified) {
                    // Requiring a verified digest here would leave legacy files
                    // permanently unable to converge, so the match is accepted --
                    // but never silently.
                    this.logger.warn(
                        `${p}: skipping as identical on the strength of an UNVERIFIED claimed SHA-1`,
                    );
                }
                this.logger.info(`Skipping identical content for ${p}`);
                await body.cancel().catch(() => {});
                return { kind: 'skipped-identical' };
            }
            if (opts.immutable) {
                await body.cancel().catch(() => {});
                throw new ImmutablePreconditionError(
                    opts.sha1
                        ? `Immutable: ${p} exists with different content`
                        : `Immutable: ${p} exists and no OC-Checksum was supplied to prove identity`,
                );
            }
            revisionOfUid = existing.uid;
        }

        const metadata = {
            mediaType: getLocalFileMediaType(this.logger, name),
            expectedSize: opts.size ?? null,
            ...(opts.sha1 ? { expectedSha1: opts.sha1 } : {}),
            ...(opts.mtime ? { modificationTime: opts.mtime } : {}),
            overrideExistingDraftByOtherClient: opts.overrideOtherClientDraftForPath === p,
        };
        if (metadata.overrideExistingDraftByOtherClient) {
            this.logger.warn(`Explicit consent active: another client's unfinished draft at ${p} may be replaced`);
        }

        try {
            // The signal matters more than it looks: the SDK takes a concurrency
            // permit inside these calls and waiting for one has no timeout, so
            // without it a disconnected client can hold a permit for a whole
            // transfer and a queued request can wait forever.
            const uploader = revisionOfUid
                ? await this.sdk.getFileRevisionUploader(revisionOfUid, metadata, opts.signal)
                : await this.sdk.getFileUploader(parent, name, metadata, opts.signal);
            const controller = await uploader.uploadFromStream(body, []);
            await controller.completion();
            this.invalidate(p);
            return revisionOfUid ? { kind: 'updated' } : { kind: 'created' };
        } catch (error: unknown) {
            this.invalidate(p);
            throw mapUploadError(error, p);
        }
    }

    async mkcol(path: string): Promise<void> {
        const p = normalize(path);
        if (isRoot(p)) {
            throw new AlreadyExistsError();
        }
        const name = baseName(p);
        if (!isSafeSegment(name)) {
            throw new GatewayError('Invalid collection name', 400);
        }
        const parent = await this.resolve(parentPath(p));
        if (!parent || parent.type !== NodeType.Folder) {
            throw new ConflictError(`Parent collection does not exist: ${parentPath(p)}`);
        }
        const existing = await this.resolve(p, true);
        if (existing) {
            throw new AlreadyExistsError(`Already exists: ${p}`);
        }
        try {
            const created = await this.sdk.createFolder(parent, name);
            this.resolveCache.set(p, { uid: created.uid, expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS });
        } catch (error: unknown) {
            if (error instanceof NodeWithSameNameExistsValidationError) {
                throw new AlreadyExistsError(`Already exists: ${p}`);
            }
            throw mapGenericError(error);
        }
    }

    async remove(path: string): Promise<void> {
        const p = normalize(path);
        if (isRoot(p)) {
            throw new GatewayError('Refusing to remove the root collection', 403);
        }
        // Drafts are invisible here (resolve() hides them), so DELETE never
        // becomes a draft-recovery mechanism.
        const node = await this.resolveOrThrow(p);
        for await (const result of this.sdk.trashNodes([node])) {
            if (!result.ok) {
                throw mapGenericError(result.error);
            }
        }
        this.invalidate(p);
    }

    async move(src: string, dst: string): Promise<void> {
        const s = normalize(src);
        const d = normalize(dst);
        if (isRoot(s) || isRoot(d)) {
            throw new GatewayError('Cannot move the root collection', 403);
        }
        if (d === s || d.startsWith(s + '/')) {
            throw new GatewayError('Cannot move a collection into itself', 409);
        }
        const node = await this.resolveOrThrow(s);
        const dstParent = await this.resolve(parentPath(d));
        if (!dstParent || dstParent.type !== NodeType.Folder) {
            throw new ConflictError(`Destination parent does not exist: ${parentPath(d)}`);
        }
        const dstName = baseName(d);
        if (!isSafeSegment(dstName)) {
            throw new GatewayError('Invalid destination name', 400);
        }
        if (await this.resolve(d, true)) {
            // Overwrite-on-move is never done implicitly: it would trash a
            // committed file as a side effect. Callers must remove first.
            throw new ImmutablePreconditionError(`Destination exists: ${d}`);
        }
        try {
            const sameParent = parentPath(s) === parentPath(d);
            if (!sameParent) {
                for await (const result of this.sdk.moveNodes([node], dstParent)) {
                    if (!result.ok) {
                        throw result.error;
                    }
                }
            }
            if (baseName(s) !== dstName) {
                try {
                    await this.sdk.renameNode(node, dstName);
                } catch (error: unknown) {
                    // MOVE is two SDK calls and Proton offers no transaction. If
                    // the relocation succeeded but the rename did not, say where
                    // the file actually is instead of implying it never moved.
                    const landed = join(parentPath(d), baseName(s));
                    this.logger.error(`${s}: moved to ${landed} but could not be renamed to ${dstName}`, error);
                    throw new GatewayError(
                        `Partially completed move: the file is now at ${landed}, not ${d}. Rename it or move it back.`,
                        500,
                    );
                }
            }
        } catch (error: unknown) {
            throw mapGenericError(error);
        } finally {
            this.invalidate(s);
            this.invalidate(d);
        }
    }

    async copy(src: string, dst: string): Promise<void> {
        const s = normalize(src);
        const d = normalize(dst);
        const node = await this.resolveOrThrow(s);
        if (node.type !== NodeType.File) {
            // rclone falls back to per-file copies when server-side COPY of a
            // collection is unsupported.
            throw new GatewayError('Server-side copy of collections is not supported', 501);
        }
        const dstParent = await this.resolve(parentPath(d));
        if (!dstParent || dstParent.type !== NodeType.Folder) {
            throw new ConflictError(`Destination parent does not exist: ${parentPath(d)}`);
        }
        const dstName = baseName(d);
        if (!isSafeSegment(dstName)) {
            throw new GatewayError('Invalid destination name', 400);
        }
        if (await this.resolve(d, true)) {
            throw new ImmutablePreconditionError(`Destination exists: ${d}`);
        }
        try {
            for await (const result of this.sdk.copyNodes([{ uid: node.uid, name: dstName }], dstParent)) {
                if (!result.ok) {
                    throw result.error;
                }
            }
        } catch (error: unknown) {
            throw mapGenericError(error);
        } finally {
            this.invalidate(d);
        }
    }

    async quota(): Promise<{ used?: number; available?: number }> {
        try {
            const resp = await this.session.apiClient.authenticatedRequest
                .get(`${this.session.apiClient.baseUrlWithProtocol}/core/v4/users`)
                .json<{ User?: { UsedSpace?: number; MaxSpace?: number } }>();
            const used = resp.User?.UsedSpace;
            const max = resp.User?.MaxSpace;
            return {
                used: typeof used === 'number' ? used : undefined,
                available: typeof used === 'number' && typeof max === 'number' ? Math.max(0, max - used) : undefined,
            };
        } catch (error: unknown) {
            this.logger.warn(`Quota lookup failed: ${error instanceof Error ? error.message : String(error)}`);
            return {};
        }
    }

    async close(): Promise<void> {
        await this.session.dispose();
    }
}

/**
 * Make a downloader run its own cleanup so the SDK releases the download-queue
 * slot it took. Used only when getSeekableStream() threw before the SDK had
 * registered any release hook.
 */
async function forceReleaseDownloadSlot(downloader: { downloadToStream: (s: WritableStream) => { completion: () => Promise<void> } }): Promise<void> {
    try {
        const refuse = new WritableStream<Uint8Array>({
            write() {
                throw new Error('slot release: sink intentionally refuses data');
            },
        });
        await downloader.downloadToStream(refuse).completion();
    } catch {
        // Expected: the point is the SDK's finally, not the outcome.
    }
}

/** Mirror an incoming signal onto an internal controller, without leaking a listener. */
function linkAbort(source: AbortSignal | undefined, target: AbortController): void {
    if (!source) {
        return;
    }
    if (source.aborted) {
        target.abort();
        return;
    }
    source.addEventListener('abort', () => target.abort(), { once: true });
}

function mapUploadError(error: unknown, path: string): GatewayError {
    if (error instanceof GatewayError) {
        return error;
    }
    if (error instanceof NodeWithSameNameExistsValidationError) {
        if (error.isUnfinishedUpload) {
            return new DraftConflictError(
                `${path}: an unfinished upload by another client exists. Replacing it requires explicit consent (PROTON_WEBDAV_OVERRIDE_DRAFT_PATH=${path}).`,
            );
        }
        return new GatewayError(`${path}: a file with this name was created concurrently`, 412);
    }
    if (error instanceof IntegrityError) {
        return new IntegrityFailedError(`${path}: ${error.message}`);
    }
    return mapGenericError(error);
}

function mapGenericError(error: unknown): GatewayError {
    if (error instanceof GatewayError) {
        return error;
    }
    if (error instanceof AbortError) {
        return new GatewayError('Operation aborted', 499);
    }
    if (error instanceof RateLimitedError) {
        return new GatewayError('Rate limited by Proton; retry later', 429);
    }
    if (error instanceof ConnectionError) {
        return new GatewayError('Proton is unreachable', 503);
    }
    if (error instanceof ServerError) {
        return new GatewayError(`Proton API error: ${error.message}`, 502);
    }
    if (error instanceof ValidationError) {
        return new GatewayError(error.message, 422);
    }
    const message = error instanceof Error ? error.message : String(error);
    return new GatewayError(`Internal error: ${message}`, 500);
}
