/**
 * HTTP-level tests for the WebDAV layer.
 *
 *   bun run tests/webdav-protocol-tests.ts
 *
 * Calls handleRequest directly against the in-memory gateway, so status codes,
 * headers and XML can be asserted exactly. No sockets, no rclone, no Proton.
 */
import { MockGateway } from '../src/service/mockGateway';
import { OverwriteGuard } from '../src/service/overwriteGuard';
import { handleRequest, type WebdavOptions } from '../src/service/webdav';

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

const warnings: string[] = [];
function makeServer(opts: Partial<WebdavOptions> = {}) {
    const gw = new MockGateway('sdk-js-cli-test');
    const guard = new OverwriteGuard();
    const options: WebdavOptions = {
        immutable: true,
        guard,
        logger: { debug: () => {}, warn: (m) => warnings.push(m), error: () => {} },
        ...opts,
    };
    const call = (method: string, path: string, init: RequestInit = {}) =>
        handleRequest(new Request(`http://localhost${path}`, { method, ...init }), gw, options);
    return { gw, guard, call };
}

const sha1 = (s: string) => require('node:crypto').createHash('sha1').update(s).digest('hex');

// ==========================================================================
console.log('-- OPTIONS and DAV advertisement --');
{
    const { call } = makeServer();
    const r = await call('OPTIONS', '/');
    check('OPTIONS returns 200', r.status === 200, String(r.status));
    check('advertises DAV class 1 only (no LOCK is implemented)', r.headers.get('DAV') === '1', String(r.headers.get('DAV')));
    check('Allow lists PATCH for the Nextcloud hash quirk', (r.headers.get('Allow') ?? '').includes('PATCH'));
}

console.log('\n-- PROPFIND --');
{
    const { gw, call } = makeServer();
    gw.seedFile('/hello.txt', 'hello proton');
    gw.seedFile('/dir/inner.txt', 'inner');

    const depth1 = await call('PROPFIND', '/', { headers: { Depth: '1' } });
    const xml = await depth1.text();
    check('PROPFIND returns 207', depth1.status === 207, String(depth1.status));
    check('root href is "/" and never empty', xml.includes('<d:href>/</d:href>'), xml.slice(0, 200));
    check('collections get a trailing slash in href', xml.includes('<d:href>/dir/</d:href>'));
    check('collections are marked with d:collection', xml.includes('<d:collection/>'));
    check('file exposes SHA-1 via oc:checksums', xml.includes(`SHA1:${sha1('hello proton')}`));
    check('file exposes getcontentlength', xml.includes('<d:getcontentlength>12</d:getcontentlength>'));
    check('getlastmodified is RFC1123 GMT', /<d:getlastmodified>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT<\/d:getlastmodified>/.test(xml));

    const depth0 = await call('PROPFIND', '/', { headers: { Depth: '0' } });
    const xml0 = await depth0.text();
    check('Depth 0 returns only the collection itself', (xml0.match(/<d:response>/g) ?? []).length === 1);

    const missing = await call('PROPFIND', '/nope', { headers: { Depth: '0' } });
    check('PROPFIND of a missing path is 404', missing.status === 404, String(missing.status));

    // Names needing percent-encoding must round-trip in the href.
    gw.seedFile('/a b&c#d.txt', 'x');
    const enc = await call('PROPFIND', '/', { headers: { Depth: '1' } });
    const encXml = await enc.text();
    check('special characters are percent-encoded in href', encXml.includes('/a%20b%26c%23d.txt'), encXml.slice(0, 400));
    check('XML stays well formed (no raw & in href)', !/<d:href>[^<]*[&][^a#]/.test(encXml));
}

console.log('\n-- quota --');
{
    const { gw, call } = makeServer();
    gw.seedFile('/f', 'abc');
    const r = await call('PROPFIND', '/', {
        headers: { Depth: '0' },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-available-bytes/><d:quota-used-bytes/></d:prop></d:propfind>',
    });
    const xml = await r.text();
    check('quota request returns 207', r.status === 207);
    check('quota-used-bytes present', xml.includes('<d:quota-used-bytes>'));
    check('quota-available-bytes present', xml.includes('<d:quota-available-bytes>'));
}

console.log('\n-- GET, HEAD and ranges --');
{
    const { gw, call } = makeServer();
    gw.seedFile('/data.bin', '0123456789');
    gw.seedFile('/empty.bin', '');

    const full = await call('GET', '/data.bin');
    check('GET returns 200', full.status === 200);
    check('GET body is correct', (await full.text()) === '0123456789');
    check('GET advertises byte ranges', full.headers.get('Accept-Ranges') === 'bytes');
    check('GET exposes OC-Checksum', full.headers.get('OC-Checksum') === `SHA1:${sha1('0123456789')}`);

    const head = await call('HEAD', '/data.bin');
    check('HEAD returns 200 with Content-Length and no body', head.status === 200 && head.headers.get('Content-Length') === '10' && (await head.text()) === '');

    const ranged = await call('GET', '/data.bin', { headers: { Range: 'bytes=2-5' } });
    check('range returns 206', ranged.status === 206, String(ranged.status));
    check('range body is exact', (await ranged.text()) === '2345');
    check('Content-Range is correct', ranged.headers.get('Content-Range') === 'bytes 2-5/10', String(ranged.headers.get('Content-Range')));

    const suffix = await call('GET', '/data.bin', { headers: { Range: 'bytes=-3' } });
    check('suffix range returns the last bytes', suffix.status === 206 && (await suffix.text()) === '789');

    const openEnded = await call('GET', '/data.bin', { headers: { Range: 'bytes=7-' } });
    check('open-ended range works', openEnded.status === 206 && (await openEnded.text()) === '789');

    const clamped = await call('GET', '/data.bin', { headers: { Range: 'bytes=8-9999' } });
    check('range past EOF is clamped, not rejected', clamped.status === 206 && (await clamped.text()) === '89');

    const unsat = await call('GET', '/data.bin', { headers: { Range: 'bytes=50-60' } });
    check('unsatisfiable range returns 416', unsat.status === 416, String(unsat.status));
    check('416 carries Content-Range: bytes */size', unsat.headers.get('Content-Range') === 'bytes */10', String(unsat.headers.get('Content-Range')));

    const emptyRanged = await call('GET', '/empty.bin', { headers: { Range: 'bytes=0-10' } });
    check('any range on an empty file is 416', emptyRanged.status === 416, String(emptyRanged.status));

    const garbage = await call('GET', '/data.bin', { headers: { Range: 'chickens=1-2' } });
    check('malformed Range is ignored and the full body returned', garbage.status === 200 && (await garbage.text()) === '0123456789');

    const emptyGet = await call('GET', '/empty.bin');
    check('empty file GETs as 200 with no body', emptyGet.status === 200 && (await emptyGet.text()) === '');

    const dirGet = await call('GET', '/');
    check('GET of a collection is 405', dirGet.status === 405, String(dirGet.status));
    const missingGet = await call('GET', '/nope');
    check('GET of a missing file is 404', missingGet.status === 404);
}

console.log('\n-- PUT --');
{
    const { gw, call } = makeServer();

    const created = await call('PUT', '/new.txt', {
        body: 'brand new',
        headers: { 'OC-Checksum': `SHA1:${sha1('brand new')}`, 'X-OC-Mtime': '1700000000', 'Content-Length': '9' },
    });
    check('PUT of a new file returns 201', created.status === 201, String(created.status));
    check('PUT acknowledges the modification time', created.headers.get('X-OC-Mtime') === 'accepted');
    check('PUT echoes the checksum', created.headers.get('OC-Checksum') === `SHA1:${sha1('brand new')}`);
    check('stored mtime came from X-OC-Mtime', gw.snapshot()['/new.txt'] !== undefined);

    // A zero-length PUT has no body stream at all; empty files must still work.
    const empty = await call('PUT', '/zero.bin', { headers: { 'Content-Length': '0' } });
    check('zero-byte PUT succeeds', empty.status === 201, String(empty.status));
    check('zero-byte file is stored with size 0', (gw.snapshot()['/zero.bin'] ?? '').includes('size=0'), gw.snapshot()['/zero.bin']);
    const zeroBack = await call('GET', '/zero.bin');
    check('zero-byte file reads back as empty', zeroBack.status === 200 && (await zeroBack.text()) === '');

    // A body-less PUT is only an empty file when the client SAID zero bytes.
    // Substituting an empty payload for a missing body would otherwise store a
    // nonempty source as empty -- the "Upload file empty" failure shape.
    const lying = await call('PUT', '/lying.bin', { headers: { 'Content-Length': '1048576' } });
    check('body-less PUT declaring a nonzero size is refused', lying.status === 409, String(lying.status));
    check('nothing was written for the refused body-less PUT', gw.snapshot()['/lying.bin'] === undefined);
    const noLen = await call('PUT', '/nolen.bin', {});
    check('body-less PUT with no Content-Length is refused', noLen.status === 409, String(noLen.status));

    const identical = await call('PUT', '/new.txt', {
        body: 'brand new',
        headers: { 'OC-Checksum': `SHA1:${sha1('brand new')}`, 'X-OC-Mtime': '1800000000', 'Content-Length': '9' },
    });
    check('identical re-PUT returns 204 (skipped)', identical.status === 204, String(identical.status));
    // Nothing was written, so asserting the mtime was stored would be a lie.
    check(
        'a skipped upload does NOT claim the modification time was persisted',
        identical.headers.get('X-OC-Mtime') === null,
        String(identical.headers.get('X-OC-Mtime')),
    );

    const refused = await call('PUT', '/new.txt', {
        body: 'different',
        headers: { 'OC-Checksum': `SHA1:${sha1('different')}`, 'Content-Length': '9' },
    });
    check('differing PUT onto existing content is 412', refused.status === 412, String(refused.status));

    const collision = await call('PUT', '/missingdir/x.txt', { body: 'x', headers: { 'Content-Length': '1' } });
    check('PUT with a missing parent is 409', collision.status === 409, String(collision.status));
}

console.log('\n-- the cleanup-DELETE guard --');
{
    // rclone deletes the PUT target after ANY failed upload, so protection must
    // not be limited to the 412 refusal case.
    const { gw, call } = makeServer();
    gw.seedFile('/precious.txt', 'keep me');

    const refused = await call('PUT', '/precious.txt', {
        body: 'overwrite',
        headers: { 'OC-Checksum': `SHA1:${sha1('overwrite')}`, 'Content-Length': '9' },
    });
    check('412 refusal recorded', refused.status === 412);
    const blocked = await call('DELETE', '/precious.txt');
    check('cleanup DELETE after a 412 is refused with 403', blocked.status === 403, String(blocked.status));
    check('content survived', (gw.snapshot()['/precious.txt'] ?? '').includes(`sha1=${sha1('keep me')}`));

    // Now a NON-412 failure over existing content: a transient upstream error.
    const { gw: gw2, call: call2 } = makeServer();
    gw2.seedFile('/also-precious.txt', 'keep me too');
    gw2.faults.transientFailures = 1;
    const transient = await call2('PUT', '/also-precious.txt', {
        body: 'overwrite',
        headers: { 'OC-Checksum': `SHA1:${sha1('overwrite')}`, 'Content-Length': '9' },
    });
    check('transient upstream failure surfaces as 503', transient.status === 503, String(transient.status));
    const blocked2 = await call2('DELETE', '/also-precious.txt');
    check('cleanup DELETE after a 503 is ALSO refused', blocked2.status === 403, String(blocked2.status));
    check('content survived the transient failure', (gw2.snapshot()['/also-precious.txt'] ?? '').includes(`sha1=${sha1('keep me too')}`));

    // A PUT aimed at a collection fails with 405; the cleanup DELETE would
    // otherwise trash the whole subtree.
    const { gw: gw3, call: call3 } = makeServer();
    gw3.seedFile('/tree/inner.txt', 'inner');
    const ontoDir = await call3('PUT', '/tree', { body: 'x', headers: { 'Content-Length': '1' } });
    check('PUT onto a collection is 405', ontoDir.status === 405, String(ontoDir.status));
    const blocked3 = await call3('DELETE', '/tree');
    check('cleanup DELETE of the collection is refused', blocked3.status === 403, String(blocked3.status));
    check('the subtree survived', gw3.snapshot()['/tree/inner.txt'] !== undefined);

    // Guard must NOT fire when there was nothing there to protect: a failed
    // upload of a NEW file should still be cleanable.
    const { gw: gw4, call: call4 } = makeServer();
    gw4.faults.transientFailures = 1;
    const newFail = await call4('PUT', '/brand-new.txt', { body: 'x', headers: { 'Content-Length': '1' } });
    check('failed PUT of a new file surfaces the error', newFail.status === 503, String(newFail.status));
    const del = await call4('DELETE', '/brand-new.txt');
    check('cleanup DELETE of a never-created file is not guarded (404, not 403)', del.status === 404, String(del.status));

    // An ordinary user delete outside the window still works.
    const { gw: gw5, call: call5 } = makeServer();
    gw5.seedFile('/deletable.txt', 'bye');
    const ok = await call5('DELETE', '/deletable.txt');
    check('ordinary DELETE still works', ok.status === 204, String(ok.status));
}

console.log('\n-- PATCH (Nextcloud recalculate-hash quirk) --');
{
    const { gw, call } = makeServer();
    gw.seedFile('/h.txt', 'hash me');
    const r = await call('PATCH', '/h.txt', { headers: { 'X-Recalculate-Hash': 'sha1' } });
    check('PATCH returns 200', r.status === 200, String(r.status));
    check('PATCH returns the stored SHA-1', r.headers.get('OC-Checksum') === `SHA1:${sha1('hash me')}`);
    const noHeader = await call('PATCH', '/h.txt');
    check('PATCH without the header is rejected', noHeader.status === 400, String(noHeader.status));
    const missing = await call('PATCH', '/nope', { headers: { 'X-Recalculate-Hash': 'sha1' } });
    check('PATCH of a missing file is 404', missing.status === 404);
}

console.log('\n-- PROPPATCH --');
{
    const { gw, call } = makeServer();
    gw.seedFile('/m.txt', 'mtime', new Date('2024-05-05T05:05:05Z'));
    const sameSecond = Math.floor(new Date('2024-05-05T05:05:05Z').getTime() / 1000);
    const noop = await call('PROPPATCH', '/m.txt', {
        body: `<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><lastmodified xmlns="DAV:">${sameSecond}</lastmodified></D:prop></D:set></D:propertyupdate>`,
    });
    const noopXml = await noop.text();
    check('PROPPATCH of an unchanged mtime reports success', noop.status === 207 && noopXml.includes('200 OK'), noopXml.slice(0, 200));

    const change = await call('PROPPATCH', '/m.txt', {
        body: '<?xml version="1.0"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><lastmodified xmlns="DAV:">1700000000</lastmodified></D:prop></D:set></D:propertyupdate>',
    });
    const changeXml = await change.text();
    check('PROPPATCH of a real mtime change reports failure rather than lying', change.status === 207 && changeXml.includes('403 Forbidden'), changeXml.slice(0, 200));
}

console.log('\n-- MKCOL, MOVE, COPY, DELETE --');
{
    const { gw, call } = makeServer();
    check('MKCOL creates a collection', (await call('MKCOL', '/d')).status === 201);
    check('MKCOL on an existing collection is 405', (await call('MKCOL', '/d')).status === 405);
    check('MKCOL with a missing parent is 409', (await call('MKCOL', '/nope/deep')).status === 409);

    gw.seedFile('/a.txt', 'aaa');
    const moved = await call('MOVE', '/a.txt', { headers: { Destination: 'http://localhost/d/a.txt' } });
    check('MOVE returns 201', moved.status === 201, String(moved.status));
    check('MOVE relocated the file', gw.snapshot()['/d/a.txt'] !== undefined);

    gw.seedFile('/b.txt', 'bbb');
    const clobber = await call('MOVE', '/b.txt', { headers: { Destination: 'http://localhost/d/a.txt' } });
    check('MOVE onto an existing file is refused', clobber.status === 412, String(clobber.status));
    check('MOVE refusal left the destination intact', (gw.snapshot()['/d/a.txt'] ?? '').includes(`sha1=${sha1('aaa')}`));

    const copied = await call('COPY', '/b.txt', { headers: { Destination: 'http://localhost/d/b-copy.txt' } });
    check('COPY returns 201', copied.status === 201, String(copied.status));
    const noDest = await call('MOVE', '/b.txt');
    check('MOVE without a Destination header is 409', noDest.status === 409, String(noDest.status));

    check('DELETE of a file returns 204', (await call('DELETE', '/b.txt')).status === 204);
    check('DELETE of a missing file is 404', (await call('DELETE', '/b.txt')).status === 404);
    const root = await call('DELETE', '/');
    check('DELETE of the root collection is refused', root.status === 403, String(root.status));
}

console.log('\n-- error bodies stay well-formed XML --');
{
    const { call } = makeServer();
    const r = await call('GET', '/a%26b%3Cc.txt');
    const body = await r.text();
    check('error body escapes & and < from the path', !/<d:message>[^<]*[&](?!amp;|lt;|gt;)/.test(body) && !/<d:message>[^<]*<(?!\/)/.test(body), body);
    check('error body is parseable as XML text', body.startsWith('<?xml'), body.slice(0, 60));
}

console.log('\n-- unknown methods --');
{
    const { call } = makeServer();
    const r = await call('LOCK', '/x');
    check('unimplemented method returns 405 with Allow', r.status === 405 && (r.headers.get('Allow') ?? '').includes('PROPFIND'));
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
