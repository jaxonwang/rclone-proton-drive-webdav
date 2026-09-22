/**
 * WebDAV PROPFIND multistatus rendering with the ownCloud checksum/permission
 * extensions that rclone's `vendor = owncloud` backend understands.
 *
 * rclone derives a node's name from the <d:href> (not <d:displayname>), reads
 * size from <d:getcontentlength>, mtime from <d:getlastmodified> (RFC1123 GMT),
 * folder-ness from <d:resourcetype><d:collection/>, and SHA-1 from
 * <oc:checksums><oc:checksum>SHA1:hex</oc:checksum>. See rclone
 * backend/webdav (owncloudProps / setMetaData / Prop.Hashes).
 */
import type { DriveEntry } from './gateway';
import { encodeHref } from './paths';

function xmlEscape(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** RFC1123 in GMT, e.g. "Mon, 02 Jan 2006 15:04:05 GMT". */
function httpDate(d: Date): string {
    return d.toUTCString();
}

/**
 * One <d:response> block. `href` is the WebDAV-space path (will be
 * percent-encoded); directories get a trailing slash.
 */
export function responseXml(href: string, entry: DriveEntry): string {
    const encoded = xmlEscape(encodeHref(entry.isDir && !href.endsWith('/') ? href + '/' : href));
    const resourcetype = entry.isDir ? '<d:collection/>' : '';
    const checksums =
        !entry.isDir && entry.sha1
            ? `<oc:checksums><oc:checksum>SHA1:${entry.sha1}</oc:checksum></oc:checksums>`
            : '<oc:checksums/>';
    // getcontentlength is omitted for collections (matches typical servers).
    const contentLength = entry.isDir ? '' : `<d:getcontentlength>${entry.size}</d:getcontentlength>`;
    return `<d:response>
  <d:href>${encoded}</d:href>
  <d:propstat>
   <d:prop>
    <d:displayname>${xmlEscape(entry.name)}</d:displayname>
    <d:getlastmodified>${httpDate(entry.mtime)}</d:getlastmodified>
    ${contentLength}
    <d:resourcetype>${resourcetype}</d:resourcetype>
    ${checksums}
    <oc:permissions>RDNVW</oc:permissions>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>`;
}

export function multistatus(responses: string[]): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
 ${responses.join('\n ')}
</d:multistatus>
`;
}

/** Quota response for `rclone about` (D:quota-used-bytes / D:quota-available-bytes). */
export function quotaMultistatus(href: string, used?: number, available?: number): string {
    // -3 is the ownCloud/Nextcloud sentinel for "unknown / unlimited".
    const avail = available === undefined ? -3 : available;
    const usedProp = used === undefined ? '' : `<d:quota-used-bytes>${used}</d:quota-used-bytes>`;
    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response>
  <d:href>${xmlEscape(encodeHref(href))}</d:href>
  <d:propstat>
   <d:prop>
    ${usedProp}
    <d:quota-available-bytes>${avail}</d:quota-available-bytes>
   </d:prop>
   <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>
`;
}

/**
 * PROPPATCH reply. We cannot persist a standalone modification-time change to
 * Proton without re-uploading a revision, so a real change is reported as
 * failed (403) rather than silently accepted. A no-op (requested == stored)
 * reports success. rclone falls back gracefully to ErrorCantSetModTime.
 */
export function proppatchMultistatus(href: string, ok: boolean): string {
    const status = ok ? 'HTTP/1.1 200 OK' : 'HTTP/1.1 403 Forbidden';
    return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
 <d:response>
  <d:href>${xmlEscape(encodeHref(href))}</d:href>
  <d:propstat>
   <d:prop><d:lastmodified/></d:prop>
   <d:status>${status}</d:status>
  </d:propstat>
 </d:response>
</d:multistatus>
`;
}
