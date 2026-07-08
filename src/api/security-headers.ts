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
  throw new Error('securityHeaders not implemented (issue #27 TDD stub)');
}

/**
 * The Content-Security-Policy header value for HTML/SPA document responses only (added on top of the
 * baseline by the static handler when it serves `text/html`). Not applied to JSON/SSE.
 */
export const CONTENT_SECURITY_POLICY = '';

/**
 * Cross-origin response headers for a request's `Origin`. Returns the ACAO/allow-* set ONLY when
 * `origin` is a non-empty exact member of `allowedOrigins`; otherwise returns `{}` (deny — no ACAO,
 * so a browser blocks the cross-origin read). Never emits a `*` wildcard. Always include `Vary: Origin`
 * in the header set it returns so caches don't cross-serve.
 */
export function corsHeaders(_origin: string | undefined, _allowedOrigins: readonly string[]): Record<string, string> {
  throw new Error('corsHeaders not implemented (issue #27 TDD stub)');
}
