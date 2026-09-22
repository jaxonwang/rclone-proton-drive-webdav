/**
 * Service bootstrap. Mirrors cli/src/init.ts (same wiring of the account
 * module, HTTP client, caches, events and ProtonDriveClient) with the two
 * differences a persistent daemon needs:
 *
 *  1. Credentials come from OwnedFileSessionStore (single-writer lock, atomic
 *     0600 persistence, quarantine-on-revoke) when the configured store is
 *     `unsafe_file`. `keychain` and `pass` reuse the CLI stores unchanged.
 *  2. The account API client is returned so the service can answer quota
 *     queries (`/core/v4/users`) that the Drive SDK itself does not expose.
 *
 * Client identity: the same `clientUidPrefix` as the official CLI is used so
 * the existing `clientUid.json` is reused. The SDK relies on this UID to
 * recognise the client's own unfinished uploads (drafts) and recover them; a
 * different UID would orphan every draft the CLI left behind. Application
 * identity (`x-pm-appversion`) is separate and set honestly to
 * `external-drive-rclone@...` as required by Proton's SDK usage guidelines.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { FeatureFlags, type Logger, OpenPGPCryptoWithCryptoProxy, ProtonDriveClient } from '@protontech/drive-sdk';
import { ProtonDrivePhotosClient } from '@protontech/drive-sdk/protonDrivePhotosClient';

import { initApi } from '../api';
import { createCaches } from '../cache';
import { Paths } from '../cli';
import { type Config, CredentialsStoreType, getConfig, type InitConfig } from '../config';
import { Credentials } from '../credentials/credentials';
import type { CredentialsStore } from '../credentials/interface';
import { PassSessionStore } from '../credentials/passCredentialsStore';
import { SecretsSessionStore } from '../credentials/secretCredentialsStore';
import { Manager, NoEventsProvider, PersistedEventsProvider } from '../events';
import { disableSentry, initTelemetry } from '../telemetry';
import {
    acquireSessionOwnership,
    CLI_EVENTS_LOCK_FILENAME,
    ensurePrivateDirectory,
    findActiveProtonClient,
    OwnedFileSessionStore,
    writePrivateFileAtomic,
} from './sessionStore';

/**
 * This service's own client-UID prefix, deliberately NOT the CLI's `sdk-js-cli`.
 *
 * The client UID is what the SDK uses to decide whether an unfinished upload
 * (draft) belongs to the caller: a matching UID means the draft is deleted and
 * the upload resumed, with no consent gate. Sharing the CLI's UID would
 * therefore let this service silently destroy drafts belonging to a running or
 * recently-stopped CLI -- including the in-flight uploads of a long backup.
 *
 * With a distinct UID, only uploads this service started are auto-recovered, and
 * a CLI draft is treated like any other client's: replaced only with explicit,
 * path-scoped consent. The UID is persisted so it survives restarts.
 */
export const CLIENT_UID_PREFIX = 'external-drive-rclone';

/**
 * Separate from the CLI's `clientUid.json`. The CLI's helper regenerates and
 * OVERWRITES that file whenever the stored UID does not match the expected
 * prefix, which would change the CLI's identity and orphan every draft it owns.
 */
const SERVICE_CLIENT_UID_FILE = 'clientUid-rclone.json';

export type ServiceSession = Awaited<ReturnType<typeof bootstrapService>>;

/** How long to wait for the credentials store before giving up (locked keyring). */
const CREDENTIAL_LOAD_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/** Raised when another Proton Drive client is already active on the data directory. */
export class ConcurrentClientError extends Error {
    name = 'ConcurrentClientError';
}

class StaticFeatureFlagProvider {
    constructor(private readonly flags: Record<string, boolean>) {}
    isEnabled(flagName: FeatureFlags): Promise<boolean> {
        return Promise.resolve(this.flags[flagName] ?? false);
    }
}

export async function bootstrapService(initOptions: InitConfig) {
    const config = getConfig(initOptions);

    // Check for another active Proton client FIRST, before creating directories,
    // opening the log, generating a client UID or taking any lock. A refused
    // startup has to be inert: it must not leave a single file behind in a data
    // directory that belongs to a running client.
    const activeClientPid = await findActiveProtonClient(config.appDir);
    if (activeClientPid !== null && process.env.PROTON_WEBDAV_ALLOW_CONCURRENT_CLIENT !== '1') {
        throw new ConcurrentClientError(
            `Another Proton Drive client (pid ${activeClientPid}) is using ${config.appDir} right now ` +
                `(it holds ${CLI_EVENTS_LOCK_FILENAME}). Running both would make two processes refresh and ` +
                `rewrite the same session. Wait for it to finish, or set ` +
                `PROTON_WEBDAV_ALLOW_CONCURRENT_CLIENT=1 to override.`,
        );
    }

    await Promise.all([
        mkdir(config.cacheDir, { recursive: true }),
        mkdir(config.appDir, { recursive: true }),
        mkdir(config.logDir, { recursive: true }),
    ]);

    const { telemetry, flush: flushTelemetry } = initTelemetry(config);
    const logger = telemetry.getLogger('service');
    logger.info(`Version: service=${initOptions.appVersion}, SDK=${initOptions.sdkVersion ?? 'unknown'}`);
    // This build never has a Sentry DSN; make the intent explicit.
    disableSentry();

    const releaseOwnership = await acquireCredentialStoreOwnership(config, logger);
    let started = false;
    // Any failure after the lock is taken must hand it back, or a failed start
    // leaves a lock the next run has to guess about.
    const abortStartup = async (error: unknown): Promise<never> => {
        if (!started) {
            await releaseOwnership().catch(() => {});
        }
        throw error;
    };
    const credentialsStore = createCredentialsStore(config, logger);
    const credentials = new Credentials(credentialsStore, logger);

    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), (endpoint) => endpoint.clearKeyStore());
    const openPGPCryptoModule = new OpenPGPCryptoWithCryptoProxy(CryptoProxy);

    // initApi loads the session, which for the keychain store goes through
    // libsecret. A present-but-LOCKED keyring can block on an unlock prompt that
    // no background service will ever answer, so startup would hang forever
    // holding the lock instead of failing with something actionable.
    const { auth, addresses, srp, httpClient, apiClient } = await withTimeout(
        initApi(config, credentials, logger, CryptoProxy),
        CREDENTIAL_LOAD_TIMEOUT_MS,
        `Timed out after ${CREDENTIAL_LOAD_TIMEOUT_MS / 1000}s loading credentials from the ` +
            `'${config.credentialsStore}' store. If it is the OS keyring, it is probably locked and ` +
            `waiting for an interactive unlock: unlock it, or use a store that does not prompt.`,
    ).catch(abortStartup);

    const clientUid = await getOrGenerateServiceClientUid(config.appDir, logger);
    const caches = createCaches(config, credentials, logger);
    const eventsProvider = config.enablePersistedEvents
        ? await PersistedEventsProvider.open(logger, config.appDir)
        : new NoEventsProvider();
    if (config.enablePersistedEvents && !eventsProvider.canListenForEvents()) {
        // events.lock is the official CLI's own mutual-exclusion file: every CLI
        // invocation holds it for its lifetime (cli/src/events/lock.ts). A live
        // holder therefore means another Proton Drive client is active on this
        // data directory right now.
        //
        // That matters beyond events. This service's own auth-session.lock only
        // excludes other instances of THIS service -- the official CLI does not
        // take it -- so without this check the two would both refresh and rewrite
        // the same session file, and both write the same sqlite caches. Proton
        // rotates the refresh token on use, so the loser of that race is left
        // holding a token that no longer works.
        //
        // Backstop for the narrow race where a client started between the check
        // at the top of this function and opening the provider here.
        await eventsProvider.dispose();
        if (process.env.PROTON_WEBDAV_ALLOW_CONCURRENT_CLIENT !== '1') {
            return abortStartup(
                new ConcurrentClientError(
                `Another Proton Drive client is using ${config.appDir} right now (its events.lock is held by a live process). ` +
                    `Running both would make two processes refresh and rewrite the same session. ` +
                        `Wait for it to finish, or set PROTON_WEBDAV_ALLOW_CONCURRENT_CLIENT=1 to override.`,
                ),
            );
        }
        logger.warn(
            'Another Proton Drive client holds events.lock; continuing because ' +
                'PROTON_WEBDAV_ALLOW_CONCURRENT_CLIENT=1. Event subscriptions are disabled and ' +
                'credential updates may race with that client.',
        );
    }

    const sdkDependencies = {
        config: { baseUrl: config.baseUrl, clientUid },
        httpClient,
        entitiesCache: caches.entitiesCache,
        cryptoCache: caches.cryptoCache,
        telemetry,
        openPGPCryptoModule,
        account: addresses,
        srpModule: srp,
        latestEventIdProvider: eventsProvider,
        featureFlagProvider: new StaticFeatureFlagProvider(initOptions.flags ?? {}),
    };
    const sdk = new ProtonDriveClient(sdkDependencies);
    const photosSdk = new ProtonDrivePhotosClient(sdkDependencies);
    const eventsManager = await Manager.create(logger, sdk, photosSdk, eventsProvider, auth.isLoggedIn());
    const paths = new Paths(sdk, photosSdk, auth, eventsManager);
    started = true;

    return {
        config,
        logger: logger as Logger,
        auth,
        credentials,
        apiClient,
        sdk,
        paths,
        eventsManager,
        clientUid,
        dispose: async () => {
            await Promise.allSettled([flushTelemetry(), eventsManager.dispose()]);
            await releaseOwnership();
        },
    };
}

/**
 * Read, or create once, this service's persistent client UID. Stored 0600 in its
 * own file so the CLI's clientUid.json is never read or written.
 */
async function getOrGenerateServiceClientUid(appDir: string, logger: Logger): Promise<string> {
    const file = path.join(appDir, SERVICE_CLIENT_UID_FILE);
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8')) as { clientUid?: unknown };
        if (typeof parsed.clientUid === 'string' && parsed.clientUid.startsWith(`${CLIENT_UID_PREFIX}-`)) {
            logger.debug(`Using existing service client UID`);
            return parsed.clientUid;
        }
        logger.warn(`Ignoring malformed ${SERVICE_CLIENT_UID_FILE}; generating a new client UID`);
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
    const clientUid = `${CLIENT_UID_PREFIX}-${randomUUID()}`;
    await writePrivateFileAtomic(file, `${JSON.stringify({ clientUid }, null, 2)}\n`);
    logger.info(`Generated a new service client UID`);
    return clientUid;
}

/**
 * Take the single-writer lock for EVERY credentials store.
 *
 * The lock is about who may rewrite the session, and that applies just as much to
 * the keyring and to pass as to a plaintext file -- Proton rotates the refresh
 * token on use, so two processes refreshing the same session leave one of them
 * holding a dead token regardless of where it is stored. Skipping the lock for
 * the default store also broke an assumption made at startup, where a stale
 * socket is removed on the strength of the lock proving no live owner exists.
 * The lock file itself contains no secret.
 */
async function acquireCredentialStoreOwnership(config: Config, logger: Logger): Promise<() => Promise<void>> {
    await ensurePrivateDirectory(config.appDir, logger);
    return acquireSessionOwnership(config.appDir, logger);
}

function createCredentialsStore(config: Config, logger: Logger): CredentialsStore {
    switch (config.credentialsStore) {
        case CredentialsStoreType.UnsafeFile:
            return new OwnedFileSessionStore(config.appDir, logger);
        case CredentialsStoreType.Pass:
            return new PassSessionStore(logger);
        case CredentialsStoreType.Keychain:
            return new SecretsSessionStore(logger);
        default:
            throw new Error(`Invalid credentials store: ${config.credentialsStore}`);
    }
}
