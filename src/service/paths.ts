/**
 * POSIX path helpers for the WebDAV layer. All WebDAV paths are absolute,
 * '/'-separated, and normalised (no '.', '..', or empty segments except root).
 */

/** Split an absolute WebDAV path into clean segments. Root -> []. */
export function segments(p: string): string[] {
    return p
        .split('/')
        .filter((s) => s.length > 0 && s !== '.');
}

/** Normalise to a leading-slash path with no trailing slash (root stays '/'). */
export function normalize(p: string): string {
    const segs = segments(p);
    return '/' + segs.join('/');
}

export function isRoot(p: string): boolean {
    return segments(p).length === 0;
}

export function baseName(p: string): string {
    const segs = segments(p);
    return segs.length === 0 ? '' : segs[segs.length - 1]!;
}

export function parentPath(p: string): string {
    const segs = segments(p);
    if (segs.length === 0) {
        return '/';
    }
    return '/' + segs.slice(0, -1).join('/');
}

export function join(a: string, b: string): string {
    return normalize(a + '/' + b);
}

/**
 * Reject traversal and control characters. Returns true when safe. WebDAV
 * segments must not contain '/', NUL, or path traversal tokens.
 */
export function isSafeSegment(name: string): boolean {
    if (name.length === 0 || name === '.' || name === '..') {
        return false;
    }
    if (name.includes('/') || name.includes('\u0000')) {
        return false;
    }
    return true;
}

/** Decode a percent-encoded request path. Invalid sequences pass through unchanged. */
export function decode(p: string): string {
    try {
        return decodeURIComponent(p);
    } catch {
        return p;
    }
}

/**
 * Percent-encode a path for use in a WebDAV href, preserving '/'.
 * The root collection must render as "/" -- an empty <d:href/> is invalid per
 * RFC 4918 and rclone cannot resolve a name from it.
 */
export function encodeHref(p: string): string {
    const encoded = segments(p)
        .map((s) => encodeURIComponent(s))
        .map((s) => '/' + s)
        .join('');
    if (encoded === '') {
        return '/';
    }
    return encoded + (p.endsWith('/') ? '/' : '');
}
