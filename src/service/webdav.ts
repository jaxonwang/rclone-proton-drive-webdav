/**
 * WebDAV protocol translation. Pure with respect to storage: every operation
 * goes through a DriveGateway, so this module is exercised in tests against an
 * in-memory fake and in production against the Proton SDK gateway.
 *
 * Targets rclone's WebDAV backend configured as:
 *     type = webdav, vendor = nextcloud, nextcloud_chunk_size = 0
 *
 *   - PROPFIND (Depth 0/1) with oc:checksums -> listing, size, mtime, SHA-1
 *   - GET with Range            -> ranged reads (206)
 *   - PUT with X-OC-Mtime + OC-Checksum, replying "X-OC-Mtime: accepted"
 *   - PATCH with X-Recalculate-Hash -> returns the stored SHA-1 (nextcloud quirk)
 *   - MKCOL / DELETE / MOVE / COPY / HEAD / OPTIONS / PROPPATCH
 *
 * Why `vendor = nextcloud` and NOT `vendor = owncloud`: rclone's owncloud quirks set
 * BOTH hasOCMD5 and hasOCSHA1, so Fs.Hashes() advertises MD5 and SHA-1. Proton only
 * ever has a SHA-1, and rclone's CheckHashes() picks the lowest-numbered common hash,
 * which is MD5. The result is that `rclone check --checksum` reports
 * "hashes could not be checked" and "0 differences found" even against corrupted
 * content -- verification silently does nothing. The nextcloud quirks set hasOCSHA1
 * only, so the common hash is SHA-1 and content really is compared. nextcloud also
 * still sends OC-Checksum on upload (unlike fastmail, whose hash set is SHA-1-only but
 * which sends no upload checksum at all), which is what lets the server verify
 * integrity, skip identical files, and enforce immutability.
 * `nextcloud_chunk_size = 0` disables rclone's Nextcloud chunked-upload protocol, which
 * this service does not implement.
 */
import {
    AlreadyExistsError,
    ConflictError,
    type DriveEntry,
    type DriveGateway,
    GatewayError,
    ImmutablePreconditionError,
    IntegrityFailedError,
    NotFoundError,
    type PutOptions,
} from './gateway';
import type { OverwriteGuard } from './overwriteGuard';
import { decode, encodeHref, isRoot, join, normalize } from './paths';
import { multistatus, proppatchMultistatus, quotaMultistatus, responseXml } from './propfind';

export interface WebdavOptions {
    /** Refuse to overwrite differing content of existing committed files. */
    immutable: boolean;
    /**
     * Exact path (WebDAV-space) for which replacing another client's draft is
     * explicitly authorised. Undefined disables all other-client overrides.
     */
    allowOverrideDraftForPath?: string;
    logger?: { debug: (m: string) => void; warn: (m: string) => void; error: (m: string, e?: unknown) => void };
    /**
     * Guards committed content against rclone's post-failure cleanup DELETE.
     * See overwriteGuard.ts. Required in production; tests may omit it.
     */
    guard?: OverwriteGuard;
}

const XML_CT = 'application/xml; charset=utf-8';

function davResponse(status: number, body?: string, headers: Record<string, string> = {}): Response {
    return new Response(body ?? null, {
        status,
        headers: {
            DAV: '1',
            'MS-Author-Via': 'DAV',
            ...headers,
        },
    });
}

function xmlText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function errorToResponse(err: unknown, log?: WebdavOptions['logger']): Response {
    if (err instanceof GatewayError) {
        // Messages carry paths, which may contain & or <.
        return davResponse(
            err.httpStatus,
            `<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:message>${xmlText(err.message)}</d:message></d:error>`,
            { 'Content-Type': XML_CT },
        );
    }
    log?.error('Unhandled WebDAV error', err);
    return davResponse(500, undefined);
}

type RangeResult = { start: number; end: number } | 'none' | 'unsatisfiable';

function parseRange(header: string | null, totalSize: number): RangeResult {
    if (!header) {
        return 'none';
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) {
        // A syntactically invalid Range must be ignored, per RFC 9110.
        return 'none';
    }
    const [, startStr, endStr] = m;
    let start: number;
    let end: number;
    if (startStr === '' && endStr !== '') {
        // suffix range: last N bytes
        const n = parseInt(endStr, 10);
        start = Math.max(0, totalSize - n);
        end = totalSize - 1;
    } else {
        start = startStr === '' ? 0 : parseInt(startStr, 10);
        end = endStr === '' ? totalSize - 1 : parseInt(endStr, 10);
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0) {
        return 'none';
    }
    if (totalSize === 0) {
        // No satisfiable range exists in an empty representation.
        return 'unsatisfiable';
    }
    if (start >= totalSize || start > end) {
        return 'unsatisfiable';
    }
    end = Math.min(end, totalSize - 1);
    return { start, end };
}

function destinationPath(req: Request): string {
    const dest = req.headers.get('Destination');
    if (!dest) {
        throw new ConflictError('Missing Destination header');
    }
    // Destination may be an absolute URL or an absolute path.
    try {
        const u = new URL(dest);
        return normalize(decode(u.pathname));
    } catch {
        return normalize(decode(dest));
    }
}

export async function handleRequest(req: Request, gw: DriveGateway, opts: WebdavOptions): Promise<Response> {
    const url = new URL(req.url);
    const path = normalize(decode(url.pathname));
    const method = req.method.toUpperCase();
    opts.logger?.debug(`${method} ${path}`);

    try {
        switch (method) {
            case 'OPTIONS':
                return davResponse(200, undefined, {
                    Allow: 'OPTIONS, GET, HEAD, PUT, PATCH, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY',
                });
            case 'PROPFIND':
                return await handlePropfind(req, gw, path);
            case 'PROPPATCH':
                return await handleProppatch(req, gw, path);
            case 'GET':
            case 'HEAD':
                return await handleGet(req, gw, path, method === 'HEAD');
            case 'PUT':
                return await handlePut(req, gw, path, opts);
            case 'PATCH':
                return await handleRecalculateHash(req, gw, path);
            case 'MKCOL':
                await gw.mkcol(path);
                return davResponse(201);
            case 'DELETE':
                if (opts.guard?.isProtected(path)) {
                    // This is rclone clearing up after a PUT we just refused.
                    // Deleting here would destroy the content the refusal protected.
                    opts.logger?.warn(
                        `Refusing DELETE ${path}: it follows a refused overwrite of existing content. ` +
                            `Delete explicitly (e.g. rclone deletefile) if removal is really intended.`,
                    );
                    return davResponse(
                        403,
                        '<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:message>Refusing to delete committed content immediately after a failed overwrite</d:message></d:error>',
                        { 'Content-Type': XML_CT },
                    );
                }
                await gw.remove(path);
                opts.guard?.release(path);
                return davResponse(204);
            case 'MOVE':
                await gw.move(path, destinationPath(req));
                return davResponse(201);
            case 'COPY':
                await gw.copy(path, destinationPath(req));
                return davResponse(201);
            default:
                return davResponse(405, undefined, {
                    Allow: 'OPTIONS, GET, HEAD, PUT, PATCH, DELETE, PROPFIND, PROPPATCH, MKCOL, MOVE, COPY',
                });
        }
    } catch (err) {
        return errorToResponse(err, opts.logger);
    }
}

async function handlePropfind(req: Request, gw: DriveGateway, path: string): Promise<Response> {
    const bodyText = await req.text().catch(() => '');
    // `rclone about` issues PROPFIND asking for quota props.
    if (bodyText.includes('quota-available-bytes')) {
        const q = await gw.quota();
        return davResponse(207, quotaMultistatus(path, q.used, q.available), { 'Content-Type': XML_CT });
    }

    const depth = req.headers.get('Depth') ?? 'infinity';
    const self = await gw.stat(path);
    if (!self) {
        throw new NotFoundError();
    }
    const responses: string[] = [responseXml(hrefFor(path, self), self)];
    if (depth !== '0' && self.isDir) {
        const children = await gw.list(path);
        for (const child of children) {
            responses.push(responseXml(hrefFor(join(path, child.name), child), child));
        }
    }
    return davResponse(207, multistatus(responses), { 'Content-Type': XML_CT });
}

function hrefFor(path: string, entry: DriveEntry): string {
    // encodeHref adds a trailing slash for dir paths passed with one; keep the
    // raw path here and let responseXml/encodeHref handle dir slashes.
    if (isRoot(path)) {
        return '/';
    }
    return path;
}

async function handleProppatch(req: Request, gw: DriveGateway, path: string): Promise<Response> {
    const body = await req.text().catch(() => '');
    const self = await gw.stat(path);
    if (!self) {
        throw new NotFoundError();
    }
    // Only a no-op mtime (equal to stored, second precision) is reported OK;
    // a real change cannot be persisted without a re-upload, so report 403.
    const m = /<lastmodified[^>]*>(\d+)<\/lastmodified>/i.exec(body);
    const ok = m ? parseInt(m[1]!, 10) === Math.floor(self.mtime.getTime() / 1000) : false;
    return davResponse(207, proppatchMultistatus(path, ok), { 'Content-Type': XML_CT });
}

/**
 * rclone's Nextcloud quirk (canRecalcHash): after an upload that returned no
 * checksum, and after a PROPPATCH that would have discarded one, rclone issues
 * `PATCH` with `X-Recalculate-Hash: sha1` and reads the result from the
 * `OC-Checksum` response header.
 *
 * Proton stores a claimed SHA-1 with the revision; there is nothing to
 * recompute server-side, and recomputing would mean downloading and decrypting
 * the whole file. So this returns the digest Proton already holds, and returns
 * no OC-Checksum at all when Proton has none -- it never invents one.
 */
async function handleRecalculateHash(req: Request, gw: DriveGateway, path: string): Promise<Response> {
    if (!req.headers.get('X-Recalculate-Hash')) {
        return davResponse(400, undefined);
    }
    const info = await gw.stat(path);
    if (!info) {
        throw new NotFoundError();
    }
    if (info.isDir) {
        return davResponse(405);
    }
    return davResponse(200, undefined, info.sha1 ? { 'OC-Checksum': `SHA1:${info.sha1}` } : {});
}

async function handleGet(req: Request, gw: DriveGateway, path: string, headOnly: boolean): Promise<Response> {
    const info = await gw.stat(path);
    if (!info) {
        throw new NotFoundError();
    }
    if (info.isDir) {
        // Directories are not directly GETtable.
        return davResponse(405);
    }
    const range = parseRange(req.headers.get('Range'), info.size);
    if (range === 'unsatisfiable') {
        return davResponse(416, undefined, { 'Content-Range': `bytes */${info.size}` });
    }
    const commonHeaders: Record<string, string> = {
        'Accept-Ranges': 'bytes',
        'Last-Modified': info.mtime.toUTCString(),
        'Content-Type': 'application/octet-stream',
    };
    if (info.sha1) {
        commonHeaders['OC-Checksum'] = `SHA1:${info.sha1}`;
    }

    if (headOnly) {
        return new Response(null, {
            status: 200,
            headers: { ...commonHeaders, 'Content-Length': String(info.size) },
        });
    }

    if (range !== 'none') {
        const { stream, size, totalSize } = await gw.read(path, range);
        return new Response(stream, {
            status: 206,
            headers: {
                ...commonHeaders,
                'Content-Length': String(size),
                'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
            },
        });
    }
    const { stream, size } = await gw.read(path);
    return new Response(stream, {
        status: 200,
        headers: { ...commonHeaders, 'Content-Length': String(size) },
    });
}

function parseOcChecksum(header: string | null): string | undefined {
    if (!header) {
        return undefined;
    }
    for (const token of header.split(/\s+/)) {
        const [algo, value] = token.split(':');
        if (algo && value && algo.toUpperCase() === 'SHA1') {
            return value.toLowerCase();
        }
    }
    return undefined;
}

async function handlePut(req: Request, gw: DriveGateway, path: string, opts: WebdavOptions): Promise<Response> {
    // A zero-length PUT has no body stream. Rejecting it would make empty files
    // impossible to upload AND would trigger rclone's cleanup DELETE on the
    // target, so treat it as what it is: an empty payload.
    const body = req.body ?? new Response(new Uint8Array()).body!;
    const mtimeHeader = req.headers.get('X-OC-Mtime');
    const mtime = mtimeHeader ? new Date(parseInt(mtimeHeader, 10) * 1000) : undefined;
    const sha1 = parseOcChecksum(req.headers.get('OC-Checksum'));
    const lenHeader = req.headers.get('Content-Length');
    const size = lenHeader ? parseInt(lenHeader, 10) : undefined;

    const putOpts: PutOptions = {
        size: size !== undefined && !Number.isNaN(size) ? size : undefined,
        sha1,
        mtime,
        immutable: opts.immutable,
        overrideOtherClientDraftForPath: opts.allowOverrideDraftForPath,
    };

    let result;
    try {
        result = await gw.put(path, body, putOpts);
    } catch (error: unknown) {
        // rclone deletes the PUT target after ANY failed upload, not just a
        // refusal (backend/webdav: `_ = o.Remove(ctx)` in updateSimple). So a
        // transient 429/503, an integrity failure, or a PUT aimed at an existing
        // collection would all let that cleanup DELETE destroy live data. Arm the
        // guard whenever anything already exists at this path, regardless of why
        // the upload failed. Only consulted on the failure path, so the happy
        // path pays nothing.
        if (opts.guard) {
            const existing = await gw.stat(path).catch(() => null);
            if (existing) {
                opts.guard.protect(path);
                opts.logger?.warn(
                    `PUT ${path} failed while content already exists there; protecting it from rclone's cleanup DELETE`,
                );
            }
        }
        throw error;
    }
    const headers: Record<string, string> = {};
    if (sha1) {
        headers['OC-Checksum'] = `SHA1:${sha1}`;
    }
    switch (result.kind) {
        case 'created':
        case 'updated':
            // The modification time really was embedded in the new revision, so
            // tell rclone not to follow up with a PROPPATCH.
            if (mtime) {
                headers['X-OC-Mtime'] = 'accepted';
            }
            return davResponse(result.kind === 'created' ? 201 : 204, undefined, headers);
        case 'skipped-identical':
            // Nothing was written, so the remote still carries its previous
            // modification time. Claiming "accepted" here would assert a change
            // that did not happen; rclone is left to discover it cannot set the
            // time (Proton stores mtime inside a revision) rather than being
            // misinformed.
            return davResponse(204, undefined, headers);
    }
}

// Re-exported for tests that assert error mapping.
export { AlreadyExistsError, ConflictError, ImmutablePreconditionError, IntegrityFailedError, NotFoundError };
export { encodeHref };
