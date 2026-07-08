/** Static-serving helper tests (Milestone 6): the path-traversal guard and content-type mapping. */

import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { contentTypeFor, isSpaRoute, resolveStaticPath } from './static';

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

  // Remote-exposure hardening (issue #27): re-verify the traversal guard against the trickier vectors
  // an off-localhost attacker would try. The security invariant is that no input EVER resolves outside
  // `publicDir` — the guard returns either `null` (rejected) or a path strictly within the base dir.
  describe('never escapes the public dir under remote-exposure edge cases (issue #27)', () => {
    /** The true security property: rejected (null) or confined to `PUBLIC` — never a sibling/parent. */
    const staysInBase = (pathname: string): void => {
      const got = resolveStaticPath(PUBLIC, pathname);
      if (got !== null) {
        expect(got === PUBLIC || got.startsWith(`${PUBLIC}${sep}`)).toBe(true);
      }
    };

    it('confines backslash separators, NUL bytes, and double-encoded traversal to the base', () => {
      staysInBase('/..\\..\\etc\\passwd'); // backslash is not a POSIX separator — must not escape
      staysInBase('/foo%00.js'); // embedded NUL byte
      staysInBase('/%252e%252e/%252e%252e/etc/passwd'); // doubly-encoded `../../`
      staysInBase('/..%2f..%2f..%2fetc%2fpasswd'); // encoded slashes around `..`
    });

    it('rejects (or confines) absolute-path smuggling and encoded traversal', () => {
      // A leading slash / encoded leading slashes must not smuggle in an absolute path.
      staysInBase('/etc/passwd');
      staysInBase('//etc/passwd');
      staysInBase('/%2Fetc%2Fpasswd');
      // Classic dot-dot traversal (encoded) must be rejected outright.
      expect(resolveStaticPath(PUBLIC, '/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    });

    it('refuses a sibling directory that merely shares the public-dir prefix', () => {
      // `…/public` must not grant access to `…/public-evil` or `…/publicXYZ`.
      expect(resolveStaticPath(PUBLIC, '/../public-evil/secret')).toBeNull();
      expect(resolveStaticPath(PUBLIC, `/../${basenamePlus()}`)).toBeNull();
    });
  });
});

/** The public dir's own leaf name with a suffix, to probe the sibling-prefix escape (`publicXYZ`). */
function basenamePlus(): string {
  return `${PUBLIC.split(sep).pop()}XYZ`;
}

describe('isSpaRoute', () => {
  it('treats extension-less paths as client routes and extensioned paths as assets', () => {
    expect(isSpaRoute('/')).toBe(true);
    expect(isSpaRoute('/pipelines')).toBe(true);
    expect(isSpaRoute('/editor')).toBe(true);
    expect(isSpaRoute('/runs/12')).toBe(true);
    expect(isSpaRoute('/app.js')).toBe(false);
    expect(isSpaRoute('/assets/index-abc123.css')).toBe(false);
    // A dotted directory segment doesn't make the leaf an asset.
    expect(isSpaRoute('/v1.2/overview')).toBe(true);
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
