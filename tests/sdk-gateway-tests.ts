/**
 * Direct tests for SdkGateway — the component that actually talks to Proton.
 *
 *   bun run tests/sdk-gateway-tests.ts
 *
 * ProtonDriveClient is replaced by an in-memory double that mirrors the real
 * SDK's observable contract (drafts are nodes without an activeRevision,
 * conflicts raise NodeWithSameNameExistsValidationError with isUnfinishedUpload,
 * uploads only count once completion() resolves, trashNodes yields per-node
 * results). That lets the gateway's own logic be verified — path resolution,
 * draft visibility, immutability, consent scoping, trash-not-delete, error
 * mapping, ranged reads — with no Proton account and no network.
 */
import {
    AbortError,
    ConnectionError,
    IntegrityError,
    NodeType,
    NodeWithSameNameExistsValidationError,
    RateLimitedError,
    ServerError,
    ValidationError,
} from '@protontech/drive-sdk';

import { GatewayError } from '../src/service/gateway';
import { SdkGateway } from '../src/service/sdkGateway';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
    if (cond) {
        console.log(`PASS: ${name}`);
        pass++;
    } else {
        console.log(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
        fail++;
    }
}
async function status(name: string, fn: () => Promise<unknown>, expected: number): Promise<void> {
    try {
        await fn();
        check(name, false, `expected HTTP ${expected}, call succeeded`);
    } catch (e) {
        const got = e instanceof GatewayError ? e.httpStatus : undefined;
        check(name, got === expected, `expected ${expected}, got ${got} (${e instanceof Error ? e.message : String(e)})`);
    }
}

const enc = new TextEncoder();
const sha1 = (b: Uint8Array) => require('node:crypto').createHash('sha1').update(b).digest('hex');

// --------------------------------------------------------------------------
// In-memory Proton double
// --------------------------------------------------------------------------
interface FakeNode {
    uid: string;
    name: string;
    nameOk: boolean;
    type: NodeType;
    parentUid?: string;
    content?: Uint8Array;
    /** undefined => draft (unfinished upload), invisible as committed content */
    revision?: { sha1?: string; sha1Verified: boolean; size: number; mtime: Date };
    /** which client left this draft */
    draftClientUid?: string;
    revisions: number;
    mtime: Date;
}

class FakeDrive {
    nodes = new Map<string, FakeNode>();
    calls: string[] = [];
    /** set to throw from the next upload's completion() */
    failNextCompletionWith?: unknown;
    /** set to throw from the next getFileUploader call */
    failNextUploaderWith?: unknown;
    /**
     * Make deleting an OWN draft fail, the way a transient API error does.
     * The real SDK then sets deleteFailed, skips its retry, and throws
     * NodeWithSameNameExistsValidationError with isUnfinishedUpload=true, which
     * is indistinguishable from another client's draft at the type level.
     */
    failDeleteDraftOnce = false;
    lastUploadMetadata?: Record<string, unknown>;
    lastUploadSignal?: AbortSignal;
    /** set to throw from the next download BEFORE any byte, leaving the writer locked as the SDK does */
    failNextDownloadWith?: unknown;
    /** set to fail the next download AFTER this many bytes have been written */
    failDownloadAfterBytes?: number;
    /** revisions (by name) that have no claimedBlockSizes, so seeking is impossible */
    readonly noBlockSizesFor = new Set<string>();
    /** how many SDK download-queue slots are currently held (real limit is 5) */
    openDownloadSlots = 0;
    private seq = 0;

    constructor(readonly clientUid = 'sdk-js-cli-test') {
        this.nodes.set('root', {
            uid: 'root',
            name: 'my-files',
            nameOk: true,
            type: NodeType.Folder,
            revisions: 0,
            mtime: new Date('2024-01-01T00:00:00Z'),
        });
    }

    newUid(): string {
        this.seq += 1;
        return `uid-${this.seq}`;
    }

    addFolder(name: string, parentUid = 'root'): FakeNode {
        const n: FakeNode = { uid: this.newUid(), name, nameOk: true, type: NodeType.Folder, parentUid, revisions: 0, mtime: new Date('2024-02-02T00:00:00Z') };
        this.nodes.set(n.uid, n);
        return n;
    }

    addFile(name: string, content: string | Uint8Array, opts: { parentUid?: string; sha1Verified?: boolean; withDigest?: boolean; mtime?: Date; nameOk?: boolean } = {}): FakeNode {
        const bytes = typeof content === 'string' ? enc.encode(content) : content;
        const n: FakeNode = {
            uid: this.newUid(),
            name,
            nameOk: opts.nameOk !== false,
            type: NodeType.File,
            parentUid: opts.parentUid ?? 'root',
            content: bytes,
            revision: {
                ...(opts.withDigest === false ? {} : { sha1: sha1(bytes) }),
                sha1Verified: opts.sha1Verified ?? true,
                size: bytes.byteLength,
                mtime: opts.mtime ?? new Date('2024-03-03T03:03:03Z'),
            },
            revisions: 1,
            mtime: opts.mtime ?? new Date('2024-03-03T03:03:03Z'),
        };
        this.nodes.set(n.uid, n);
        return n;
    }

    /** A draft: exists, blocks the name, but has no committed revision. */
    addDraft(name: string, draftClientUid: string, parentUid = 'root'): FakeNode {
        const n: FakeNode = { uid: this.newUid(), name, nameOk: true, type: NodeType.File, parentUid, revisions: 0, mtime: new Date(), draftClientUid };
        this.nodes.set(n.uid, n);
        return n;
    }

    children(parentUid: string): FakeNode[] {
        return [...this.nodes.values()].filter((n) => n.parentUid === parentUid);
    }

    /** Extra per-node fields merged into the entity, for cases like trashTime. */
    readonly entityOverrides = new Map<string, Record<string, unknown>>();

    /** Convert to the NodeEntity shape the gateway consumes. */
    entity(n: FakeNode): Record<string, unknown> {
        return { ...this.baseEntity(n), ...(this.entityOverrides.get(n.uid) ?? {}) };
    }

    private baseEntity(n: FakeNode): Record<string, unknown> {
        return {
            uid: n.uid,
            parentUid: n.parentUid,
            name: n.nameOk ? { ok: true, value: n.name } : { ok: false, error: { name: n.name, error: 'undecryptable' } },
            type: n.type,
            modificationTime: n.mtime,
            creationTime: n.mtime,
            isShared: false,
            isSharedByUrl: false,
            directRole: 'inherited',
            keyAuthor: { ok: true, value: 'test@example.com' },
            nameAuthor: { ok: true, value: 'test@example.com' },
            ownedBy: {},
            treeEventScopeId: 'scope',
            ...(n.type === NodeType.Folder ? { folder: { isImported: false } } : {}),
            ...(n.revision
                ? {
                      activeRevision: {
                          uid: `${n.uid}-rev`,
                          state: 'active',
                          creationTime: n.mtime,
                          contentAuthor: { ok: true, value: 'test@example.com' },
                          storageSize: n.revision.size,
                          isImported: false,
                          claimedSize: n.revision.size,
                          claimedModificationTime: n.revision.mtime,
                          ...(n.revision.sha1 ? { claimedDigests: { sha1: n.revision.sha1, sha1Verified: n.revision.sha1Verified } } : {}),
                      },
                  }
                : {}),
        };
    }

    private uidOf(nodeOrUid: unknown): string {
        return typeof nodeOrUid === 'string' ? nodeOrUid : ((nodeOrUid as { uid: string }).uid);
    }

    makeSdk() {
        const drive = this;
        return {
            async getNode(nodeOrUid: unknown) {
                const uid = drive.uidOf(nodeOrUid);
                const n = drive.nodes.get(uid);
                if (!n) {
                    throw new ValidationError(`Node not found: ${uid}`);
                }
                return drive.entity(n);
            },
            async *iterateFolderChildren(parent: unknown) {
                const uid = drive.uidOf(parent);
                drive.calls.push(`iterateFolderChildren ${uid}`);
                for (const child of drive.children(uid)) {
                    yield drive.entity(child);
                }
            },
            async createFolder(parent: unknown, name: string) {
                drive.calls.push(`createFolder ${name}`);
                const parentUid = drive.uidOf(parent);
                if (drive.children(parentUid).some((c) => c.name === name)) {
                    throw new NodeWithSameNameExistsValidationError('exists', 2500, drive.children(parentUid).find((c) => c.name === name)!.uid, false);
                }
                return drive.entity(drive.addFolder(name, parentUid));
            },
            async getFileUploader(parent: unknown, name: string, metadata: Record<string, unknown>, signal?: AbortSignal) {
                drive.calls.push(`getFileUploader ${name}`);
                drive.lastUploadMetadata = metadata;
                drive.lastUploadSignal = signal;
                if (drive.failNextUploaderWith !== undefined) {
                    const e = drive.failNextUploaderWith;
                    drive.failNextUploaderWith = undefined;
                    throw e;
                }
                const parentUid = drive.uidOf(parent);
                const clash = drive.children(parentUid).find((c) => c.name === name);
                if (clash) {
                    const isDraft = !clash.revision;
                    const ownDraft = isDraft && clash.draftClientUid === drive.clientUid;
                    const mayReplace = ownDraft || (isDraft && metadata.overrideExistingDraftByOtherClient === true);
                    if (mayReplace && drive.failDeleteDraftOnce) {
                        // Transient failure deleting our own draft: the SDK does
                        // NOT retry, and reports the same error it uses for a
                        // foreign draft. The draft must survive.
                        drive.failDeleteDraftOnce = false;
                        drive.calls.push(`deleteDraft-FAILED ${clash.uid}`);
                        throw new NodeWithSameNameExistsValidationError('exists', 2500, clash.uid, true);
                    }
                    if (mayReplace) {
                        // The real SDK deletes exactly that draft node and retries.
                        drive.calls.push(`deleteDraft ${clash.uid}`);
                        drive.nodes.delete(clash.uid);
                    } else {
                        throw new NodeWithSameNameExistsValidationError('exists', 2500, clash.uid, isDraft);
                    }
                }
                return drive.makeUploader(parentUid, name, metadata, undefined);
            },
            async getFileRevisionUploader(nodeUid: unknown, metadata: Record<string, unknown>, signal?: AbortSignal) {
                const uid = drive.uidOf(nodeUid);
                drive.calls.push(`getFileRevisionUploader ${uid}`);
                drive.lastUploadMetadata = metadata;
                drive.lastUploadSignal = signal;
                const existing = drive.nodes.get(uid)!;
                return drive.makeUploader(existing.parentUid!, existing.name, metadata, uid);
            },
            async getFileDownloader(nodeOrUid: unknown, signal?: AbortSignal) {
                const n = drive.nodes.get(drive.uidOf(nodeOrUid))!;
                return drive.makeDownloader(n, signal);
            },
            async *trashNodes(nodes: unknown[]) {
                for (const node of nodes) {
                    const uid = drive.uidOf(node);
                    drive.calls.push(`trashNodes ${uid}`);
                    drive.nodes.delete(uid);
                    yield { uid, ok: true };
                }
            },
            async *deleteNodes(nodes: unknown[]) {
                // Must never be used by the gateway: deletion is permanent.
                for (const node of nodes) {
                    drive.calls.push(`deleteNodes ${drive.uidOf(node)}`);
                    yield { uid: drive.uidOf(node), ok: true };
                }
            },
            async *moveNodes(nodes: unknown[], newParent: unknown) {
                const parentUid = drive.uidOf(newParent);
                for (const node of nodes) {
                    const uid = drive.uidOf(node);
                    drive.calls.push(`moveNodes ${uid} -> ${parentUid}`);
                    drive.nodes.get(uid)!.parentUid = parentUid;
                    yield { uid, ok: true };
                }
            },
            async renameNode(nodeOrUid: unknown, newName: string) {
                const uid = drive.uidOf(nodeOrUid);
                drive.calls.push(`renameNode ${uid} -> ${newName}`);
                drive.nodes.get(uid)!.name = newName;
                return drive.entity(drive.nodes.get(uid)!);
            },
            async *copyNodes(items: unknown[], newParent: unknown) {
                const parentUid = drive.uidOf(newParent);
                for (const item of items) {
                    const src = typeof item === 'string' ? item : (item as { uid: string }).uid;
                    const name = typeof item === 'string' ? drive.nodes.get(src)!.name : (item as { name: string }).name;
                    drive.calls.push(`copyNodes ${src} -> ${parentUid}/${name}`);
                    const original = drive.nodes.get(src)!;
                    const copy = drive.addFile(name, original.content!, { parentUid });
                    yield { uid: src, newUid: copy.uid, ok: true };
                }
            },
        };
    }

    private makeUploader(parentUid: string, name: string, metadata: Record<string, unknown>, revisionOf?: string) {
        const drive = this;
        return {
            async uploadFromStream(stream: ReadableStream<Uint8Array>) {
                const reader = stream.getReader();
                const chunks: Uint8Array[] = [];
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        break;
                    }
                    chunks.push(value);
                }
                const total = chunks.reduce((n, c) => n + c.byteLength, 0);
                const data = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) {
                    data.set(c, off);
                    off += c.byteLength;
                }
                return {
                    pause() {},
                    resume() {},
                    async completion() {
                        if (drive.failNextCompletionWith !== undefined) {
                            const e = drive.failNextCompletionWith;
                            drive.failNextCompletionWith = undefined;
                            throw e;
                        }
                        const digest = sha1(data);
                        if (typeof metadata.expectedSha1 === 'string' && metadata.expectedSha1 !== digest) {
                            throw new IntegrityError('sha1 mismatch');
                        }
                        if (typeof metadata.expectedSize === 'number' && metadata.expectedSize !== data.byteLength) {
                            throw new IntegrityError('size mismatch');
                        }
                        if (revisionOf) {
                            const n = drive.nodes.get(revisionOf)!;
                            n.content = data;
                            n.revision = { sha1: digest, sha1Verified: true, size: data.byteLength, mtime: (metadata.modificationTime as Date) ?? new Date() };
                            n.revisions += 1;
                            return { nodeUid: n.uid, nodeRevisionUid: `${n.uid}-rev` };
                        }
                        const created = drive.addFile(name, data, { parentUid, mtime: metadata.modificationTime as Date });
                        return { nodeUid: created.uid, nodeRevisionUid: `${created.uid}-rev` };
                    },
                };
            },
        };
    }

    /**
     * Mirrors the real SDK's download contract precisely, because the details are
     * what the gateway has to cope with (internal/download/fileDownloader.ts):
     *
     *  - downloadToStream NEVER closes the WritableStream. On success it calls
     *    writer.releaseLock(); on failure it leaves the writer LOCKED. Ending the
     *    stream is the caller's job. An earlier version of this double closed the
     *    writer, which hid a bug where full downloads would never terminate.
     *  - a queue slot is taken by getFileDownloader and freed in downloadToStream's
     *    finally -- but the seekable stream has no such terminal hook, so only an
     *    abort on the signal releases it. Five leaked slots block all downloads.
     *  - getSeekableStream throws for revisions with no claimedBlockSizes.
     */
    private makeDownloader(n: FakeNode, signal?: AbortSignal) {
        const content = n.content ?? new Uint8Array();
        const drive = this;
        drive.openDownloadSlots += 1;
        let slotReleased = false;
        const releaseSlot = () => {
            if (!slotReleased) {
                slotReleased = true;
                drive.openDownloadSlots -= 1;
            }
        };
        // NOTE: the real SDK registers an abort listener ONLY inside
        // getSeekableStream. downloadToStream instead releases in its own finally.
        // Registering it here for both would hide a whole-file slot leak, so the
        // listener is attached below, in getSeekableStream only.

        return {
            getClaimedSizeInBytes: () => n.revision?.size,
            downloadToStream(writable: WritableStream) {
                const promise = (async () => {
                    const writer = writable.getWriter();
                    try {
                        if (drive.failNextDownloadWith !== undefined) {
                            const e = drive.failNextDownloadWith;
                            drive.failNextDownloadWith = undefined;
                            throw e; // before any byte; writer intentionally left locked
                        }
                        const failAfter = drive.failDownloadAfterBytes;
                        drive.failDownloadAfterBytes = undefined;
                        if (failAfter !== undefined && failAfter < content.byteLength) {
                            // Write some bytes, then fail: the mid-transfer case.
                            await writer.write(content.subarray(0, failAfter));
                            throw new ServerError('proton dropped the connection mid-transfer');
                        }
                        // Several chunks, so backpressure actually engages.
                        const CHUNK = 64 * 1024;
                        for (let off = 0; off < content.byteLength; off += CHUNK) {
                            await writer.write(content.subarray(off, Math.min(off + CHUNK, content.byteLength)));
                        }
                        writer.releaseLock(); // released, but NOT closed
                    } finally {
                        releaseSlot();
                    }
                })();
                return {
                    pause() {},
                    resume() {},
                    isDownloadCompleteWithSignatureIssues: () => false,
                    completion: () => promise,
                };
            },
            getSeekableStream() {
                if (drive.noBlockSizesFor.has(n.name)) {
                    throw new Error('Revision does not have defined claimed block sizes');
                }
                // Matches the real SDK: the seekable path has no terminal hook, so
                // the abort signal is its only release.
                signal?.addEventListener('abort', releaseSlot, { once: true });
                let pos = 0;
                return {
                    seek(p: number) {
                        pos = p;
                    },
                    async read(n2: number) {
                        const slice = content.subarray(pos, pos + n2);
                        pos += slice.byteLength;
                        return { value: slice, done: pos >= content.byteLength };
                    },
                    async cancel() {
                        releaseSlot();
                    },
                };
            },
        };
    }
}

function makeGateway(drive: FakeDrive, warnings: string[] = []) {
    const sdk = drive.makeSdk();
    const session = {
        sdk,
        logger: {
            debug: () => {},
            info: () => {},
            warn: (m: string) => warnings.push(m),
            error: () => {},
        },
        paths: { getNode: async () => drive.entity(drive.nodes.get('root')!) },
        apiClient: {
            baseUrlWithProtocol: 'http://localhost',
            authenticatedRequest: { get: () => ({ json: async () => ({ User: { UsedSpace: 42, MaxSpace: 100 } }) }) },
        },
        dispose: async () => {},
    };
    return new SdkGateway(session as never, { rootPath: '/my-files' });
}

/** Let queued microtasks and timers run: slot release is asynchronous. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}
function bodyOf(text: string): ReadableStream<Uint8Array> {
    return new Response(text).body!;
}

// ==========================================================================
console.log('-- listing and metadata --');
{
    const drive = new FakeDrive();
    drive.addFile('hello.txt', 'hello proton');
    drive.addFolder('sub');
    drive.addFile('nested.txt', 'nested', { parentUid: [...drive.nodes.values()].find((n) => n.name === 'sub')!.uid });
    const warnings: string[] = [];
    const gw = makeGateway(drive, warnings);

    const root = await gw.stat('/');
    check('root stats as a directory', root?.isDir === true);
    const listed = await gw.list('/');
    check('lists both entries at root', listed.length === 2, JSON.stringify(listed.map((e) => e.name)));
    const file = listed.find((e) => e.name === 'hello.txt')!;
    check('file size comes from claimedSize', file.size === 12, String(file.size));
    check('file mtime comes from claimedModificationTime', file.mtime.toISOString() === '2024-03-03T03:03:03.000Z', file.mtime.toISOString());
    check('file SHA-1 is exposed', file.sha1 === sha1(enc.encode('hello proton')));
    check('nested path resolves through a folder', (await gw.stat('/sub/nested.txt'))?.size === 6);
    check('missing path stats as null', (await gw.stat('/nope.txt')) === null);

    // No digest available => never invent one.
    drive.addFile('nodigest.bin', 'abc', { withDigest: false });
    const nd = await gw.stat('/nodigest.bin');
    check('no SHA-1 is fabricated when Proton has none', nd !== null && nd.sha1 === undefined);

    // Undecryptable name must be skipped, not surfaced as garbage.
    drive.addFile('broken', 'x', { nameOk: false });
    const afterBroken = await gw.list('/');
    check('node with undecryptable name is skipped from listings', !afterBroken.some((e) => e.name === 'broken'));
    check('skipping an undecryptable name is logged', warnings.some((w) => /cannot be decrypted/.test(w)));
}

console.log('\n-- drafts are not committed content --');
{
    const drive = new FakeDrive();
    drive.addDraft('inflight.bin', 'sdk-js-cli-test');
    const gw = makeGateway(drive);
    check('draft is invisible to stat', (await gw.stat('/inflight.bin')) === null);
    check('draft is invisible to list', (await gw.list('/')).length === 0);
    await status('DELETE of a draft path is 404 (never a draft-recovery path)', () => gw.remove('/inflight.bin'), 404);
    check('no trash or delete call was made for the draft', !drive.calls.some((c) => c.startsWith('trashNodes') || c.startsWith('deleteNodes')));
}

console.log('\n-- upload: identical, immutable, revision --');
{
    const drive = new FakeDrive();
    drive.addFile('same.txt', 'same content');
    const gw = makeGateway(drive);
    const digest = sha1(enc.encode('same content'));

    const r1 = await gw.put('/same.txt', bodyOf('same content'), { sha1: digest, size: 12, immutable: true });
    check('identical content is skipped, not re-uploaded', r1.kind === 'skipped-identical', r1.kind);
    check('no uploader was created for an identical file', !drive.calls.some((c) => c.startsWith('getFileUploader')));

    await status('immutable refuses differing content (412)', () => gw.put('/same.txt', bodyOf('different'), { sha1: sha1(enc.encode('different')), size: 9, immutable: true }), 412);
    check('refused overwrite left the original content intact', new TextDecoder().decode(drive.nodes.get([...drive.nodes.values()].find((n) => n.name === 'same.txt')!.uid)!.content!) === 'same content');

    await status('immutable refuses when no checksum proves identity (412)', () => gw.put('/same.txt', bodyOf('same content'), { size: 12, immutable: true }), 412);

    const r2 = await gw.put('/same.txt', bodyOf('brand new'), { sha1: sha1(enc.encode('brand new')), size: 9, immutable: false });
    check('with immutability off a new revision is created', r2.kind === 'updated', r2.kind);
    check('revision upload used getFileRevisionUploader', drive.calls.some((c) => c.startsWith('getFileRevisionUploader')));
    check('previous revision count increased (old revision retained by Proton)', [...drive.nodes.values()].find((n) => n.name === 'same.txt')!.revisions === 2);

    const r3 = await gw.put('/fresh.txt', bodyOf('fresh'), { sha1: sha1(enc.encode('fresh')), size: 5, immutable: true });
    check('new file uploads as created', r3.kind === 'created', r3.kind);
    check('expected size passed to the SDK (integrity check enabled)', drive.lastUploadMetadata?.expectedSize === 5);
    check('expected SHA-1 passed to the SDK', drive.lastUploadMetadata?.expectedSha1 === sha1(enc.encode('fresh')));
}

console.log('\n-- upload: parent, commit confirmation, integrity --');
{
    const drive = new FakeDrive();
    const gw = makeGateway(drive);
    await status('missing parent collection is 409', () => gw.put('/nodir/f.txt', bodyOf('x'), { immutable: true }), 409);

    drive.failNextCompletionWith = new ServerError('proton exploded');
    await status('failure at commit is reported, not success (502)', () => gw.put('/f.txt', bodyOf('x'), { immutable: true }), 502);
    check('nothing was committed when completion() threw', (await gw.stat('/f.txt')) === null);

    await status('size mismatch surfaces as 422', () => gw.put('/g.txt', bodyOf('abc'), { size: 99, immutable: true }), 422);
    await status('SHA-1 mismatch surfaces as 422', () => gw.put('/h.txt', bodyOf('abc'), { sha1: '0'.repeat(40), immutable: true }), 422);
    await status('malformed OC-Checksum is rejected (400)', () => gw.put('/i.txt', bodyOf('abc'), { sha1: 'nothex', immutable: true }), 400);
}

console.log('\n-- drafts: own recovery vs another client, consent scoping --');
{
    const drive = new FakeDrive('sdk-js-cli-test');
    drive.addDraft('mine.bin', 'sdk-js-cli-test');
    drive.addDraft('theirs.bin', 'sdk-js-cli-OTHER');
    drive.addDraft('alsotheirs.bin', 'sdk-js-cli-OTHER');
    const gw = makeGateway(drive);

    const own = await gw.put('/mine.bin', bodyOf('recovered'), { sha1: sha1(enc.encode('recovered')), size: 9, immutable: true });
    check("own draft is recovered automatically", own.kind === 'created', own.kind);
    check('own-draft recovery deleted exactly that draft node', drive.calls.some((c) => c.startsWith('deleteDraft')));
    check('own-draft recovery never used trash or bulk delete', !drive.calls.some((c) => c.startsWith('trashNodes') || c.startsWith('deleteNodes')));

    await status("another client's draft is refused (409)", () => gw.put('/theirs.bin', bodyOf('x'), { sha1: sha1(enc.encode('x')), size: 1, immutable: true }), 409);
    check("another client's draft still present after refusal", drive.nodes.has([...drive.nodes.values()].find((n) => n.name === 'theirs.bin')!.uid));
    check('refusal did not set the SDK override flag', drive.lastUploadMetadata?.overrideExistingDraftByOtherClient === false);

    const consented = await gw.put('/theirs.bin', bodyOf('forced'), {
        sha1: sha1(enc.encode('forced')),
        size: 6,
        immutable: true,
        overrideOtherClientDraftForPath: '/theirs.bin',
    });
    check('explicit path-scoped consent allows replacement', consented.kind === 'created', consented.kind);
    check('consent set the SDK override flag for that upload', drive.lastUploadMetadata?.overrideExistingDraftByOtherClient === true);

    await status('consent for one path does not cover another', () => gw.put('/alsotheirs.bin', bodyOf('y'), { sha1: sha1(enc.encode('y')), size: 1, immutable: true, overrideOtherClientDraftForPath: '/theirs.bin' }), 409);
    check("the unrelated other-client draft survived", [...drive.nodes.values()].some((n) => n.name === 'alsotheirs.bin' && !n.revision));
}

console.log('\n-- a transient failure deleting our OWN draft must not be blamed on another client --');
{
    const drive = new FakeDrive('sdk-js-cli-test');
    drive.addDraft('mine.bin', 'sdk-js-cli-test');
    const gw = makeGateway(drive);
    drive.failDeleteDraftOnce = true;

    let err: any;
    try {
        await gw.put('/mine.bin', bodyOf('recovered'), { sha1: sha1(enc.encode('recovered')), size: 9, immutable: true });
    } catch (e) {
        err = e;
    }
    check('a failed own-draft delete still refuses the upload (409)', err?.httpStatus === 409, String(err?.httpStatus));
    check('our own draft was not destroyed by the failed attempt', [...drive.nodes.values()].some((n) => n.name === 'mine.bin' && !n.revision));
    // The whole point: the operator must not be told to waive a protection for
    // a draft that is actually ours, on the strength of a transient error.
    check('the message does not assert the draft belongs to another client', !/by another client|belongs to another client/i.test(String(err?.message)), String(err?.message));
    check('the message says to retry first', /retry first/i.test(String(err?.message)));
    check('the override is presented as conditional, not as the remedy', /only if it persists/i.test(String(err?.message)));
    check('the override hint is still scoped to the exact path', String(err?.message).includes('PROTON_WEBDAV_OVERRIDE_DRAFT_PATH=/mine.bin'));

    // And the retry it recommends must actually work once the API recovers.
    const retried = await gw.put('/mine.bin', bodyOf('recovered'), { sha1: sha1(enc.encode('recovered')), size: 9, immutable: true });
    check('the recommended retry recovers the own draft', retried.kind === 'created', retried.kind);
    check('recovery used deleteDraft, never trash or bulk delete', drive.calls.some((c) => c.startsWith('deleteDraft ')) && !drive.calls.some((c) => c.startsWith('trashNodes') || c.startsWith('deleteNodes')));
}

console.log('\n-- deletion is trash, never permanent delete --');
{
    const drive = new FakeDrive();
    drive.addFile('bye.txt', 'bye');
    const gw = makeGateway(drive);
    await gw.remove('/bye.txt');
    check('remove() trashes the node', drive.calls.some((c) => c.startsWith('trashNodes')));
    check('remove() never calls deleteNodes', !drive.calls.some((c) => c.startsWith('deleteNodes')));
    await status('refuses to remove the root collection', () => gw.remove('/'), 403);
}

console.log('\n-- move / copy never silently overwrite --');
{
    const drive = new FakeDrive();
    drive.addFile('a.txt', 'aaa');
    drive.addFile('b.txt', 'bbb');
    drive.addFolder('dir');
    const gw = makeGateway(drive);

    await gw.move('/a.txt', '/dir/a.txt');
    check('move relocates into a folder', (await gw.stat('/dir/a.txt'))?.size === 3);
    check('source no longer present after move', (await gw.stat('/a.txt')) === null);

    await status('move onto an existing file is refused (412)', () => gw.move('/b.txt', '/dir/a.txt'), 412);
    check('the destination content was not replaced', new TextDecoder().decode([...drive.nodes.values()].find((n) => n.name === 'a.txt')!.content!) === 'aaa');
    await status('move of a collection into itself is refused', () => gw.move('/dir', '/dir/inner'), 409);

    await gw.copy('/b.txt', '/dir/copy.txt');
    check('copy duplicates a file server-side', (await gw.stat('/dir/copy.txt'))?.size === 3);
    await status('copy onto an existing file is refused (412)', () => gw.copy('/b.txt', '/dir/copy.txt'), 412);
    await status('server-side copy of a collection reports unsupported (501)', () => gw.copy('/dir', '/dir2'), 501);
}

console.log('\n-- mkcol --');
{
    const drive = new FakeDrive();
    const gw = makeGateway(drive);
    await gw.mkcol('/newdir');
    check('mkcol creates a folder', (await gw.stat('/newdir'))?.isDir === true);
    await status('mkcol on an existing name is 405', () => gw.mkcol('/newdir'), 405);
    await status('mkcol with a missing parent is 409', () => gw.mkcol('/missing/deep'), 409);
}

console.log('\n-- reads: full and ranged --');
{
    const drive = new FakeDrive();
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) {
        payload[i] = i % 251;
    }
    drive.addFile('blob.bin', payload);
    drive.addFile('empty.bin', '');
    const gw = makeGateway(drive);

    const full = await gw.read('/blob.bin');
    const got = await drain(full.stream);
    check('full read returns every byte', got.byteLength === 4096 && got[100] === payload[100]);
    check('full read reports the total size', full.totalSize === 4096);

    const ranged = await gw.read('/blob.bin', { start: 1000, end: 1099 });
    const rangedBytes = await drain(ranged.stream);
    check('ranged read returns exactly the requested length', rangedBytes.byteLength === 100, String(rangedBytes.byteLength));
    check('ranged read returns the requested bytes', rangedBytes[0] === payload[1000] && rangedBytes[99] === payload[1099]);
    check('ranged read still reports the full size', ranged.totalSize === 4096);

    const clamped = await gw.read('/blob.bin', { start: 4000, end: 999999 });
    check('range past EOF is clamped to the file end', (await drain(clamped.stream)).byteLength === 96);

    const emptyRead = await gw.read('/empty.bin');
    check('empty file reads as zero bytes', (await drain(emptyRead.stream)).byteLength === 0);
    await status('read of a directory is 404', () => gw.read('/'), 404);

    // The SDK caps concurrent downloads at 5 and the seekable stream has no
    // terminal release hook, so a leak here would deadlock all downloads.
    check('full read releases its download slot', drive.openDownloadSlots === 0, `slots=${drive.openDownloadSlots}`);
    for (let i = 0; i < 8; i++) {
        const r = await gw.read('/blob.bin', { start: i * 10, end: i * 10 + 9 });
        await drain(r.stream);
    }
    check('eight sequential ranged reads leak no download slots', drive.openDownloadSlots === 0, `slots=${drive.openDownloadSlots}`);

    const cancelled = await gw.read('/blob.bin', { start: 0, end: 4095 });
    await cancelled.stream.cancel();
    check('cancelled ranged read releases its slot', drive.openDownloadSlots === 0, `slots=${drive.openDownloadSlots}`);

    // Old revisions cannot be seeked; the range must still be served correctly.
    drive.noBlockSizesFor.add('blob.bin');
    const fallback = await gw.read('/blob.bin', { start: 500, end: 599 });
    const fallbackBytes = await drain(fallback.stream);
    check('ranged read falls back to a full read when seeking is unsupported', fallbackBytes.byteLength === 100, String(fallbackBytes.byteLength));
    check('fallback returns the correct bytes', fallbackBytes[0] === payload[500] && fallbackBytes[99] === payload[599]);
    await settle();
    check('fallback leaks no download slots', drive.openDownloadSlots === 0, `slots=${drive.openDownloadSlots}`);
    drive.noBlockSizesFor.delete('blob.bin');

    // Failure BEFORE the first byte must surface as an error from read() itself.
    // Erroring the body instead would be invisible: the runtime sends a cleanly
    // terminated empty 200, which a client reads as a successful empty file.
    drive.failNextDownloadWith = new ServerError('proton dropped the connection');
    await status('failure before the first byte throws from read(), not via the body', () => gw.read('/blob.bin'), 502);
    await settle();
    check('slot released after a pre-first-byte failure', drive.openDownloadSlots === 0, `slots=${drive.openDownloadSlots}`);

    // Failure AFTER bytes have flowed: read() succeeds, the body errors.
    drive.failDownloadAfterBytes = 1024;
    const partial = await gw.read('/blob.bin');
    let bodyFailed = false;
    await Promise.race([
        drain(partial.stream).then(
            () => {},
            () => {
                bodyFailed = true;
            },
        ),
        new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    check('mid-transfer failure errors the body instead of hanging', bodyFailed);
    await settle();
    check('slot released after a mid-transfer failure', drive.openDownloadSlots === 0, `slots=${drive.openDownloadSlots}`);

    // Cancelling a whole-file read mid-stream must release the slot, which means
    // waking the producer parked on backpressure rather than only aborting.
    const midCancel = await gw.read('/blob.bin');
    const reader = midCancel.stream.getReader();
    await reader.read();
    await reader.cancel();
    await settle();
    check('cancelling a whole-file read mid-stream releases the slot', drive.openDownloadSlots === 0, `slots=${drive.openDownloadSlots}`);
}

console.log('\n-- client disconnect releases SDK capacity --');
{
    // The SDK takes an upload permit before the transfer and waiting for one has
    // no timeout, so a disconnected client must not hold it and a queued request
    // must be cancellable. Assert the signal actually reaches the SDK.
    const drive = new FakeDrive();
    const gw = makeGateway(drive);
    const ac = new AbortController();
    await gw.put('/signalled.txt', bodyOf('hello'), { sha1: sha1(enc.encode('hello')), size: 5, immutable: true, signal: ac.signal });
    check('the request signal is handed to the SDK uploader', drive.lastUploadSignal === ac.signal);

    // A read must release its download slot when the client goes away.
    // Larger than one seek chunk, so the up-front prefetch cannot finish the range
    // and the slot is genuinely still held when the response is handed back.
    const drive2 = new FakeDrive();
    drive2.addFile('big.bin', 'x'.repeat(4 * 1024 * 1024));
    const gw2 = makeGateway(drive2);
    const ac2 = new AbortController();
    const r = await gw2.read('/big.bin', { start: 0, end: 4 * 1024 * 1024 - 1 }, ac2.signal);
    check('ranged read holds a download slot while open', drive2.openDownloadSlots === 1, `slots=${drive2.openDownloadSlots}`);
    ac2.abort();
    await settle();
    check('client disconnect releases the download slot', drive2.openDownloadSlots === 0, `slots=${drive2.openDownloadSlots}`);
    await r.stream.cancel().catch(() => {});
}

console.log('\n-- trashed nodes and unknown sizes are not served --');
{
    const drive = new FakeDrive();
    const trashed = drive.addFile('gone.txt', 'gone');
    // Mark it trashed the way Proton reports it.
    drive.entityOverrides.set(trashed.uid, { trashTime: new Date('2024-06-06T00:00:00Z') });
    const warnings: string[] = [];
    const gw = makeGateway(drive, warnings);
    check('trashed file is invisible to stat', (await gw.stat('/gone.txt')) === null);
    check('trashed file is invisible to list', !(await gw.list('/')).some((e) => e.name === 'gone.txt'));
    await status('trashed file cannot be read', () => gw.read('/gone.txt'), 404);

    const drive2 = new FakeDrive();
    const noSize = drive2.addFile('legacy.bin', 'abcdef');
    drive2.nodes.get(noSize.uid)!.revision!.size = undefined as unknown as number;
    const warnings2: string[] = [];
    const gw2 = makeGateway(drive2, warnings2);
    check('file with no clear-text size is omitted from listings', (await gw2.list('/')).length === 0);
    check('omitting an unsized file is logged', warnings2.some((w) => /no clear-text size/.test(w)));
    await status('reading an unsized file is refused rather than truncated', () => gw2.read('/legacy.bin'), 409);
}

console.log('\n-- download integrity --');
{
    // Verified digest that does not match the bytes => hard failure.
    const drive = new FakeDrive();
    const node = drive.addFile('corrupt.bin', 'real content', { sha1Verified: true });
    drive.nodes.get(node.uid)!.revision!.sha1 = '1'.repeat(40);
    const gw = makeGateway(drive);
    const r = await gw.read('/corrupt.bin');
    let threw = false;
    try {
        await drain(r.stream);
    } catch {
        threw = true;
    }
    check('verified-digest mismatch fails the download', threw);

    // Unverified digest mismatch is tolerated (CLI parity) but must be logged.
    const drive2 = new FakeDrive();
    const n2 = drive2.addFile('soft.bin', 'real content', { sha1Verified: false });
    drive2.nodes.get(n2.uid)!.revision!.sha1 = '2'.repeat(40);
    const warnings: string[] = [];
    const gw2 = makeGateway(drive2, warnings);
    const r2 = await gw2.read('/soft.bin');
    const bytes = await drain(r2.stream);
    check('unverified-digest mismatch still returns the data', bytes.byteLength === 12);
    check('unverified-digest mismatch is logged, not silent', warnings.some((w) => /does not match the unverified claimed SHA-1/.test(w)));
}

console.log('\n-- error mapping --');
{
    const drive = new FakeDrive();
    const gw = makeGateway(drive);
    const cases: Array<[string, unknown, number]> = [
        ['rate limit maps to 429', new RateLimitedError('slow down'), 429],
        ['connection error maps to 503', new ConnectionError('offline'), 503],
        ['server error maps to 502', new ServerError('boom'), 502],
        ['validation error maps to 422', new ValidationError('bad'), 422],
        ['abort maps to 499', new AbortError('stop'), 499],
        ['integrity error maps to 422', new IntegrityError('bad hash'), 422],
    ];
    for (const [name, error, expected] of cases) {
        drive.failNextUploaderWith = error;
        await status(name, () => gw.put(`/err-${expected}-${Math.floor(Number(expected))}.txt`, bodyOf('x'), { immutable: true }), expected);
    }
}

console.log('\n-- path safety --');
{
    const drive = new FakeDrive();
    drive.addFile('ok.txt', 'ok');
    const gw = makeGateway(drive);
    await status('traversal segment is rejected (400, not resolved)', () => gw.read('/../etc/passwd'), 400);
    check('path normalisation collapses redundant slashes', (await gw.stat('//ok.txt'))?.size === 2);
    await status('PUT to the root collection is refused', () => gw.put('/', bodyOf('x'), { immutable: true }), 405);
}

console.log('\n-- quota --');
{
    const gw = makeGateway(new FakeDrive());
    const q = await gw.quota();
    check('quota reports used space', q.used === 42);
    check('quota reports available as max minus used', q.available === 58, String(q.available));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
