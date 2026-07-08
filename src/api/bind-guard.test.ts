/**
 * Bind-guard unit tests (issue #26) — the acceptance-criteria coverage for "reach the dashboard
 * off-localhost". Pure, exercised in isolation from `node:http`/`process`/the filesystem (mirrors
 * `auth.test.ts`): loopback classification + the allow/refuse verdict over (host × token-presence).
 *
 * These are the tdd-stage red tests: they define "done" for `src/api/bind-guard.ts`. The
 * implementation stage makes them pass. The whole security default rests on this guard, so the table
 * is exhaustive: the wildcard binds (`0.0.0.0`, `::`) and any LAN/public address MUST be non-loopback,
 * the `127.0.0.0/8` block MUST be loopback, and anything unparseable MUST fail safe → non-loopback.
 */

import { describe, expect, it } from 'vitest';

import { checkBindAllowed, isLoopbackHost } from './bind-guard';

describe('isLoopbackHost (bind-address classification)', () => {
  it('classifies the canonical loopback hosts as loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true); // bracketed IPv6 literal → brackets stripped
    expect(isLoopbackHost('localhost')).toBe(true); // literal string, never DNS-resolved
  });

  it('treats the whole 127.0.0.0/8 block as loopback (numeric dotted-quad, not startsWith)', () => {
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
  });

  it('treats the IPv6-mapped IPv4 loopback as loopback', () => {
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.2')).toBe(true);
  });

  it('normalizes case and surrounding whitespace before classifying', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('  127.0.0.1  ')).toBe(true);
    expect(isLoopbackHost(' ::1 ')).toBe(true);
  });

  it('classifies the wildcard binds as NON-loopback (they bind every interface — must engage the guard)', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });

  it('classifies LAN and public addresses as non-loopback', () => {
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('172.16.0.9')).toBe(false);
    expect(isLoopbackHost('8.8.8.8')).toBe(false); // public IPv4
    expect(isLoopbackHost('2001:4860:4860::8888')).toBe(false); // routable IPv6
  });

  it('fails safe (non-loopback) on look-alikes and garbage rather than throwing', () => {
    // Near-misses that a loose `startsWith('127.')` would wrongly wave through.
    expect(isLoopbackHost('127.foo')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.5')).toBe(false);
    expect(isLoopbackHost('127.0.0.256')).toBe(false); // octet out of range
    // Leading-zero octets are octal to `inet_aton`-style resolvers (`0127` ⇒ 87 — the OS could bind
    // 87.0.0.1 while a decimal parse read 127.0.0.1), so the ambiguity must fail safe → non-loopback.
    expect(isLoopbackHost('0127.0.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0.01')).toBe(false);
    expect(isLoopbackHost('::ffff:0127.0.0.1')).toBe(false); // same rule for the mapped tail
    // Empty / bogus input must not be classified loopback (would expose the daemon).
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost('   ')).toBe(false);
    expect(isLoopbackHost('not-a-host')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false); // only the literal `localhost` is loopback
  });
});

describe('checkBindAllowed (the bind decision: host loopback-ness × token presence)', () => {
  it('allows a loopback bind regardless of token (the unchanged default path)', () => {
    expect(checkBindAllowed('127.0.0.1', false)).toEqual({ ok: true });
    expect(checkBindAllowed('127.0.0.1', true)).toEqual({ ok: true });
    expect(checkBindAllowed('localhost', false)).toEqual({ ok: true });
    expect(checkBindAllowed('::1', false)).toEqual({ ok: true });
  });

  it('allows a non-loopback bind when a token is configured', () => {
    expect(checkBindAllowed('0.0.0.0', true)).toEqual({ ok: true });
    expect(checkBindAllowed('192.168.1.10', true)).toEqual({ ok: true });
  });

  it('refuses a non-loopback bind without a token, with an actionable reason', () => {
    const verdict = checkBindAllowed('0.0.0.0', false);
    expect(verdict.ok).toBe(false);
    // Narrow the union so `reason` is accessible, then assert on stable substrings (not the full
    // sentence, to avoid brittleness): the offending host + the env var the operator must set.
    if (verdict.ok) throw new Error('expected refusal');
    expect(verdict.reason).toContain('0.0.0.0');
    expect(verdict.reason).toContain('FLEET_API_TOKEN');
  });

  it('names the specific offending host in the refusal (not a generic message)', () => {
    const verdict = checkBindAllowed('192.168.1.50', false);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected refusal');
    expect(verdict.reason).toContain('192.168.1.50');
  });
});
