/**
 * Dashboard token helper tests (issue #25): the pure `withToken` URL builder and the
 * `localStorage`-backed get/set/clear. Runs under the root vitest suite in Node (no DOM), so a
 * minimal in-memory `localStorage` is installed for the storage cases.
 *
 * These are the tdd-stage red tests: they define "done" for `dashboard/src/lib/auth.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearToken, getToken, setToken, withToken } from './auth';

/** A tiny in-memory `localStorage` so the storage helpers are exercisable in the Node test env. */
function installLocalStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('withToken (SSE URL builder)', () => {
  it('appends ?token= to a path with no existing query', () => {
    expect(withToken('/stream', 'abc')).toBe('/stream?token=abc');
  });

  it('appends &token= (URL-encoded) when the path already has a query string', () => {
    expect(withToken('/stream?runId=1', 'a b')).toBe('/stream?runId=1&token=a%20b');
  });

  it('returns the path unchanged when there is no token', () => {
    expect(withToken('/stream', null)).toBe('/stream');
    expect(withToken('/stream', undefined)).toBe('/stream');
  });
});

describe('token storage (localStorage-backed)', () => {
  beforeEach(() => installLocalStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('round-trips a stored token and reads null when none is set', () => {
    expect(getToken()).toBeNull();
    setToken('tok-123');
    expect(getToken()).toBe('tok-123');
  });

  it('clears the token via clearToken()', () => {
    setToken('tok-123');
    clearToken();
    expect(getToken()).toBeNull();
  });

  it('treats setToken("") (blank/whitespace) as a clear', () => {
    setToken('tok-123');
    setToken('');
    expect(getToken()).toBeNull();
    setToken('tok-123');
    setToken('   ');
    expect(getToken()).toBeNull();
  });

  it('withToken falls back to the stored token when none is passed', () => {
    setToken('stored-tok');
    expect(withToken('/stream')).toBe('/stream?token=stored-tok');
  });
});
