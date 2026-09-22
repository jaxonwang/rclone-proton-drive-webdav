/**
 * Protects committed content from rclone's failed-upload cleanup.
 *
 * rclone's WebDAV backend (backend/webdav/webdav.go, updateSimple) runs
 * `_ = o.Remove(ctx)` — an unconditional DELETE of the target — whenever a PUT
 * fails, to clear a partially written object. That is correct when the PUT was
 * creating a NEW object, but destructive when the server deliberately refused to
 * overwrite an EXISTING committed file: the cleanup DELETE trashes the very file
 * the refusal was protecting, and rclone's next retry then succeeds into the
 * freed name. Observed end-to-end: a 412 refusal followed by "Attempt 2/3
 * succeeded" with the remote content replaced.
 *
 * So when a PUT is refused because committed content already exists, that exact
 * path is marked protected for a short window. A DELETE arriving inside the
 * window is rejected with 403 instead of trashing the file. rclone ignores the
 * cleanup DELETE's error, retries the PUT, gets refused again, and the copy
 * fails with the remote content intact — the intended outcome.
 *
 * Scope is deliberately narrow: only the exact refused path, only for a few
 * seconds, and only triggered by a refusal this process just issued. An
 * ordinary user-initiated delete outside that window is unaffected. Drafts are
 * never involved: unfinished uploads are invisible to DELETE by construction.
 */

/** How long a refused path stays protected. rclone's cleanup DELETE follows its failed PUT within ~1s. */
export const OVERWRITE_PROTECT_MS = 15_000;

export class OverwriteGuard {
    private readonly until = new Map<string, number>();

    /** Called when a PUT failed while content already existed at `path`. */
    protect(path: string, now: number = Date.now()): void {
        // Prune on write as well as on read: a daemon that only ever protects
        // paths (and is never asked about a DELETE) would otherwise accumulate
        // entries for the life of the process.
        this.prune(now);
        this.until.set(path, now + OVERWRITE_PROTECT_MS);
    }

    /** True when a DELETE of `path` would be the cleanup of a failed PUT we just rejected. */
    isProtected(path: string, now: number = Date.now()): boolean {
        this.prune(now);
        const expiry = this.until.get(path);
        return expiry !== undefined && expiry > now;
    }

    /** Number of currently tracked paths. Exposed for tests. */
    get size(): number {
        return this.until.size;
    }

    /** Drop protection, e.g. once the path is legitimately gone. */
    release(path: string): void {
        this.until.delete(path);
    }

    private prune(now: number): void {
        for (const [path, expiry] of this.until) {
            if (expiry <= now) {
                this.until.delete(path);
            }
        }
    }
}
