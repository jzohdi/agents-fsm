/**
 * Static asset serving for the local web dashboard (Layer 7 — README §3.3 / Milestone 6).
 *
 * The daemon serves the dashboard (`public/`) itself, so it is a single self-contained process and
 * the browser app is a pure client of the Layer 6 API. This is deliberately tiny — a path-traversal
 * guard, a content-type map, and a file read — with the security-critical bits (`resolveStaticPath`,
 * `contentTypeFor`) factored out as pure functions so they are unit-tested without a socket.
 */

import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** Content-type for a file path by extension; unknown types fall back to a safe binary default. */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve a request path to an absolute file path **inside** `publicDir`, or `null` if it escapes
 * (path traversal) or is malformed. `/` maps to `index.html`. This is the only line of defense
 * against `GET /../../etc/passwd`, so it is pure and directly tested.
 */
export function resolveStaticPath(publicDir: string, pathname: string): string | null {
  const base = resolve(publicDir);
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }
  rel = rel.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  const target = resolve(base, rel);
  // Must be the base dir itself or strictly within it (the trailing separator stops `…/publicXYZ`).
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/**
 * Serve a static file from `publicDir` for `pathname`. Returns `true` if it wrote a response (200 or
 * 404), `false` only if the caller should treat it as unhandled — but in practice it always responds,
 * so a `GET` that matches no API route ends here. A missing file is a clean `404`.
 */
export async function serveStatic(res: ServerResponse, publicDir: string, pathname: string): Promise<void> {
  const filePath = resolveStaticPath(publicDir, pathname);
  if (filePath === null) {
    notFound(res);
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
    res.end(body);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') {
      notFound(res);
      return;
    }
    throw err; // unexpected I/O error → the server's catch turns it into a 500
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
