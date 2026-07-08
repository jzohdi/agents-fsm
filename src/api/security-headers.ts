/**
 * Security response headers + CORS policy (issue #27) — pure header-policy helpers, applied by the
 * transport (`server.ts` / `static.ts`). No `node:http` coupling, so they are unit-tested in isolation
 * (the `auth.ts` / `static.ts` precedent).
 *
 * TDD stage (issue #27): intentionally UNIMPLEMENTED stubs — the signatures + the CSP invariants pin
 * the contract from `.agent/interface.md` §2 so `security-headers.test.ts` compiles and fails for the
 * right reason (missing behaviour). The implementation stage fills these in.
 */

/**
 * Baseline security headers applied to EVERY response (JSON, static asset, SSE, 404, error). These do
 * not vary by route and are safe for any content type. (No HSTS — TLS may be terminated by a
 * tunnel/proxy; that's the terminator's job, documented in the threat model.)
 */
export function securityHeaders(): Record<string, string> {
  return {
    // Stop MIME-sniffing (a JSON/asset must not be reinterpreted as HTML/script).
    'X-Content-Type-Options': 'nosniff',
    // The dashboard is never meant to be framed — clickjacking defense (pairs with CSP frame-ancestors).
    'X-Frame-Options': 'DENY',
    // Don't leak the (possibly token-bearing) dashboard URL to any navigated/loaded origin.
    'Referrer-Policy': 'no-referrer',
    // NOTE: deliberately no Strict-Transport-Security — TLS may be terminated by a tunnel/proxy in
    // front of the daemon, so HSTS is the terminator's call, not the app's (see the threat model).
  };
}

/**
 * The Content-Security-Policy header value for HTML/SPA document responses only (added on top of the
 * baseline by the static handler when it serves `text/html`). Not applied to JSON/SSE.
 *
 * Locked down to same-origin (`'self'`) for scripts/connect/img, no framing, no `<base>`/plugins.
 * The built dashboard shell pulls Google Fonts (a remote stylesheet + font files) and Vite/Svelte
 * inject component styles, so `style-src`/`font-src` permit exactly those origins + `'unsafe-inline'`
 * for styles only. No `script-src 'unsafe-inline'` (the bundle is a same-origin hashed module) and no
 * `*` wildcard anywhere. Losing the remote font is acceptable degradation; a blanked SPA is not.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Cross-origin response headers for a request's `Origin`. Returns the ACAO/allow-* set ONLY when
 * `origin` is a non-empty exact member of `allowedOrigins`; otherwise returns `{}` (deny — no ACAO,
 * so a browser blocks the cross-origin read). Never emits a `*` wildcard, and matches the origin
 * exactly (never a substring/prefix). When it grants access it includes `Vary: Origin` so shared
 * caches don't cross-serve one origin's allowed response to another.
 */
export function corsHeaders(origin: string | undefined, allowedOrigins: readonly string[]): Record<string, string> {
  if (origin === undefined || origin === '' || !allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin, // echoed exactly — never '*'
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    Vary: 'Origin',
  };
}
