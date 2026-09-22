/**
 * Credential store for the persistent service.
 *
 * Reuses the official CLI's on-disk format (`auth-session.json`, parsed by
 * cli/src/credentials/parseCredentials.ts) so the already-authenticated CLI
 * session is picked up as-is, and adds the guarantees a long-running daemon
 * needs that the one-shot CLI does not:
 *
 *  - Single writer: a PID lock (`auth-session.lock`) makes exactly one live
 *    process the owner of credential updates (token refresh persistence).
 *    A second service instance refuses to start instead of racing.
 *  - Atomic, owner-only persistence: write to a 0600 temp file in the same
 *    directory, fsync, rename. Readers never observe a partial file and the
 *    mode never widens.
 *  - Directory hygiene: the state directory must be a real directory owned by
 *    us with mode 0700 (matching the CLI's unsafe_file expectations).
 *  - Preserve instead of destroy: when the account layer signs out because a
 *    refresh was rejected, the session file is left byte-for-byte intact and a
 *    secret-free `auth-session.signout-<timestamp>.json` marker records why.
 *    Sign-out fires on any 4xx except 429, which includes whatever a captive
 *    portal, proxy or WAF injects, so it is not proof the session is dead.
 *    Renaming the file aside was the earlier design and was worse than useless:
 *    it minted an additional on-disk copy of `userKeyPassword` -- a valid
 *    passphrase for the user's OpenPGP keys -- every time a false positive
 *    fired. The session therefore stays loadable; what stops the service from
 *    pretending it can serve requests is the sign-out latch in bootstrap.ts,
 *    which makes every request answer 401 instead of a retryable 5xx.
 *
 * Nothing in this module logs credential values.
 *
 * Liveness is decided from the recorded pid, the same approach the official CLI
 * uses for events.lock (cli/src/events/lock.ts), so the two behave consistently.
 * Pid reuse is handled rather than merely documented: a lock file whose mtime
 * predates the current boot is stale whatever its pid now resolves to, because
 * no process survives a boot. Without that test, a reboot -- where pids are
 * re-allocated from 1 -- can leave a lock naming a pid since taken by an
 * unrelated daemon, refusing every start until someone deletes the file.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '@protontech/drive-sdk';

import type { Credentials as CredentialsSnapshot, CredentialsStore } from '../credentials/interface';
import { parseStoredSnapshot } from '../credentials/parseCredentials';

export const SESSION_FILENAME = 'auth-session.json';
export const SESSION_LOCK_FILENAME = 'auth-session.lock';

export class SessionOwnershipError extends Error {
    name = 'SessionOwnershipError';
}

export class SessionDirectoryUnsafeError extends Error {
    name = 'SessionDirectoryUnsafeError';
}

/** Another process rewrote the session file while this one held it. */
export class SessionConflictError extends Error {
    name = 'SessionConflictError';
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        return code === 'EPERM';
    }
}

/**
 * The official CLI's own mutual-exclusion file (cli/src/events/lock.ts). Every
 * CLI invocation holds it for its lifetime, so a live holder means another Proton
 * Drive client is active on this data directory right now.
 */
export const CLI_EVENTS_LOCK_FILENAME = 'events.lock';

/**
 * True when `mtimeMs` predates the current boot.
 *
 * Lock files record a pid, and pid liveness alone cannot distinguish "still
 * held" from "pid recycled". That distinction matters most after a reboot,
 * which is exactly when it is least reliable: pids are re-allocated from 1, so
 * a lock written by a service that itself started at boot has a real chance of
 * naming a pid now occupied by an unrelated boot-time daemon. The lock then
 * looks live forever and startup is refused until someone deletes the file by
 * hand -- which for an unattended backup means it simply stops running.
 *
 * No process survives a boot, so a lock file older than the current boot cannot
 * be held, whatever its pid now points at. This only ever makes the staleness
 * test more accurate: it never declares a lock from this boot stale, so the
 * single-writer guarantee is unchanged.
 */
function predatesBoot(mtimeMs: number): boolean {
    // os.uptime() is seconds since boot; allow a second of slack for coarse
    // filesystem timestamps and clock granularity.
    const bootMs = Date.now() - os.uptime() * 1000;
    return mtimeMs < bootMs - 1000;
}

/**
 * Remove temp files left beside `target` by a writer that died mid-write.
 *
 * writePrivateFileAtomic unlinks its temp file on any in-process failure, but a
 * power loss or SIGKILL between create and rename leaves it behind -- holding a
 * complete plaintext copy of the session, including the key password. Nothing
 * else ever removes it, so copies accumulate one per hard stop.
 *
 * Only safe to call while holding the session lock: that is what makes "no
 * other process is writing one of these right now" true.
 */
export async function pruneOrphanTempFiles(target: string, logger?: Logger): Promise<number> {
    const dir = path.dirname(target);
    const prefix = `.${path.basename(target)}.`;
    let removed = 0;
    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        return 0;
    }
    for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith('.tmp')) {
            continue;
        }
        try {
            await fs.unlink(path.join(dir, name));
            removed += 1;
        } catch {
            // Raced with someone else's cleanup, or not ours to remove.
        }
    }
    if (removed > 0) {
        // Deliberately does not name the files: the name embeds nothing secret,
        // but the count is all an operator needs and keeps the log terse.
        logger?.warn(`Removed ${removed} orphaned credential temp file(s) left by an interrupted write`);
    }
    return removed;
}

/**
 * Returns the pid of a live process holding the CLI's events lock, or null.
 *
 * Read this BEFORE creating anything: a startup that is going to be refused must
 * not leave files behind in a directory another client owns.
 */
export async function findActiveProtonClient(appDir: string): Promise<number | null> {
    try {
        const lockPath = path.join(appDir, CLI_EVENTS_LOCK_FILENAME);
        const raw = await fs.readFile(lockPath, 'utf8');
        const parsed = JSON.parse(raw) as { pid?: unknown };
        const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN;
        if (!isProcessAlive(pid) || pid === process.pid) {
            return null;
        }
        // The official CLI records only a pid, so pid reuse after a reboot would
        // otherwise make a dead client look permanently alive and refuse every
        // start. Unlike the CLI's own acquire path, this check never deletes the
        // file: it is another client's, so it is only ever read.
        const st = await fs.stat(lockPath).catch(() => null);
        if (st && predatesBoot(st.mtimeMs)) {
            return null;
        }
        return pid;
    } catch {
        // Missing, unreadable or malformed: no evidence of an active client.
        return null;
    }
}

/**
 * Delete the CLI's events.lock ONLY when it predates the current boot.
 *
 * findActiveProtonClient can tell that such a lock is stale, but the events
 * provider that runs later is the official CLI's own code, and its lock check is
 * pid-only (cli/src/events/lock.ts). So after a reboot that recycled the recorded
 * pid, this service would clear its own check and still be refused by that one,
 * with no way out but manual deletion -- which for an unattended backup means it
 * never runs again.
 *
 * The condition is deliberately narrow. A lock file older than the current boot
 * cannot be held by any live process, whatever its pid now resolves to, so this
 * can never remove a lock a running client depends on. A lock written during this
 * boot is left strictly alone, even if its pid looks dead -- that case is the
 * CLI's own to resolve, and it already does.
 */
export async function releaseStaleEventsLock(appDir: string, logger?: Logger): Promise<boolean> {
    const lockPath = path.join(appDir, CLI_EVENTS_LOCK_FILENAME);
    let raw: string;
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
        raw = await fs.readFile(lockPath, 'utf8');
        st = await fs.stat(lockPath);
    } catch {
        return false;
    }
    if (!predatesBoot(st.mtimeMs)) {
        return false;
    }
    // Re-read and only remove the exact bytes judged stale, so a lock rewritten
    // by a client starting right now is not deleted underneath it.
    const stillSame = await fs.readFile(lockPath, 'utf8').catch(() => null);
    if (stillSame !== raw) {
        return false;
    }
    try {
        await fs.unlink(lockPath);
    } catch {
        return false;
    }
    logger?.warn(
        `Removed ${CLI_EVENTS_LOCK_FILENAME} left over from before the current boot; no process can still hold it.`,
    );
    return true;
}

/**
 * Verify the state directory is safe to hold plaintext credentials: exists,
 * is a directory (not a symlink), owned by the current user, mode 0700.
 * Creates it with 0700 if missing.
 */
export async function ensurePrivateDirectory(dir: string, logger?: Logger): Promise<void> {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new SessionDirectoryUnsafeError(`State directory is not a plain directory: ${dir}`);
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
        throw new SessionDirectoryUnsafeError(`State directory is not owned by the current user: ${dir}`);
    }
    if ((st.mode & 0o777) !== 0o700) {
        // Tighten rather than fail: the CLI creates this directory with the
        // ambient umask. This directory may be shared with the official CLI, so
        // say so rather than changing it silently.
        const before = (st.mode & 0o777).toString(8);
        await fs.chmod(dir, 0o700);
        logger?.warn(`Tightened permissions on ${dir} from 0${before} to 0700 (it holds credentials)`);
    }
}

/**
 * Acquire exclusive ownership of credential updates for `dir`. Returns a
 * release function. Throws SessionOwnershipError if a live process owns it.
 */
export async function acquireSessionOwnership(dir: string, logger: Logger): Promise<() => Promise<void>> {
    const lockPath = path.join(dir, SESSION_LOCK_FILENAME);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await fs.readFile(lockPath, 'utf8');
            const parsed = JSON.parse(raw) as { pid?: unknown };
            const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN;
            // Any LIVE holder blocks acquisition, including this process itself.
            // Exempting our own pid would let a second bootstrap inside one
            // process silently steal the lock -- defeating the single-writer
            // guarantee it exists to provide -- and the unlink/recreate that
            // followed opened a window for a third process to slip in.
            const st = await fs.stat(lockPath).catch(() => null);
            const recycledPid = st !== null && predatesBoot(st.mtimeMs);
            if (isProcessAlive(pid) && !recycledPid) {
                const who = pid === process.pid ? 'This process' : `Another process (pid ${pid})`;
                throw new SessionOwnershipError(
                    `${who} already owns the session in ${dir}. Only one process may update these credentials.`,
                );
            }
            if (recycledPid && isProcessAlive(pid)) {
                logger.warn(
                    `Session lock predates this boot; pid ${pid} has been recycled by an unrelated process. Treating the lock as stale.`,
                );
            }
            // Re-read immediately before unlinking and only remove the exact
            // bytes we judged stale. Without this, a lock written by a new live
            // owner between the check and the unlink would be deleted.
            logger.warn(`Removing stale session lock left by pid ${pid}`);
            const stillSame = await fs.readFile(lockPath, 'utf8').catch(() => null);
            if (stillSame === raw) {
                await fs.unlink(lockPath).catch(() => {});
            }
        } catch (error: unknown) {
            if (error instanceof SessionOwnershipError) {
                throw error;
            }
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                // Malformed lock file: treat as stale.
                await fs.unlink(lockPath).catch(() => {});
            }
        }
        try {
            await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
                flag: 'wx',
                mode: 0o600,
            });
            return async () => {
                try {
                    const raw = await fs.readFile(lockPath, 'utf8');
                    if ((JSON.parse(raw) as { pid?: number }).pid === process.pid) {
                        await fs.unlink(lockPath);
                    }
                } catch {
                    // already gone
                }
            };
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            // Lost a race; loop once more to re-evaluate liveness.
        }
    }
    throw new SessionOwnershipError(`Could not acquire session lock in ${dir}`);
}

/**
 * Write `data` to `target` atomically with mode 0600.
 *
 * The temp file name includes a random component and is removed on any failure.
 * A fixed, pid-based name left behind by an earlier crash would make every later
 * write fail with EEXIST, silently stopping token persistence for the lifetime of
 * the process -- and would leave plaintext credentials lying in a stray file.
 */
export async function writePrivateFileAtomic(target: string, data: string): Promise<void> {
    const dir = path.dirname(target);
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
        const fd = openSync(tmp, 'wx', 0o600);
        try {
            // writeSync may write fewer bytes than requested; a silent short write
            // would leave a truncated session that parses as "logged out".
            const bytes = Buffer.from(data, 'utf8');
            let written = 0;
            while (written < bytes.byteLength) {
                const n = writeSync(fd, bytes, written, bytes.byteLength - written);
                if (n <= 0) {
                    throw new Error(`Short write persisting ${target}: ${written}/${bytes.byteLength} bytes`);
                }
                written += n;
            }
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        await fs.rename(tmp, target);
    } catch (error: unknown) {
        await fs.unlink(tmp).catch(() => {});
        throw error;
    }
    // rename() is atomic; fsync the directory so the rename is durable too.
    try {
        const dfd = openSync(dir, 'r');
        try {
            fsyncSync(dfd);
        } finally {
            closeSync(dfd);
        }
    } catch {
        // Directory fsync is best-effort on some filesystems.
    }
}

export class OwnedFileSessionStore implements CredentialsStore {
    private readonly filePath: string;
    /**
     * Identity of the session file as this process last saw it.
     *
     * The official CLI does not take auth-session.lock, writes the file in place
     * and non-atomically, and runs happily even when events.lock is already held
     * (it just loses event subscriptions). So a `proton-drive` command started
     * AFTER this service is a second refresher of the same rotating token, and
     * the startup events.lock check cannot detect that ordering. Recording the
     * file identity lets a save notice it is about to overwrite someone else's
     * newer tokens, and refuse.
     */
    private lastSeen?: { ino: number; mtimeMs: number; size: number };

    constructor(
        private readonly dir: string,
        private readonly logger: Logger,
    ) {
        this.filePath = path.join(dir, SESSION_FILENAME);
    }

    private async currentIdentity(): Promise<{ ino: number; mtimeMs: number; size: number } | null> {
        try {
            const st = await fs.lstat(this.filePath);
            return { ino: Number(st.ino), mtimeMs: st.mtimeMs, size: st.size };
        } catch {
            return null;
        }
    }

    private sameIdentity(
        a: { ino: number; mtimeMs: number; size: number } | null | undefined,
        b: { ino: number; mtimeMs: number; size: number } | null | undefined,
    ): boolean {
        if (!a || !b) {
            return a === b || (!a && !b);
        }
        return a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
    }

    async load(): Promise<CredentialsSnapshot | null> {
        let st;
        try {
            st = await fs.lstat(this.filePath);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                this.logger.debug('No stored session');
                return null;
            }
            throw error;
        }
        if (st.isSymbolicLink() || !st.isFile()) {
            throw new SessionDirectoryUnsafeError(`Session file is not a regular file: ${this.filePath}`);
        }
        if ((st.mode & 0o077) !== 0) {
            this.logger.warn('Session file was group/world accessible; tightening to 0600');
            await fs.chmod(this.filePath, 0o600);
        }
        if (st.size > 1024 * 1024) {
            throw new SessionDirectoryUnsafeError('Session file is unexpectedly large');
        }
        const raw = await fs.readFile(this.filePath, 'utf8');
        this.lastSeen = await this.currentIdentity() ?? undefined;
        const parsed = parseStoredSnapshot(raw);
        if (!parsed) {
            this.logger.warn('Stored session is present but not parseable; treating as logged out');
        }
        return parsed;
    }

    async save(snapshot: CredentialsSnapshot): Promise<void> {
        const current = await this.currentIdentity();
        if (this.lastSeen && current && !this.sameIdentity(this.lastSeen, current)) {
            // Someone else rewrote the session since we read it. Proton rotates
            // the refresh token on use, so overwriting would leave that writer
            // holding a token we just invalidated -- and would discard the newer
            // one. Refuse; the caller surfaces the failure.
            throw new SessionConflictError(
                `${this.filePath} changed on disk since this process read it: another Proton client is ` +
                    `writing the same session. Refusing to overwrite it. Stop the other client (do not run ` +
                    `the official CLI against the same PROTON_DRIVE_CACHE_DIR while this service is up).`,
            );
        }
        this.logger.debug('Persisting updated session');
        await writePrivateFileAtomic(this.filePath, JSON.stringify(snapshot));
        this.lastSeen = await this.currentIdentity() ?? undefined;
    }

    /**
     * Called by the account layer on sign-out, including when a token refresh is
     * rejected. It does NOT delete or move the session file.
     *
     * The account module signs out on ANY 4xx from /auth/v4/refresh except 429
     * (incubating/account/js/src/apiClient.ts), with no retry, because the refresh
     * is a POST. That bucket includes 408, 403, 404 and anything a captive portal,
     * proxy or WAF injects. Treating one such response as proof the session is
     * dead would destroy a perfectly good session and stop an unattended backup
     * for the night.
     *
     * Earlier versions renamed the file aside. That avoided outright deletion but
     * minted a fresh on-disk copy of `userKeyPassword` every time, which is
     * derived from the account password and stays a valid passphrase for the
     * user's OpenPGP keys indefinitely -- so repeated false positives accumulated
     * live decryption credentials in cleartext.
     *
     * So: keep the session exactly where it is, record a secret-free marker that a
     * sign-out happened, and say so loudly. If the session really is revoked, the
     * next attempt fails again and the operator re-runs `auth login`, which
     * overwrites the file. If it was a transient 4xx, nothing was lost.
     */
    async remove(): Promise<void> {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const marker = path.join(this.dir, `auth-session.signout-${stamp}.json`);
        let uidHint = 'unknown';
        try {
            const snapshot = await this.load();
            if (snapshot) {
                // First 6 characters only: enough to correlate, not a credential.
                uidHint = `${snapshot.session.uid.slice(0, 6)}...`;
            }
        } catch {
            // Best effort only; the marker matters more than the hint.
        }
        try {
            await writePrivateFileAtomic(
                marker,
                JSON.stringify(
                    {
                        at: new Date().toISOString(),
                        sessionUidPrefix: uidHint,
                        note:
                            'The account layer signed out, usually a rejected token refresh. The session ' +
                            'file was intentionally NOT deleted: the sign-out fires on any 4xx except 429, ' +
                            'which includes transient proxy and portal responses. Re-run `auth login` if ' +
                            'this persists. This marker holds no credentials.',
                    },
                    null,
                    2,
                ) + '\n',
            );
            await this.pruneMarkers();
        } catch (error: unknown) {
            this.logger.warn(`Could not record a sign-out marker: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.logger.error(
            `Session signed out by the account layer (session ${uidHint}). The session file was PRESERVED, ` +
                `because this fires on any 4xx from the refresh endpoint including transient ones. ` +
                `If Proton really revoked it, re-run 'auth login'.`,
        );
    }

    /** Keep only the newest few sign-out markers. They hold no secrets, just noise. */
    private async pruneMarkers(): Promise<void> {
        const keep = 5;
        try {
            const names = (await fs.readdir(this.dir))
                .filter((n) => n.startsWith('auth-session.signout-'))
                .sort();
            for (const name of names.slice(0, Math.max(0, names.length - keep))) {
                await fs.unlink(path.join(this.dir, name)).catch(() => {});
            }
        } catch {
            // Best effort only.
        }
    }
}
