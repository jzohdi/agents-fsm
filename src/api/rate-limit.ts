/**
 * In-process token-bucket rate limiter (issue #27) — pure, dependency-light, unit-testable in
 * isolation. Mirrors the pure-helper precedent (`auth.ts`, `bind-guard.ts`, `static.ts`): no coupling
 * to `node:http`, `process`, timers, or `Date.now()` — the caller injects `now` (epoch ms) so the
 * decision is deterministic and testable.
 *
 * The abuse backstop for the exposed API surface: mutating/expensive routes are keyed by client
 * source and consume one token per request; a flood past `capacity` gets a `429`. Memory is bounded
 * so the limiter itself can't be turned into a memory-exhaustion vector by an attacker cycling keys.
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

/** A single client's bucket: its current token balance and when it was last touched (epoch ms). */
interface Bucket {
  tokens: number;
  lastSeen: number;
}

/** Default idle window (ms) after which an untouched bucket is evicted on the next `check()`. */
const DEFAULT_IDLE_EVICT_MS = 10 * 60 * 1000; // 10 min
/** Default hard cap on simultaneously-tracked buckets (memory backstop). */
const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  // Clamp the config so a garbage value can never *disable* the limiter or wedge it (capacity ≥ 1,
  // refill > 0). `serve.ts`'s resolvers already fall back to safe defaults, but be defensive here too.
  const capacity = Number.isFinite(options.capacity) && options.capacity >= 1 ? options.capacity : 1;
  const refillPerSec = Number.isFinite(options.refillPerSec) && options.refillPerSec > 0 ? options.refillPerSec : 1;
  const idleEvictMs = options.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

  // Insertion-ordered Map: touching a key re-inserts it at the end, so the *first* entry is always the
  // least-recently-seen — the one to evict when we overflow `maxKeys`.
  const buckets = new Map<string, Bucket>();

  return {
    check(key: string, now: number): RateLimitDecision {
      // Lazy idle sweep: drop buckets untouched for ≥ idleEvictMs so a source cycling keys can't grow
      // the map unboundedly (an idle bucket is indistinguishable from a fresh full one anyway).
      for (const [k, b] of buckets) {
        if (now - b.lastSeen >= idleEvictMs) buckets.delete(k);
      }

      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { tokens: capacity, lastSeen: now }; // an unseen key starts with a full bucket
      } else {
        buckets.delete(key); // re-inserted below so it moves to the most-recently-seen end
        // Refill by real elapsed time, clamped to capacity. A non-increasing / backwards clock yields a
        // non-positive elapsed → `max(0, …)` guarantees no negative-elapsed over-refill.
        const elapsedSec = Math.max(0, now - bucket.lastSeen) / 1000;
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
        bucket.lastSeen = now;
      }
      buckets.set(key, bucket);

      // Memory backstop: evict least-recently-seen keys until we're back under the cap (never the key we
      // just touched — it's now at the MRU end).
      while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === key) break;
        buckets.delete(oldest);
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { ok: true };
      }
      // Not enough for one token: how many whole seconds until the balance reaches 1. Always ≥ 1.
      const retryAfterSec = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSec));
      return { ok: false, retryAfterSec };
    },
  };
}
