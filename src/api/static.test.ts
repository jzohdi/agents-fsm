/** Static-serving helper tests (Milestone 6): the path-traversal guard and content-type mapping. */

import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { contentTypeFor, resolveStaticPath } from './static';

const PUBLIC = resolve('/srv/public');

describe('resolveStaticPath', () => {
  it('maps "/" to index.html and resolves normal assets inside the dir', () => {
    expect(resolveStaticPath(PUBLIC, '/')).toBe(`${PUBLIC}${sep}index.html`);
    expect(resolveStaticPath(PUBLIC, '/app.js')).toBe(`${PUBLIC}${sep}app.js`);
    expect(resolveStaticPath(PUBLIC, '/sub/style.css')).toBe(`${PUBLIC}${sep}sub${sep}style.css`);
  });

  it('refuses path traversal out of the public dir', () => {
    expect(resolveStaticPath(PUBLIC, '/../secret')).toBeNull();
    expect(resolveStaticPath(PUBLIC, '/../../etc/passwd')).toBeNull();
    expect(resolveStaticPath(PUBLIC, '/a/../../b')).toBeNull();
    // A sibling dir that merely shares the prefix must not be reachable.
    expect(resolveStaticPath(PUBLIC, '/../public-evil/x')).toBeNull();
  });

  it('returns null for malformed percent-encoding', () => {
    expect(resolveStaticPath(PUBLIC, '/%E0%A4%A')).toBeNull();
  });

  it('decodes percent-encoded paths before resolving', () => {
    expect(resolveStaticPath(PUBLIC, '/a%2Fb.js')).toBe(`${PUBLIC}${sep}a${sep}b.js`);
  });
});

describe('contentTypeFor', () => {
  it('maps known extensions and falls back for unknown ones', () => {
    expect(contentTypeFor('/x/index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('app.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('style.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('graph.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('data.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeFor('weird.xyz')).toBe('application/octet-stream');
  });
});
