/**
 * Security-headers + CORS policy unit tests (issue #27). Pure, exercised in isolation from
 * `node:http` (mirrors `auth.test.ts` / `static.test.ts`): the baseline header set, the SPA CSP
 * invariants, and the exact-match cross-origin allow/deny decision.
 *
 * These are the tdd-stage red tests: they define "done" for `src/api/security-headers.ts`. The
 * implementation stage makes them pass. Contract: `.agent/interface.md` §2.
 */

import { describe, expect, it } from 'vitest';

import { CONTENT_SECURITY_POLICY, corsHeaders, securityHeaders } from './security-headers';

describe('securityHeaders (baseline set on every response)', () => {
  it('sets nosniff, frame-deny, and no-referrer', () => {
    const h = securityHeaders();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('no-referrer');
  });

  it('does NOT set HSTS (TLS termination is the tunnel/proxy\'s job, not the app\'s)', () => {
    const h = securityHeaders();
    // No key that looks like Strict-Transport-Security, in any casing.
    expect(Object.keys(h).some((k) => k.toLowerCase() === 'strict-transport-security')).toBe(false);
  });
});

describe('CONTENT_SECURITY_POLICY (HTML/SPA documents only)', () => {
  it('locks down the SPA: self origins, no framing, no base/object', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("base-uri 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data:");
  });

  it('permits the Google-Fonts origins the built dashboard shell pulls (style + font)', () => {
    // The SPA shell links fonts.googleapis.com (stylesheet) + fonts.gstatic.com (font files); the CSP
    // must allow them so styling isn't blanked. (Losing the remote font is acceptable degradation; a
    // blanked dashboard is not — see interface §2.)
    expect(CONTENT_SECURITY_POLICY).toContain('https://fonts.googleapis.com');
    expect(CONTENT_SECURITY_POLICY).toContain('https://fonts.gstatic.com');
  });

  it('never contains a wildcard source', () => {
    // A `*` anywhere would defeat the point of the policy.
    expect(CONTENT_SECURITY_POLICY).not.toContain('*');
  });
});

describe('corsHeaders (exact-match allow-list, never a wildcard)', () => {
  const ALLOWED = ['https://ops.example', 'https://dash.example:8443'] as const;

  it('echoes an allowed origin exactly (never "*") with Vary: Origin and the allow-* set', () => {
    const h = corsHeaders('https://ops.example', ALLOWED);
    expect(h['Access-Control-Allow-Origin']).toBe('https://ops.example');
    expect(h['Access-Control-Allow-Origin']).not.toBe('*');
    expect(h['Vary']).toContain('Origin');
    expect(h['Access-Control-Allow-Headers']).toContain('Authorization');
    expect(h['Access-Control-Allow-Headers']).toContain('Content-Type');
    expect(h['Access-Control-Allow-Methods']).toBeTruthy();
  });

  it('returns no ACAO for a disallowed origin', () => {
    const h = corsHeaders('https://evil.example', ALLOWED);
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('returns no ACAO for an absent origin', () => {
    const h = corsHeaders(undefined, ALLOWED);
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('denies everything when the allow-list is empty (the default posture)', () => {
    expect(corsHeaders('https://ops.example', [])['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('never matches on a mere substring/prefix of an allowed origin', () => {
    // Exact match only — a lookalike or a superstring must be denied.
    expect(corsHeaders('https://ops.example.evil.com', ALLOWED)['Access-Control-Allow-Origin']).toBeUndefined();
    expect(corsHeaders('https://ops.exampl', ALLOWED)['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
