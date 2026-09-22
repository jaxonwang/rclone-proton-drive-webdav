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
import { chmodSync, existsSync, unlinkSync } from 'node:fs';

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

const gateway = new MockGateway(clientUid);
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
    fetch: (req, srv) => {
        srv.timeout(req, 0);
        return handleRequest(req, gateway, { immutable, allowOverrideDraftForPath: overrideDraftPath, logger, guard });
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
        switch (url.pathname) {
            case '/seed-file':
                gateway.seedFile(
                    String(body.path),
                    String(body.content ?? ''),
                    body.mtime ? new Date(String(body.mtime)) : undefined,
                );
                return Response.json({ ok: true });
            case '/seed-draft':
                gateway.seedDraft(String(body.path), String(body.clientUid));
                return Response.json({ ok: true });
            case '/faults':
                Object.assign(gateway.faults, body);
                return Response.json({ ok: true, faults: gateway.faults });
            case '/snapshot':
                return Response.json({ tree: gateway.snapshot(), calls: gateway.calls });
            case '/reset-calls':
                gateway.calls.length = 0;
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
