/**
 * Storage-agnostic gateway that the WebDAV layer talks to.
 *
 * The WebDAV server (webdav.ts) depends only on this interface, never on the
 * Proton SDK directly. That keeps the protocol translation testable with an
 * in-memory fake (mockGateway.ts) and confines all Proton-specific behaviour
 * to sdkGateway.ts.
 *
 * Paths are POSIX, always absolute, rooted at "/" which is the configured
 * Proton root (default `/my-files`). The gateway is responsible for mapping
 * that user-space path onto the concrete Proton path.
 */

export interface DriveEntry {
    /** Base name (last path segment). Empty string for the root collection. */
    name: string;
    isDir: boolean;
    /** Clear-text size in bytes. 0 for folders. */
    size: number;
    /** Best available modification time (claimed fs mtime, else server mtime). */
    mtime: Date;
    /**
     * Lowercase hex SHA-1 of the file content, when Proton has a claimed digest
     * for the active revision. Absent for folders and for files whose revision
     * carries no SHA-1 (e.g. very old uploads). Never fabricated.
     */
    sha1?: string;
}

export interface PutOptions {
    /** Expected clear-text size, or undefined when genuinely unknown. */
    size?: number;
    /** Expected SHA-1 (lowercase hex, 40 chars); enables SDK integrity check. */
    sha1?: string;
    /** Modification time to embed in the uploaded revision. */
    mtime?: Date;
    /**
     * When true, refuse to replace the content of an existing committed file
     * (immutable semantics). A same-content upload is still reported as
     * skipped; only a real content change is refused.
     */
    immutable: boolean;
    /**
     * Explicit, narrowly-scoped consent to replace an unfinished draft left by
     * a DIFFERENT client. Must equal the exact target path to take effect.
     * Never set implicitly. Own drafts are always recovered by the SDK via the
     * stable client UID and do not require this.
     */
    overrideOtherClientDraftForPath?: string;
    /**
     * Aborted when the HTTP client goes away.
     *
     * The SDK limits concurrent uploads with a permit taken before the transfer
     * starts, and waiting for a permit has no timeout. Without a signal, a
     * client that disconnects mid-upload leaves the transfer running to
     * completion holding its permit, and a request that is merely queued waits
     * forever with no way to cancel it. Both are the shape of stall that
     * exhausts the queue and blocks every later upload.
     */
    signal?: AbortSignal;
}

export type PutResult =
    | { kind: 'created' } // new file, Proton confirmed commit
    | { kind: 'updated' } // new revision of existing file, Proton confirmed commit
    | { kind: 'skipped-identical' }; // existing file already had identical content (SHA-1)

export class GatewayError extends Error {
    /**
     * The error this was mapped from, when there is one.
     *
     * A 5xx GatewayError means an internal bug, and the mapped message alone is
     * rarely enough to find it: "undefined is not a function" with no stack cost
     * real time to diagnose against live Proton. Keeping the original lets the
     * HTTP layer log a stack for anything it is about to answer 5xx.
     */
    readonly cause?: unknown;

    constructor(message: string, httpStatus: number, cause?: unknown) {
        super(message);
        this.httpStatus = httpStatus;
        this.cause = cause;
        this.name = 'GatewayError';
    }

    readonly httpStatus: number;
}

/** Path does not exist. Maps to 404. */
export class NotFoundError extends GatewayError {
    constructor(message = 'Not Found') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}

/** Parent collection missing / not a directory. Maps to 409 (rclone creates parent). */
export class ConflictError extends GatewayError {
    constructor(message = 'Conflict') {
        super(message, 409);
        this.name = 'ConflictError';
    }
}

/** Target collection already exists. Maps to 405 (rclone treats as "already exists"). */
export class AlreadyExistsError extends GatewayError {
    constructor(message = 'Already Exists') {
        super(message, 405);
        this.name = 'AlreadyExistsError';
    }
}

/** Immutable remote refused to overwrite differing content. Maps to 412. */
export class ImmutablePreconditionError extends GatewayError {
    constructor(message = 'Immutable: refusing to overwrite existing content') {
        super(message, 412);
        this.name = 'ImmutablePreconditionError';
    }
}

/**
 * An unfinished draft belonging to another client blocks the upload and no
 * explicit override was granted. Maps to 409 (NOT a retryable code) so rclone
 * surfaces it instead of looping.
 */
export class DraftConflictError extends GatewayError {
    constructor(message = 'An unfinished upload by another client blocks this name') {
        super(message, 409);
        this.name = 'DraftConflictError';
    }
}

/** Integrity check failed (server-computed content did not match expected SHA-1). Maps to 422. */
export class IntegrityFailedError extends GatewayError {
    constructor(message = 'Integrity verification failed') {
        super(message, 422);
        this.name = 'IntegrityFailedError';
    }
}

export interface ReadResult {
    stream: ReadableStream<Uint8Array>;
    /** Number of bytes the returned stream will produce. */
    size: number;
    /** Total clear-text size of the file (for Content-Range). */
    totalSize: number;
}

export interface DriveGateway {
    /** Metadata for a single node, or null if it does not exist. */
    stat(path: string): Promise<DriveEntry | null>;
    /** Children of a directory. Throws NotFoundError if missing or not a dir. */
    list(path: string): Promise<DriveEntry[]>;
    /**
     * Open a file for reading. When `range` is given, the returned stream
     * yields exactly that byte range (inclusive end). Ranged reads are used for
     * video seeking and partial fetches.
     */
    read(path: string, range?: { start: number; end: number }, signal?: AbortSignal): Promise<ReadResult>;
    /**
     * Upload content. Resolves ONLY after Proton confirms the revision is
     * committed. Honours immutability, own-draft recovery, and explicit
     * other-client draft override. Never resolves on a partial/aborted upload.
     */
    put(path: string, body: ReadableStream<Uint8Array>, opts: PutOptions): Promise<PutResult>;
    /** Create a directory. Throws ConflictError if parent missing, AlreadyExistsError if present. */
    mkcol(path: string): Promise<void>;
    /** Trash a file or directory (recoverable). Never used for draft recovery. */
    remove(path: string): Promise<void>;
    move(src: string, dst: string): Promise<void>;
    copy(src: string, dst: string): Promise<void>;
    /** Storage usage; fields may be undefined when Proton does not report them. */
    quota(): Promise<{ used?: number; available?: number }>;
    close?(): Promise<void>;
}
