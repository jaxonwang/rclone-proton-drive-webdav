/**
 * In-memory DriveGateway used to exercise the WebDAV layer end-to-end with a
 * real rclone client, without any Proton credentials or network.
 *
 * Models the Proton behaviours the WebDAV layer must handle:
 *  - committed files with SHA-1 + mtime, folders
 *  - unfinished drafts (invisible to stat/list, block same-name uploads)
 *    tagged with the client UID that created them, with the SDK's rules:
 *    own draft -> auto-replaced; other client's draft -> refused unless an
 *    explicit path-scoped override is present
 *  - immutable / identical-skip / new-revision semantics
 *  - fault injection: transient failures (503-mapped), connection drops
 *    mid-transfer, and SHA-1 corruption, all controllable at runtime
 */
import { createHash } from 'node:crypto';

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
import { baseName, isRoot, isSafeSegment, normalize, parentPath, segments } from './paths';

type MockFile = { kind: 'file'; data: Uint8Array; sha1: string; mtime: Date; revisions: number };
type MockDir = { kind: 'dir'; mtime: Date; children: Map<string, MockNode> };
type MockDraft = { kind: 'draft'; clientUid: string; receivedBytes: number };
type MockNode = MockFile | MockDir | MockDraft;

export interface Faults {
    /** Next N gateway operations throw a 503-mapped transient error. */
    transientFailures: number;
    /**
     * Restrict `transientFailures` to one operation name (e.g. 'put'). Without
     * this, a fault aimed at an upload is consumed by the preceding stat/list,
     * so an upload-retry test silently exercises nothing.
     */
    transientFailuresFor?: string;
    /** Abort the connection after this many bytes of the next PUT body (leaves a draft). */
    dropPutAfterBytes?: number;
    /** Abort the next GET stream after this many bytes. */
    dropGetAfterBytes?: number;
    /** Report a wrong SHA-1 for this path in listings (checksum mismatch scenario). */
    corruptSha1ForPath?: string;
    /** Refuse all PUTs with 401-mapped error (simulated revoked session). */
    sessionRevoked: boolean;
}

export class MockGateway implements DriveGateway {
    readonly root: MockDir = { kind: 'dir', mtime: new Date(0), children: new Map() };
    readonly faults: Faults = { transientFailures: 0, sessionRevoked: false };
    /** Log of gateway calls, for assertions. */
    readonly calls: string[] = [];
    usedBytes = 0;

    constructor(readonly clientUid: string = 'sdk-js-cli-mock') {}

    private tick(op: string, path: string): void {
        this.calls.push(`${op} ${path}`);
        const scoped = this.faults.transientFailuresFor;
        if (this.faults.transientFailures > 0 && (scoped === undefined || scoped === op)) {
            this.faults.transientFailures--;
            throw new GatewayError('Simulated transient upstream failure', 503);
        }
    }

    private lookup(path: string, includeDrafts = false): MockNode | null {
        const segs = segments(path);
        let node: MockNode = this.root;
        for (const s of segs) {
            if (node.kind !== 'dir') {
                return null;
            }
            const next = node.children.get(s);
            if (!next) {
                return null;
            }
            node = next;
        }
        if (node.kind === 'draft' && !includeDrafts) {
            return null;
        }
        return node;
    }

    private dirOf(path: string): MockDir {
        const parent = this.lookup(parentPath(path));
        if (!parent || parent.kind !== 'dir') {
            throw new ConflictError(`Parent missing: ${parentPath(path)}`);
        }
        return parent;
    }

    /**
     * The digest the remote REPORTS for a path, which is what a client can see.
     * Used for listings and for the identical-content decision alike: a real
     * server has only one answer to "what is this file's checksum", and the
     * production gateway likewise compares against Proton's claimed digest. An
     * earlier version corrupted only the listing, so an upload was skipped as
     * identical against the true hash while rclone saw a mismatch -- a divergence
     * the real code cannot have.
     */
    private reportedSha1(path: string, node: MockFile): string {
        return this.faults.corruptSha1ForPath === path ? '0'.repeat(40) : node.sha1;
    }

    private toEntry(name: string, node: MockNode, path: string): DriveEntry | null {
        if (node.kind === 'draft') {
            return null;
        }
        if (node.kind === 'dir') {
            return { name, isDir: true, size: 0, mtime: node.mtime };
        }
        return { name, isDir: false, size: node.data.byteLength, mtime: node.mtime, sha1: this.reportedSha1(path, node) };
    }

    async stat(path: string): Promise<DriveEntry | null> {
        const p = normalize(path);
        this.tick('stat', p);
        const node = this.lookup(p);
        if (!node) {
            return null;
        }
        return this.toEntry(baseName(p), node, p);
    }

    async list(path: string): Promise<DriveEntry[]> {
        const p = normalize(path);
        this.tick('list', p);
        const node = this.lookup(p);
        if (!node || node.kind !== 'dir') {
            throw new NotFoundError();
        }
        const out: DriveEntry[] = [];
        for (const [name, child] of node.children) {
            const e = this.toEntry(name, child, normalize(p + '/' + name));
            if (e) {
                out.push(e);
            }
        }
        return out;
    }

    async read(path: string, range?: { start: number; end: number }): Promise<ReadResult> {
        const p = normalize(path);
        this.tick('read', p);
        const node = this.lookup(p);
        if (!node || node.kind !== 'file') {
            throw new NotFoundError();
        }
        const total = node.data.byteLength;
        const start = range ? range.start : 0;
        const end = range ? Math.min(range.end, total - 1) : total - 1;
        const slice = node.data.subarray(start, end + 1);
        const drop = this.faults.dropGetAfterBytes;
        this.faults.dropGetAfterBytes = undefined;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                if (drop !== undefined && drop < slice.byteLength) {
                    controller.enqueue(slice.subarray(0, drop));
                    controller.error(new Error('Simulated connection drop during download'));
                    return;
                }
                controller.enqueue(slice);
                controller.close();
            },
        });
        return { stream, size: slice.byteLength, totalSize: total };
    }

    async put(path: string, body: ReadableStream<Uint8Array>, opts: PutOptions): Promise<PutResult> {
        const p = normalize(path);
        this.tick('put', p);
        if (this.faults.sessionRevoked) {
            await body.cancel().catch(() => {});
            throw new GatewayError('Session revoked; login required', 401);
        }
        const name = baseName(p);
        if (isRoot(p) || !isSafeSegment(name)) {
            throw new GatewayError('Invalid name', 400);
        }
        const dir = this.dirOf(p);
        const existing = dir.children.get(name);
        if (existing?.kind === 'dir') {
            await body.cancel().catch(() => {});
            throw new GatewayError('Collection exists at path', 405);
        }

        // Existing committed file: identical -> skip, immutable -> refuse, else revision.
        let isRevision = false;
        if (existing?.kind === 'file') {
            if (
                opts.sha1 &&
                this.reportedSha1(p, existing) === opts.sha1 &&
                (opts.size === undefined || opts.size === existing.data.byteLength)
            ) {
                await body.cancel().catch(() => {});
                return { kind: 'skipped-identical' };
            }
            if (opts.immutable) {
                await body.cancel().catch(() => {});
                throw new ImmutablePreconditionError();
            }
            isRevision = true;
        }

        // Existing draft: SDK semantics.
        if (existing?.kind === 'draft') {
            const own = existing.clientUid === this.clientUid;
            const override = opts.overrideOtherClientDraftForPath === p;
            if (!own && !override) {
                await body.cancel().catch(() => {});
                throw new DraftConflictError();
            }
            dir.children.delete(name); // narrowly scoped: only this draft
        }

        // Create a draft while receiving; commit on completion.
        const draft: MockDraft = { kind: 'draft', clientUid: this.clientUid, receivedBytes: 0 };
        if (!isRevision) {
            dir.children.set(name, draft);
        }
        const chunks: Uint8Array[] = [];
        const hash = createHash('sha1');
        const drop = this.faults.dropPutAfterBytes;
        this.faults.dropPutAfterBytes = undefined;
        const reader = body.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                chunks.push(value);
                hash.update(value);
                draft.receivedBytes += value.byteLength;
                if (drop !== undefined && draft.receivedBytes >= drop) {
                    throw new GatewayError('Simulated connection drop during upload', 599);
                }
            }
        } catch (err) {
            // Draft stays behind (as on Proton) for later recovery.
            await reader.cancel().catch(() => {});
            throw err;
        }
        const data = concat(chunks);
        const sha1 = hash.digest('hex');
        if (opts.size !== undefined && opts.size !== data.byteLength) {
            throw new IntegrityFailedError(`Size mismatch: expected ${opts.size}, got ${data.byteLength}`);
        }
        if (opts.sha1 && opts.sha1 !== sha1) {
            // Proton SDK: IntegrityError before commit; draft is deleted by the SDK.
            if (dir.children.get(name) === draft) {
                dir.children.delete(name);
            }
            throw new IntegrityFailedError(`SHA-1 mismatch: expected ${opts.sha1}, got ${sha1}`);
        }
        const mtime = opts.mtime ?? new Date();
        const prev = existing?.kind === 'file' ? existing : undefined;
        dir.children.set(name, {
            kind: 'file',
            data,
            sha1,
            mtime,
            revisions: (prev?.revisions ?? 0) + 1,
        });
        this.usedBytes += data.byteLength;
        return isRevision ? { kind: 'updated' } : { kind: 'created' };
    }

    async mkcol(path: string): Promise<void> {
        const p = normalize(path);
        this.tick('mkcol', p);
        if (isRoot(p)) {
            throw new AlreadyExistsError();
        }
        const dir = this.dirOf(p);
        const name = baseName(p);
        if (dir.children.has(name)) {
            throw new AlreadyExistsError();
        }
        dir.children.set(name, { kind: 'dir', mtime: new Date(), children: new Map() });
    }

    async remove(path: string): Promise<void> {
        const p = normalize(path);
        this.tick('remove', p);
        if (isRoot(p)) {
            throw new GatewayError('Refusing to remove root', 403);
        }
        const dir = this.dirOf(p);
        const name = baseName(p);
        const node = dir.children.get(name);
        if (!node || node.kind === 'draft') {
            throw new NotFoundError();
        }
        dir.children.delete(name);
    }

    async move(src: string, dst: string): Promise<void> {
        const s = normalize(src);
        const d = normalize(dst);
        this.tick('move', `${s} -> ${d}`);
        const node = this.lookup(s);
        if (!node) {
            throw new NotFoundError();
        }
        const dstDir = this.dirOf(d);
        if (dstDir.children.has(baseName(d))) {
            throw new ImmutablePreconditionError(`Destination exists: ${d}`);
        }
        this.dirOf(s).children.delete(baseName(s));
        dstDir.children.set(baseName(d), node);
    }

    async copy(src: string, dst: string): Promise<void> {
        const s = normalize(src);
        const d = normalize(dst);
        this.tick('copy', `${s} -> ${d}`);
        const node = this.lookup(s);
        if (!node) {
            throw new NotFoundError();
        }
        if (node.kind !== 'file') {
            throw new GatewayError('Collection copy unsupported', 501);
        }
        const dstDir = this.dirOf(d);
        if (dstDir.children.has(baseName(d))) {
            throw new ImmutablePreconditionError(`Destination exists: ${d}`);
        }
        dstDir.children.set(baseName(d), { ...node, data: node.data.slice() });
    }

    async quota(): Promise<{ used?: number; available?: number }> {
        return { used: this.usedBytes, available: 10 * 1024 * 1024 * 1024 };
    }

    // ---- test helpers -----------------------------------------------------

    /** Seed a committed file. */
    seedFile(path: string, data: Uint8Array | string, mtime = new Date('2024-01-02T03:04:05Z')): void {
        const p = normalize(path);
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        this.ensureDirs(parentPath(p));
        this.dirOf(p).children.set(baseName(p), {
            kind: 'file',
            data: bytes,
            sha1: createHash('sha1').update(bytes).digest('hex'),
            mtime,
            revisions: 1,
        });
    }

    /** Seed an unfinished draft left by `clientUid`. */
    seedDraft(path: string, clientUid: string): void {
        const p = normalize(path);
        this.ensureDirs(parentPath(p));
        this.dirOf(p).children.set(baseName(p), { kind: 'draft', clientUid, receivedBytes: 0 });
    }

    ensureDirs(path: string): void {
        let node: MockDir = this.root;
        for (const s of segments(path)) {
            let next = node.children.get(s);
            if (!next) {
                next = { kind: 'dir', mtime: new Date(), children: new Map() };
                node.children.set(s, next);
            }
            if (next.kind !== 'dir') {
                throw new Error(`Not a dir: ${s}`);
            }
            node = next;
        }
    }

    /** Snapshot for assertions: path -> {sha1,size,revisions} or 'dir'/'draft:<uid>'. */
    snapshot(): Record<string, string> {
        const out: Record<string, string> = {};
        const walk = (dir: MockDir, prefix: string) => {
            for (const [name, node] of dir.children) {
                const p = normalize(prefix + '/' + name);
                if (node.kind === 'dir') {
                    out[p] = 'dir';
                    walk(node, p);
                } else if (node.kind === 'file') {
                    out[p] = `file sha1=${node.sha1} size=${node.data.byteLength} rev=${node.revisions}`;
                } else {
                    out[p] = `draft client=${node.clientUid} bytes=${node.receivedBytes}`;
                }
            }
        };
        walk(this.root, '');
        return out;
    }
}

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}
