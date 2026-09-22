/**
 * Test harness: serve the WebDAV layer over the in-memory MockGateway on a
 * Unix socket, with an HTTP control endpoint (separate socket) for seeding
 * state and injecting faults from test scripts. No Proton, no network.
 *
 *   bun run src/service/serveMock.ts --socket /tmp/x.sock --control /tmp/x-ctl.sock [--immutable 0|1]
 *        [--override-draft-path /p] [--client-uid sdk-js-cli-mock]
 *
 * Control API (POST JSON to the control socket):
 *   /seed-file   {path, content, mtime?}      /seed-draft {path, clientUid}
 *   /faults      {transientFailures?, dropPutAfterBytes?, dropGetAfterBytes?, corruptSha1ForPath?, sessionRevoked?}
 *   /snapshot    -> {tree, calls}
 *   /reset-calls
 */
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { MockGateway } from './mockGateway';
import { OverwriteGuard } from './overwriteGuard';
import { handleRequest } from './webdav';

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const socketPath = arg('socket', '/tmp/proton-webdav-mock.sock')!;
const controlPath = arg('control', '/tmp/proton-webdav-mock-ctl.sock')!;
const immutable = (arg('immutable', '1') ?? '1') !== '0';
const overrideDraftPath = arg('override-draft-path');
const clientUid = arg('client-uid', 'sdk-js-cli-mock')!;
// --state persists the remote tree across restarts, so a simulated reboot keeps
// committed files AND drafts, the way Proton would.
const statePath = arg('state');

const gateway = new MockGateway(clientUid);
if (statePath && existsSync(statePath)) {
    gateway.restore(readFileSync(statePath, 'utf8'));
}
const persist = () => {
    if (statePath) {
        try {
            writeFileSync(statePath, gateway.serialize(), { mode: 0o600 });
        } catch (error) {
            console.error('[dav] could not persist state', error);
        }
    }
};
const guard = new OverwriteGuard();
const logger = {
    debug: (m: string) => {
        if (process.env.MOCK_DEBUG) {
            console.error(`[dav] ${m}`);
        }
    },
    warn: (m: string) => console.error(`[dav] WARN ${m}`),
    error: (m: string, e?: unknown) => console.error(`[dav] ERROR ${m}`, e),
};

for (const p of [socketPath, controlPath]) {
    if (existsSync(p)) {
        unlinkSync(p);
    }
}

// Mirror the production entry point: a stream error mid-response must not kill
// the process (see installLastResortErrorHandlers in serve.ts).
process.on('uncaughtException', (error) => console.error('[dav] uncaught (continuing)', error));
process.on('unhandledRejection', (reason) => console.error('[dav] unhandled rejection (continuing)', reason));

const dav = Bun.serve({
    unix: socketPath,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch: async (req, srv) => {
        srv.timeout(req, 0);
        const method = req.method.toUpperCase();
        try {
            return await handleRequest(req, gateway, { immutable, allowOverrideDraftForPath: overrideDraftPath, logger, guard });
        } finally {
            // Persist after anything that can change the tree, including a FAILED
            // upload: that is exactly when a draft is left behind.
            if (method !== 'GET' && method !== 'HEAD' && method !== 'PROPFIND' && method !== 'OPTIONS') {
                persist();
            }
        }
    },
    error: (err) => {
        logger.error('HTTP handler crashed', err);
        return new Response(null, { status: 500 });
    },
});
chmodSync(socketPath, 0o600);

const control = Bun.serve({
    unix: controlPath,
    fetch: async (req) => {
        const url = new URL(req.url);
        const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
        let persistAfter = false;
        switch (url.pathname) {
            case '/seed-file':
                persistAfter = true;
                gateway.seedFile(
                    String(body.path),
                    String(body.content ?? ''),
                    body.mtime ? new Date(String(body.mtime)) : undefined,
                );
                if (persistAfter) {
                    persist();
                }
                return Response.json({ ok: true });
            case '/seed-draft':
                gateway.seedDraft(String(body.path), String(body.clientUid));
                persist();
                return Response.json({ ok: true });
            case '/faults':
                Object.assign(gateway.faults, body);
                return Response.json({ ok: true, faults: gateway.faults });
            case '/snapshot':
                return Response.json({ tree: gateway.snapshot(), calls: gateway.calls, putBytes: gateway.putBytes });
            case '/reset-calls':
                gateway.calls.length = 0;
                for (const key of Object.keys(gateway.putBytes)) {
                    delete gateway.putBytes[key];
                }
                return Response.json({ ok: true });
            default:
                return new Response('unknown control endpoint', { status: 404 });
        }
    },
});
chmodSync(controlPath, 0o600);

console.log(`mock webdav on unix:${socketPath} control on unix:${controlPath} immutable=${immutable} clientUid=${clientUid}`);

const shutdown = () => {
    dav.stop(true);
    control.stop(true);
    for (const p of [socketPath, controlPath]) {
        try {
            unlinkSync(p);
        } catch {
            // ignore
        }
    }
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
