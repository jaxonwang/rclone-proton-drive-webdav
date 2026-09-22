/**
 * Session-layer tests. These exercise the REAL account module
 * (`proton-drive-sdk-account` ApiClient + Credentials) and the service's
 * credential store against a local mock Proton API, with synthetic
 * credentials only. No real account, no keyring, no Proton network.
 *
 *   bun run tests/session-tests.ts
 *
 * Covered: session load from the CLI's on-disk format, single-writer
 * ownership, atomic owner-only persistence, token refresh persistence,
 * expired/revoked session handling (quarantine, not deletion), unavailable
 * keyring, and permission hygiene.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';

import { ApiClient } from 'proton-drive-sdk-account';

import { Credentials } from '../src/credentials/credentials';
import {
    acquireSessionOwnership,
    ensurePrivateDirectory,
    OwnedFileSessionStore,
    pruneOrphanTempFiles,
    SESSION_FILENAME,
    SessionOwnershipError,
    writePrivateFileAtomic,
} from '../src/service/sessionStore';

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        console.log(`PASS: ${name}`);
        pass++;
    } else {
        console.log(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`);
        fail++;
    }
}
async function checkThrows(name: string, fn: () => Promise<unknown>, matcher: (e: unknown) => boolean): Promise<void> {
    try {
        await fn();
        check(name, false, 'expected a throw, got success');
    } catch (e) {
        check(name, matcher(e), `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    }
}

const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as unknown as Parameters<typeof acquireSessionOwnership>[1];

const mode = (p: string) => statSync(p).mode & 0o777;

// Synthetic session in the CLI's exact on-disk shape (cli/src/credentials/parseCredentials.ts).
const SYNTHETIC = {
    cachePassword: 'c3ludGhldGljLWNhY2hlLXBhc3N3b3JkLWZvci10ZXN0cw==',
    userKeyPassword: 'synthetic-user-key-password',
    session: { uid: 'synthetic-uid-0000000000000000', accessToken: 'synthetic-access-token-initial', refreshToken: 'synthetic-refresh-token-initial' },
    telemetryEnabled: false,
};

const root = mkdtempSync(path.join(tmpdir(), 'pd-session-tests-'));
console.log(`workdir: ${root}\n`);

// ---------------------------------------------------------------------------
console.log('-- directory hygiene --');
{
    const dir = path.join(root, 'statedir');
    await ensurePrivateDirectory(dir);
    check('creates state dir with mode 0700', mode(dir) === 0o700, `got ${mode(dir).toString(8)}`);

    chmodSync(dir, 0o755);
    await ensurePrivateDirectory(dir);
    check('tightens a group/world-readable state dir to 0700', mode(dir) === 0o700, `got ${mode(dir).toString(8)}`);

    const linkTarget = path.join(root, 'real-target');
    mkdirSync(linkTarget, { mode: 0o700 });
    const link = path.join(root, 'linked-state');
    symlinkSync(linkTarget, link);
    await checkThrows(
        'refuses a symlinked state dir',
        () => ensurePrivateDirectory(link),
        (e) => e instanceof Error && e.name === 'SessionDirectoryUnsafeError',
    );
}

// ---------------------------------------------------------------------------
console.log('\n-- atomic private writes --');
{
    const dir = path.join(root, 'atomic');
    mkdirSync(dir, { mode: 0o700 });
    const target = path.join(dir, 'file.json');
    await writePrivateFileAtomic(target, '{"a":1}');
    check('atomic write creates the file with mode 0600', mode(target) === 0o600, `got ${mode(target).toString(8)}`);
    check('atomic write content correct', readFileSync(target, 'utf8') === '{"a":1}');
    await writePrivateFileAtomic(target, '{"a":2}');
    check('atomic overwrite replaces content', readFileSync(target, 'utf8') === '{"a":2}');
    check('atomic overwrite keeps mode 0600', mode(target) === 0o600, `got ${mode(target).toString(8)}`);
    check('no temp files left behind', readdirSync(dir).filter((f) => f.includes('tmp')).length === 0, readdirSync(dir).join(','));
}

// ---------------------------------------------------------------------------
console.log('\n-- single-writer ownership --');
{
    const dir = path.join(root, 'ownership');
    await ensurePrivateDirectory(dir);
    const release = await acquireSessionOwnership(dir, silentLogger);
    check('lock file is 0600', mode(path.join(dir, 'auth-session.lock')) === 0o600);
    await checkThrows(
        'second live acquirer is refused',
        () => acquireSessionOwnership(dir, silentLogger),
        (e) => e instanceof SessionOwnershipError,
    );
    await release();
    check('release removes the lock', !existsSync(path.join(dir, 'auth-session.lock')));

    // A lock left by a process that no longer exists must be reclaimable.
    writeFileSync(path.join(dir, 'auth-session.lock'), JSON.stringify({ pid: 2147483646 }), { mode: 0o600 });
    const release2 = await acquireSessionOwnership(dir, silentLogger);
    check('stale lock from a dead pid is reclaimed', existsSync(path.join(dir, 'auth-session.lock')));
    await release2();

    writeFileSync(path.join(dir, 'auth-session.lock'), 'not json at all', { mode: 0o600 });
    const release3 = await acquireSessionOwnership(dir, silentLogger);
    check('malformed lock is treated as stale', existsSync(path.join(dir, 'auth-session.lock')));
    await release3();

    // Pid reuse after a reboot: the recorded pid IS alive (it is this very test
    // process), but the lock was written before the current boot, so no live
    // process can be holding it. Without the boot check this refuses forever and
    // an unattended backup simply stops.
    const lockPath = path.join(dir, 'auth-session.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: '1999-01-01T00:00:00.000Z' }), { mode: 0o600 });
    const preBoot = new Date(Date.now() - (os.uptime() + 3600) * 1000);
    utimesSync(lockPath, preBoot, preBoot);
    const release4 = await acquireSessionOwnership(dir, silentLogger);
    check('a lock predating this boot is stale even though its pid resolves', existsSync(lockPath));
    await release4();

    // ...and the same lock dated inside this boot must still block, or the fix
    // would have quietly disabled the single-writer guarantee it protects.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    await checkThrows(
        'a lock from this boot with a live pid still blocks',
        () => acquireSessionOwnership(dir, silentLogger),
        (e) => e instanceof SessionOwnershipError,
    );
    rmSync(lockPath, { force: true });
}

// ---------------------------------------------------------------------------
console.log('\n-- credential temp files left by an interrupted write --');
{
    const dir = path.join(root, 'orphan-temps');
    await ensurePrivateDirectory(dir);
    const target = path.join(dir, SESSION_FILENAME);
    // Shaped exactly like writePrivateFileAtomic's temp name. A power loss
    // between create and rename leaves one of these holding a complete plaintext
    // session, including the key password, and nothing else ever removes it.
    const orphanA = path.join(dir, `.${SESSION_FILENAME}.4242.aaaaaaaa-1111-2222-3333-444444444444.tmp`);
    const orphanB = path.join(dir, `.${SESSION_FILENAME}.99.bbbbbbbb-5555-6666-7777-888888888888.tmp`);
    const unrelated = path.join(dir, 'cache-crypto.sqlite');
    writeFileSync(orphanA, JSON.stringify(SYNTHETIC), { mode: 0o600 });
    writeFileSync(orphanB, JSON.stringify(SYNTHETIC), { mode: 0o600 });
    writeFileSync(unrelated, 'not a temp file', { mode: 0o600 });
    writeFileSync(target, JSON.stringify(SYNTHETIC), { mode: 0o600 });

    const removed = await pruneOrphanTempFiles(target, silentLogger);
    check('both orphaned temp files are removed', removed === 2, String(removed));
    check('no credential temp file survives', readdirSync(dir).filter((f) => f.endsWith('.tmp')).length === 0, readdirSync(dir).join(','));
    check('the real session file is untouched', existsSync(target));
    check('unrelated files are left alone', existsSync(unrelated));
    check('pruning an absent directory is not an error', (await pruneOrphanTempFiles(path.join(root, 'no-such-dir', SESSION_FILENAME), silentLogger)) === 0);
}

// ---------------------------------------------------------------------------
console.log('\n-- session load from the CLI on-disk format --');
{
    const dir = path.join(root, 'load');
    await ensurePrivateDirectory(dir);
    writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });
    const store = new OwnedFileSessionStore(dir, silentLogger as never);
    const loaded = await store.load();
    check('loads the CLI session format', loaded?.session.uid === SYNTHETIC.session.uid);
    check('loads the Drive decryption credential (userKeyPassword)', loaded?.userKeyPassword === SYNTHETIC.userKeyPassword);
    check('loads the cache credential (cachePassword)', loaded?.cachePassword === SYNTHETIC.cachePassword);
    check('loads the refresh token', loaded?.session.refreshToken === SYNTHETIC.session.refreshToken);

    // A too-permissive session file must be tightened, not trusted silently.
    chmodSync(path.join(dir, 'auth-session.json'), 0o644);
    await store.load();
    check('tightens a 0644 session file to 0600', mode(path.join(dir, 'auth-session.json')) === 0o600);

    const emptyDir = path.join(root, 'load-empty');
    await ensurePrivateDirectory(emptyDir);
    check('missing session loads as null', (await new OwnedFileSessionStore(emptyDir, silentLogger as never).load()) === null);

    const badDir = path.join(root, 'load-bad');
    await ensurePrivateDirectory(badDir);
    writeFileSync(path.join(badDir, 'auth-session.json'), '{"session":{"uid":"x"}}', { mode: 0o600 });
    check('incomplete session loads as null (treated as logged out)', (await new OwnedFileSessionStore(badDir, silentLogger as never).load()) === null);
}

// ---------------------------------------------------------------------------
console.log('\n-- token refresh through the real ApiClient --');
{
    const dir = path.join(root, 'refresh');
    await ensurePrivateDirectory(dir);
    writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });

    let refreshCalls = 0;
    let protectedCalls = 0;
    const seenAppVersions: string[] = [];
    const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
            const url = new URL(req.url);
            seenAppVersions.push(req.headers.get('x-pm-appversion') ?? '');
            if (url.pathname === '/auth/v4/refresh') {
                refreshCalls++;
                const body = (await req.json()) as { RefreshToken?: string };
                if (body.RefreshToken !== 'synthetic-refresh-token-initial') {
                    return Response.json({ Code: 10013, Error: 'Invalid refresh token' }, { status: 422 });
                }
                return Response.json({
                    Code: 1000,
                    UID: SYNTHETIC.session.uid,
                    AccessToken: 'synthetic-access-token-REFRESHED',
                    RefreshToken: 'synthetic-refresh-token-REFRESHED',
                });
            }
            // Protected resource: reject the stale token once, accept the refreshed one.
            protectedCalls++;
            const auth = req.headers.get('Authorization');
            if (auth === 'Bearer synthetic-access-token-initial') {
                return Response.json({ Code: 401, Error: 'Unauthorized' }, { status: 401 });
            }
            if (auth === 'Bearer synthetic-access-token-REFRESHED') {
                return Response.json({ Code: 1000, ok: true });
            }
            return Response.json({ Code: 401, Error: `Unexpected token: ${auth}` }, { status: 401 });
        },
    });
    const baseUrl = `http://localhost:${server.port}`;

    const store = new OwnedFileSessionStore(dir, silentLogger as never);
    const credentials = new Credentials(store, silentLogger as never);
    const apiClient = new ApiClient({
        baseUrl,
        appVersion: 'external-drive-rclone@0.1.0-test',
        credentials,
        logger: silentLogger as never,
    });
    await credentials.load();
    check('session considered logged in after load', credentials.isLoggedIn());

    const resp = await apiClient.authenticatedRequest.get(`${baseUrl}/drive/v2/volumes`, { throwHttpErrors: false });
    check('request succeeds after transparent refresh', resp.status === 200, `status ${resp.status}`);
    check('refresh endpoint was called exactly once', refreshCalls === 1, `calls: ${refreshCalls}`);
    check('protected resource was retried after refresh', protectedCalls === 2, `calls: ${protectedCalls}`);
    check('app version identifies this client honestly', seenAppVersions.every((v) => v.startsWith('external-drive-rclone@')), seenAppVersions.join(','));

    const persisted = JSON.parse(readFileSync(path.join(dir, 'auth-session.json'), 'utf8')) as typeof SYNTHETIC;
    check('refreshed access token persisted to disk', persisted.session.accessToken === 'synthetic-access-token-REFRESHED');
    check('rotated refresh token persisted to disk', persisted.session.refreshToken === 'synthetic-refresh-token-REFRESHED');
    check('Drive decryption credential preserved across refresh', persisted.userKeyPassword === SYNTHETIC.userKeyPassword);
    check('cache credential preserved across refresh', persisted.cachePassword === SYNTHETIC.cachePassword);
    check('session file still 0600 after refresh', mode(path.join(dir, 'auth-session.json')) === 0o600);

    // A restart must pick the refreshed tokens up from disk.
    const reloaded = await new OwnedFileSessionStore(dir, silentLogger as never).load();
    check('restart reloads the refreshed session', reloaded?.session.accessToken === 'synthetic-access-token-REFRESHED');

    server.stop(true);
}

// ---------------------------------------------------------------------------
console.log('\n-- expired / revoked session --');
{
    const dir = path.join(root, 'revoked');
    await ensurePrivateDirectory(dir);
    writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });

    const server = Bun.serve({
        port: 0,
        fetch: (req) => {
            const url = new URL(req.url);
            if (url.pathname === '/auth/v4/refresh') {
                // Definitive rejection: the account layer signs out on 4xx != 429.
                return Response.json({ Code: 10013, Error: 'Refresh token invalid or revoked' }, { status: 400 });
            }
            return Response.json({ Code: 401, Error: 'Unauthorized' }, { status: 401 });
        },
    });
    const baseUrl = `http://localhost:${server.port}`;
    const store = new OwnedFileSessionStore(dir, silentLogger as never);
    const credentials = new Credentials(store, silentLogger as never);
    const apiClient = new ApiClient({ baseUrl, appVersion: 'external-drive-rclone@0.1.0-test', credentials, logger: silentLogger as never });
    await credentials.load();

    const resp = await apiClient.authenticatedRequest.get(`${baseUrl}/drive/v2/volumes`, { throwHttpErrors: false });
    check('rejected refresh surfaces as 401 (not a false success)', resp.status === 401, `status ${resp.status}`);
    check('credentials report logged out in memory', !credentials.isLoggedIn());
    // The account layer signs out on ANY 4xx except 429 from the refresh endpoint,
    // with no retry, so that signal is NOT proof the session is dead. Destroying
    // the file on it would lose a working session to a captive-portal 403.
    check(
        'the session file is PRESERVED, not deleted or renamed away',
        existsSync(path.join(dir, 'auth-session.json')),
        readdirSync(dir).join(','),
    );
    const preserved = JSON.parse(readFileSync(path.join(dir, 'auth-session.json'), 'utf8')) as typeof SYNTHETIC;
    check('the preserved session is byte-intact', preserved.session.refreshToken === SYNTHETIC.session.refreshToken);
    check('a reload still finds the session usable', (await new OwnedFileSessionStore(dir, silentLogger as never).load()) !== null);

    const markers = readdirSync(dir).filter((f) => f.startsWith('auth-session.signout-'));
    check('a sign-out marker is recorded', markers.length === 1, readdirSync(dir).join(','));
    if (markers[0]) {
        check('the marker is owner-only 0600', mode(path.join(dir, markers[0])) === 0o600);
        const raw = readFileSync(path.join(dir, markers[0]), 'utf8');
        check('the marker carries NO credentials', !raw.includes(SYNTHETIC.userKeyPassword) && !raw.includes(SYNTHETIC.session.refreshToken) && !raw.includes(SYNTHETIC.cachePassword), raw.slice(0, 200));
        check('the marker still identifies the session enough to correlate', raw.includes(SYNTHETIC.session.uid.slice(0, 6)));
    }
    check('no revoked-style copy of the credentials was created', readdirSync(dir).filter((f) => f.startsWith('auth-session.revoked-')).length === 0);
    server.stop(true);
}

// ---------------------------------------------------------------------------
console.log('\n-- refuses to overwrite a session another client rewrote --');
{
    // The official CLI takes no auth-session.lock, writes the file in place, and
    // runs even when events.lock is held, so it can become a second refresher of
    // the same rotating token. Overwriting its newer tokens would invalidate them.
    const dir = path.join(root, 'foreign-writer');
    await ensurePrivateDirectory(dir);
    writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });
    const store = new OwnedFileSessionStore(dir, silentLogger as never);
    const loaded = await store.load();
    check('session loads before the interloper writes', loaded !== null);

    // Another client rotates the token underneath us.
    const theirs = {
        ...SYNTHETIC,
        session: { ...SYNTHETIC.session, accessToken: 'their-fresh-access', refreshToken: 'their-fresh-refresh' },
    };
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(theirs), { mode: 0o600 });

    await checkThrows(
        'saving over a foreign write is refused',
        () => store.save({ ...SYNTHETIC, session: { ...SYNTHETIC.session, accessToken: 'ours' } } as never),
        (e) => e instanceof Error && e.name === 'SessionConflictError',
    );
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'auth-session.json'), 'utf8')) as typeof SYNTHETIC;
    check('the other client refresh token survives', onDisk.session.refreshToken === 'their-fresh-refresh');

    // A save with no interference must still work.
    const dir2 = path.join(root, 'sole-writer');
    await ensurePrivateDirectory(dir2);
    writeFileSync(path.join(dir2, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });
    const store2 = new OwnedFileSessionStore(dir2, silentLogger as never);
    await store2.load();
    await store2.save({ ...SYNTHETIC, session: { ...SYNTHETIC.session, accessToken: 'rotated' } } as never);
    const after = JSON.parse(readFileSync(path.join(dir2, 'auth-session.json'), 'utf8')) as typeof SYNTHETIC;
    check('an uncontended save still persists', after.session.accessToken === 'rotated');
    await store2.save({ ...SYNTHETIC, session: { ...SYNTHETIC.session, accessToken: 'rotated-again' } } as never);
    check('consecutive saves by the owner are allowed', JSON.parse(readFileSync(path.join(dir2, 'auth-session.json'), 'utf8')).session.accessToken === 'rotated-again');
}

console.log('\n-- refuses to run alongside another Proton client --');
{
    // A live holder of the CLI's events.lock means another Proton Drive client is
    // active on this data directory; starting anyway would give two processes the
    // same rotating session.
    const dir = path.join(root, 'concurrent');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });
    // Our own pid is definitely alive, so this stands in for a running CLI.
    writeFileSync(path.join(dir, 'events.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });

    const cliDir = path.join(import.meta.dir, '..');
    const run = (extraEnv: Record<string, string>) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
            const child = spawn(process.execPath, ['run', 'src/service/serve.ts'], {
                cwd: cliDir,
                env: {
                    ...process.env,
                    PROTON_DRIVE_CACHE_DIR: dir,
                    PROTON_DRIVE_CREDENTIALS_STORE: 'unsafe_file',
                    PROTON_DRIVE_BASE_URL: 'localhost:9',
                    PROTON_WEBDAV_SOCKET: path.join(dir, 'dav.sock'),
                    ...extraEnv,
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (out += d));
            const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
            child.on('exit', (code) => {
                clearTimeout(timer);
                resolve({ code, out });
            });
        });

    const before = readdirSync(dir).sort().join(',');
    const blocked = await run({});
    check('refuses to start while another client holds events.lock', blocked.code !== 0, `exit ${blocked.code}`);
    // The refusal must be inert: nothing created in a directory another client
    // owns, not even our own client-UID file or a log.
    check(
        'the refused start left the directory byte-for-byte unchanged',
        readdirSync(dir).sort().join(',') === before,
        `before=[${before}] after=[${readdirSync(dir).sort().join(',')}]`,
    );
    check('no client-UID file was created', !existsSync(path.join(dir, 'clientUid-rclone.json')));
    check('the refusal names the holding process', /pid \d+/.test(blocked.out), blocked.out.slice(0, 200));
    check(
        'the refusal explains the concurrent client',
        /another proton drive client/i.test(blocked.out),
        blocked.out.slice(0, 300),
    );
    check('no socket created when refused', !existsSync(path.join(dir, 'dav.sock')));
    check('the other client\'s events.lock was left untouched', JSON.parse(readFileSync(path.join(dir, 'events.lock'), 'utf8')).pid === process.pid);
    check('no stale session lock left behind after the refusal', !existsSync(path.join(dir, 'auth-session.lock')), readdirSync(dir).join(','));
    check('the session file was not modified', JSON.parse(readFileSync(path.join(dir, 'auth-session.json'), 'utf8')).session.accessToken === SYNTHETIC.session.accessToken);
}

console.log('\n-- reboot leftovers must not brick an unattended start --');
{
    const spawnService = (dir: string) =>
        new Promise<{ code: number | null; out: string }>((resolve) => {
            const child = spawn(process.execPath, ['run', 'src/service/serve.ts'], {
                cwd: path.join(import.meta.dir, '..'),
                env: {
                    ...process.env,
                    PROTON_DRIVE_CACHE_DIR: dir,
                    PROTON_DRIVE_CREDENTIALS_STORE: 'unsafe_file',
                    PROTON_DRIVE_BASE_URL: 'localhost:9',
                    PROTON_WEBDAV_SOCKET: path.join(dir, 'dav.sock'),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (out += d));
            const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
            child.on('exit', (code) => {
                clearTimeout(timer);
                resolve({ code, out });
            });
        });
    // Both cases below still FAIL overall -- the API is unreachable at
    // localhost:9 -- so each assertion is about WHY, not about success.
    const concurrentRefusal = /another Proton client|concurrent/i;

    // A power loss leaves events.lock holding this service's own old pid. After a
    // reboot pids restart from 1, so that pid may well be live again as something
    // unrelated, and a pid-only check then refuses every start forever.
    {
        const dir = path.join(root, 'preboot-events-lock');
        mkdirSync(dir, { mode: 0o700 });
        writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });
        const lock = path.join(dir, 'events.lock');
        writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
        const preBoot = new Date(Date.now() - (os.uptime() + 3600) * 1000);
        utimesSync(lock, preBoot, preBoot);
        const r = await spawnService(dir);
        check('an events.lock predating this boot does not refuse startup', !concurrentRefusal.test(r.out), r.out.slice(0, 300));
        // The stale file IS removed, deliberately: nothing can hold a lock written
        // before the current boot, and leaving it would let the CLI's pid-only
        // check refuse every subsequent start. A lock may exist again afterwards
        // because the events provider then took its own -- but it must be a fresh
        // one, not the pre-boot leftover.
        const after = existsSync(lock) ? statSync(lock) : null;
        check(
            'the pre-boot leftover is gone (any lock present now belongs to this boot)',
            after === null || after.mtimeMs > Date.now() - os.uptime() * 1000,
            after ? `mtime ${new Date(after.mtimeMs).toISOString()}` : 'absent',
        );
    }

    // A truncated clientUid-rclone.json used to throw a SyntaxError, which has no
    // .code, so the "not ENOENT" rethrow refused to start the service at all.
    {
        const dir = path.join(root, 'broken-clientuid');
        mkdirSync(dir, { mode: 0o700 });
        writeFileSync(path.join(dir, 'auth-session.json'), JSON.stringify(SYNTHETIC), { mode: 0o600 });
        writeFileSync(path.join(dir, 'clientUid-rclone.json'), '{"clientUid": "external-dri', { mode: 0o600 });
        const r = await spawnService(dir);
        check('a truncated client-UID file does not abort startup with a parse error', !/SyntaxError|JSON Parse|Unexpected end of JSON/i.test(r.out), r.out.slice(0, 300));
        const rewritten = readFileSync(path.join(dir, 'clientUid-rclone.json'), 'utf8');
        check('the rewritten file is valid and correctly prefixed', (JSON.parse(rewritten) as { clientUid: string }).clientUid.startsWith('external-drive-rclone-'));
        check('the client-UID file stays 0600', mode(path.join(dir, 'clientUid-rclone.json')) === 0o600);
    }
}

console.log('\n-- unavailable keyring --');
{
    // With credentials store = keychain and no D-Bus session, the service must
    // fail fast with a clear message and must not fall back to plaintext.
    const dir = path.join(root, 'keyring');
    mkdirSync(dir, { mode: 0o700 });
    const cliDir = path.join(import.meta.dir, '..');
    let timedOut = false;
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ['run', 'src/service/serve.ts'], {
            cwd: cliDir,
            env: {
                ...process.env,
                PROTON_DRIVE_CACHE_DIR: dir,
                PROTON_DRIVE_CREDENTIALS_STORE: 'keychain',
                PROTON_WEBDAV_SOCKET: path.join(dir, 'dav.sock'),
                DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/pd-test-bus',
                XDG_RUNTIME_DIR: dir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        // Record whether we had to kill it: a hang must not count as a pass.
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, 45_000);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, out });
        });
    });
    check('service did not hang waiting on an unavailable keyring', !timedOut, 'process had to be killed');
    // A killed process reports code null, which the previous form accepted as
    // "non-zero" -- so a hang, or a crash for an unrelated reason, passed.
    check(
        'service exits with a deliberate non-zero status',
        typeof result.code === 'number' && result.code !== 0,
        `exit ${result.code}`,
    );
    check(
        'failure names the secret store specifically',
        /secret|keyring|keychain/i.test(result.out),
        result.out.slice(0, 400),
    );
    check('no socket was created on failed startup', !existsSync(path.join(dir, 'dav.sock')));
    check('no plaintext session was written as a fallback', !existsSync(path.join(dir, 'auth-session.json')), readdirSync(dir).join(','));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
