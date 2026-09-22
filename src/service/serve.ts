/**
 * Entry point: persistent WebDAV service over the Proton Drive SDK.
 *
 * Listens on a Unix domain socket (0600, current user only). rclone must be
 * configured as:
 *
 *     type = webdav
 *     url = http://localhost/
 *     vendor = nextcloud
 *     nextcloud_chunk_size = 0
 *     unix_socket = <PROTON_WEBDAV_SOCKET>
 *
 * `vendor = nextcloud` is required, not cosmetic: with `owncloud` rclone
 * advertises MD5 as well as SHA-1, picks MD5 for --checksum, and since Proton has
 * no MD5 the comparison silently degrades to "hashes could not be checked".
 * `nextcloud_chunk_size = 0` disables rclone's chunked-upload protocol, which
 * this service does not implement. See webdav.ts for the full rationale.
 *
 * Environment (all optional unless noted):
 *   PROTON_DRIVE_CACHE_DIR           CLI data dir (session, caches, clientUid, events). Default: XDG paths.
 *   PROTON_DRIVE_CREDENTIALS_STORE   unsafe_file | keychain | pass (same as the CLI).
 *   PROTON_DRIVE_LOG_LEVEL           DEBUG | INFO | WARNING | ERROR (default WARNING here).
 *   PROTON_DRIVE_BASE_URL            API host (tests point this at a mock).
 *   PROTON_WEBDAV_SOCKET             Socket path. Default: $XDG_RUNTIME_DIR/proton-drive-webdav.sock
 *   PROTON_WEBDAV_ROOT               Proton path served as "/". Default: /my-files
 *   PROTON_WEBDAV_IMMUTABLE          "1" (default) refuses overwriting existing content; "0" creates revisions.
 *   PROTON_WEBDAV_OVERRIDE_DRAFT_PATH  Exact WebDAV path for which replacing ANOTHER client's
 *                                    unfinished draft is authorised. Unset = never.
 */
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { FeatureFlags } from '@protontech/drive-sdk';

import { bootstrapService, CLIENT_UID_PREFIX } from './bootstrap';
import { OverwriteGuard } from './overwriteGuard';
import { SdkGateway } from './sdkGateway';
import { handleRequest } from './webdav';

declare const APP_VERSION: string;
declare const SDK_VERSION: string | undefined;

/** How long to let in-flight transfers finish on shutdown before giving up. */
const SHUTDOWN_DRAIN_MS = 30_000;

const appVersion = typeof APP_VERSION === 'string' ? APP_VERSION : 'external-drive-rclone@0.0.0-dev';
const sdkVersion = typeof SDK_VERSION === 'string' ? SDK_VERSION : undefined;

function envFlag(name: string, defaultValue: boolean): boolean {
    const v = process.env[name];
    if (v === undefined || v === '') {
        return defaultValue;
    }
    return ['1', 'true', 'yes', 'y'].includes(v.toLowerCase());
}

function defaultSocketPath(): string {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (runtime) {
        return path.join(runtime, 'proton-drive-webdav.sock');
    }
    return path.join(process.env.HOME ?? '/tmp', '.proton-drive-webdav.sock');
}

/**
 * A response body that fails mid-transfer must never take the daemon down.
 *
 * When a download fails after the HTTP response has already started (Proton
 * connection dropped, integrity check failed at the end of the stream, a short
 * read), the only correct wire behaviour is to error the body so the client sees
 * a truncated transfer and retries -- silently sending a short body as a success
 * would corrupt data. Erroring the stream surfaces in Bun as an asynchronous
 * error that is NOT routed through Bun.serve's `error` callback, and would
 * otherwise terminate the process. Observed in testing: a single interrupted
 * download killed the service, after which every later request failed with
 * "connection refused".
 *
 * These handlers log and keep serving. They are deliberately last-resort: real
 * per-request failures are still mapped to HTTP status codes in handleRequest.
 */
function installLastResortErrorHandlers(log: { error: (m: string, e?: unknown) => void }): void {
    process.on('uncaughtException', (error) => {
        log.error('Uncaught exception (service continues)', error);
    });
    process.on('unhandledRejection', (reason) => {
        log.error('Unhandled rejection (service continues)', reason);
    });
}

async function main(): Promise<void> {
    // Everything this process creates holds or describes credentials: the state
    // directory, the log file, the cache databases and the socket. Set the mask
    // before any of them exist rather than chmod-ing afterwards, which always
    // leaves a window.
    process.umask(0o077);
    if (!process.env.PROTON_DRIVE_LOG_LEVEL) {
        process.env.PROTON_DRIVE_LOG_LEVEL = 'WARNING';
    }
    const socketPath = process.env.PROTON_WEBDAV_SOCKET || defaultSocketPath();
    const rootPath = process.env.PROTON_WEBDAV_ROOT || '/my-files';
    const immutable = envFlag('PROTON_WEBDAV_IMMUTABLE', true);
    const overridePath = process.env.PROTON_WEBDAV_OVERRIDE_DRAFT_PATH || undefined;

    // Installed before the session exists so startup crashes are logged too.
    installLastResortErrorHandlers({ error: (m, e) => console.error(`${m}:`, e) });

    const session = await bootstrapService({
        clientUidPrefix: CLIENT_UID_PREFIX,
        appVersion,
        sdkVersion,
        enablePersistedEvents: true,
        enableMetrics: false,
        flags: { [FeatureFlags.DriveSmallFileUpload]: true },
    });
    const log = session.logger;

    if (!session.auth.isLoggedIn()) {
        console.error(
            `No usable session in ${session.config.appDir}. Authenticate with the official CLI ` +
                `(same PROTON_DRIVE_CACHE_DIR and PROTON_DRIVE_CREDENTIALS_STORE) and restart.`,
        );
        await session.dispose();
        process.exit(3);
    }

    // Anything that throws from here on must hand back the credential lock,
    // otherwise a failed start leaves auth-session.lock behind and the next run
    // has to treat it as stale -- the exact situation the lock's staleness
    // handling has to guess about.
    const failStartup = async (error: unknown): Promise<never> => {
        await session.dispose().catch(() => {});
        throw error;
    };

    const gateway = new SdkGateway(session, { rootPath });
    const guard = new OverwriteGuard();

    try {
    if (existsSync(socketPath)) {
        // Only ever remove a stale SOCKET. The ownership lock has already
        // established that no other live instance owns this data directory, but
        // the configured path could still point at something else entirely, and
        // deleting that would be destructive.
        const existing = lstatSync(socketPath);
        if (!existing.isSocket()) {
            throw new Error(
                `PROTON_WEBDAV_SOCKET path exists and is not a socket: ${socketPath}. Refusing to remove it.`,
            );
        }
        unlinkSync(socketPath);
    }
    } catch (error: unknown) {
        return failStartup(error);
    }

    let server;
    try {
    server = Bun.serve({
        unix: socketPath,
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        fetch: (req, srv) => {
            // Uploads/downloads can legitimately take minutes: disable idle timeout per request.
            srv.timeout(req, 0);
            return handleRequest(req, gateway, {
                immutable,
                allowOverrideDraftForPath: overridePath ? overridePath : undefined,
                logger: log,
                guard,
            });
        },
        error: (err) => {
            log.error('HTTP handler crashed', err);
            return new Response(null, { status: 500 });
        },
    });
    chmodSync(socketPath, 0o600);
    } catch (error: unknown) {
        return failStartup(error);
    }

    // Re-install against the real logger now that telemetry is up.
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
    installLastResortErrorHandlers(log);

    console.log(`proton-drive-webdav listening on unix:${socketPath}`);
    console.log(`root=${rootPath} immutable=${immutable} override_draft_path=${overridePath ?? '(none)'}`);
    console.log(`state dir=${session.config.appDir} client_uid_prefix=${CLIENT_UID_PREFIX}`);

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) {
            console.log(`received ${signal} again, stopping immediately`);
            server.stop(true);
            process.exit(1);
        }
        shuttingDown = true;
        console.log(`received ${signal}, draining in-flight transfers (send again to stop now)`);
        // stop(false) stops accepting new connections but lets active uploads and
        // downloads finish; forcing them closed would abandon an upload partway
        // and leave a draft behind for no reason.
        const drained = server.stop(false);
        const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));
        await Promise.race([Promise.resolve(drained), deadline]);
        try {
            await gateway.close();
        } finally {
            try {
                unlinkSync(socketPath);
            } catch {
                // already gone
            }
            process.exit(0);
        }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`proton-drive-webdav failed to start: ${message}`);
    process.exit(1);
});
