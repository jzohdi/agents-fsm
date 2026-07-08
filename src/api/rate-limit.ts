/**
 * In-process token-bucket rate limiter (issue #27) — pure, dependency-light, unit-testable in
 * isolation. Mirrors the pure-helper precedent (`auth.ts`, `bind-guard.ts`, `static.ts`): no coupling
 * to `node:http`, `process`, timers, or `Date.now()` — the caller injects `now` (epoch ms) so the
 * decision is deterministic and testable.
 *
 * TDD stage (issue #27): this is an intentionally UNIMPLEMENTED stub — the signatures pin the contract
 * from `.agent/interface.md` §1 so `rate-limit.test.ts` compiles and fails for the right reason
 * (missing behaviour). The implementation stage fills the body in (token-bucket refill + eviction).
 */

/** The verdict for one request. `retryAfterSec` is present (an integer ≥ 1) iff `ok === false`. */
export interface RateLimitDecision {
  ok: boolean;
  retryAfterSec?: number;
}

export interface RateLimiterOptions {
  /** Bucket capacity = max burst before throttling. Must be ≥ 1. */
  capacity: number;
  /** Tokens replenished per second (fractional allowed, e.g. 1 = one per second). Must be > 0. */
  refillPerSec: number;
  /**
   * Evict a bucket untouched for at least this long (ms) on the next `check()` (lazy sweep), so an
   * attacker cycling source IPs can't grow the map unboundedly. Default ≈ 10 min.
   */
  idleEvictMs?: number;
  /**
   * Hard cap on simultaneously-tracked buckets (memory backstop). On overflow, evict the
   * least-recently-seen. Default ≈ 10_000.
   */
  maxKeys?: number;
}

export interface RateLimiter {
  /** Consume one token for `key` at time `now` (epoch ms). Returns allow/deny + retry hint. */
  check(key: string, now: number): RateLimitDecision;
}

export function createRateLimiter(_options: RateLimiterOptions): RateLimiter {
  throw new Error('createRateLimiter not implemented (issue #27 TDD stub)');
}
