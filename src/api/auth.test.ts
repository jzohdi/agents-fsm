/**
 * Auth-helper unit tests (issue #25): constant-time compare, credential extraction, and the auth
 * boundary — exercised in isolation from `node:http`/the orchestrator (mirrors `static.test.ts`).
 *
 * These are the tdd-stage red tests: they define "done" for `src/api/auth.ts`. The implementation
 * stage makes them pass.
 */

import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';

import { extractToken, requiresAuth, tokenMatches } from './auth';

const urlOf = (path: string): URL => new URL(path, 'http://localhost');

describe('tokenMatches (constant-time compare)', () => {
  const SECRET = 's3cr3t-token-value';

  it('accepts the exact token byte-for-byte', () => {
    expect(tokenMatches(SECRET, SECRET)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(tokenMatches('s3cr3t-token-valuX', SECRET)).toBe(false);
  });

  it('rejects an absent or empty provided credential', () => {
    expect(tokenMatches(undefined, SECRET)).toBe(false);
    expect(tokenMatches('', SECRET)).toBe(false);
  });

  it('rejects a strict prefix and a superset of the correct token (fixed-length digest)', () => {
    // A prefix must not match…
    expect(tokenMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    // …and neither may a value that starts with the whole token (guards a naive startsWith/compare).
    expect(tokenMatches(`${SECRET}x`, SECRET)).toBe(false);
  });
});

describe('extractToken (Bearer header + ?token= fallback)', () => {
  it('reads "Authorization: Bearer <token>" (case-insensitive scheme)', () => {
    const headers: IncomingHttpHeaders = { authorization: 'Bearer abc123' };
    expect(extractToken(headers, urlOf('/runs'))).toBe('abc123');
    expect(extractToken({ authorization: 'bearer abc123' }, urlOf('/runs'))).toBe('abc123');
  });

  it('falls back to the ?token= query param when there is no header', () => {
    expect(extractToken({}, urlOf('/stream?token=qtok'))).toBe('qtok');
  });

  it('prefers the Authorization header over the query param when both are present', () => {
    const headers: IncomingHttpHeaders = { authorization: 'Bearer headertok' };
    expect(extractToken(headers, urlOf('/stream?token=querytok'))).toBe('headertok');
  });

  it('returns undefined when neither is present', () => {
    expect(extractToken({}, urlOf('/runs'))).toBeUndefined();
  });

  it('returns undefined for a malformed / non-Bearer header', () => {
    expect(extractToken({ authorization: 'Basic abc123' }, urlOf('/runs'))).toBeUndefined();
    expect(extractToken({ authorization: 'abc123' }, urlOf('/runs'))).toBeUndefined();
  });

  it('treats a non-string (array) Authorization header as absent', () => {
    // A repeated header arrives as string[]; the type says string|undefined, so cast the malformed input.
    const headers = { authorization: ['Bearer a', 'Bearer b'] } as unknown as IncomingHttpHeaders;
    expect(extractToken(headers, urlOf('/runs'))).toBeUndefined();
  });

  it('normalizes an empty ?token= to undefined', () => {
    expect(extractToken({}, urlOf('/stream?token='))).toBeUndefined();
  });
});

describe('requiresAuth (the auth boundary)', () => {
  // Every current API prefix in server.ts — the authoritative allowlist from the interface spec.
  const API_PREFIXES = [
    '/runs',
    '/repos',
    '/config',
    '/cost',
    '/models',
    '/settings',
    '/suggestions',
    '/scheduler',
    '/fs',
    '/stream',
  ];

  it('protects every known API prefix (and their sub-paths)', () => {
    for (const prefix of API_PREFIXES) {
      expect(requiresAuth(prefix)).toBe(true);
    }
    // Sub-paths under a protected prefix are protected too.
    expect(requiresAuth('/runs/5')).toBe(true);
    expect(requiresAuth('/runs/5/pause')).toBe(true);
    expect(requiresAuth('/settings/default-harness')).toBe(true);
  });

  it('leaves /health open (liveness probes)', () => {
    expect(requiresAuth('/health')).toBe(false);
  });

  it('leaves static / SPA paths open (so the dashboard can bootstrap and prompt for a token)', () => {
    expect(requiresAuth('/')).toBe(false);
    expect(requiresAuth('/pipelines')).toBe(false);
    expect(requiresAuth('/editor')).toBe(false);
    expect(requiresAuth('/assets/app.js')).toBe(false);
    expect(requiresAuth('/index.html')).toBe(false);
  });

  it('does not treat a mere prefix-string overlap as a protected route', () => {
    // "/runsomething" is not under the "/runs" API surface — only "/runs" or "/runs/…".
    expect(requiresAuth('/runsomething')).toBe(false);
    expect(requiresAuth('/configuration')).toBe(false);
  });
});
