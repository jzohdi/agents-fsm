/**
 * Token-bucket rate-limiter unit tests (issue #27) — the abuse backstop for the exposed API surface.
 * Pure, exercised in isolation from `node:http`/timers/`Date.now()` (mirrors `auth.test.ts` /
 * `bind-guard.test.ts`): the caller injects `now`, so refill and eviction are fully deterministic.
 *
 * These are the tdd-stage red tests: they define "done" for `src/api/rate-limit.ts`. The
 * implementation stage makes them pass. Contract: `.agent/interface.md` §1.
 */

import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rate-limit';

const T0 = 1_000_000; // an arbitrary fixed epoch-ms baseline (never `Date.now()` — determinism)

describe('createRateLimiter (token bucket)', () => {
  it('allows the first `capacity` rapid calls, then denies with an integer retryAfterSec ≥ 1', () => {
    const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1 });

    // The bucket starts full: the first `capacity` calls at the same instant all pass.
    expect(limiter.check('a', T0).ok).toBe(true);
    expect(limiter.check('a', T0).ok).toBe(true);
    expect(limiter.check('a', T0).ok).toBe(true);

    // The next call at the same instant is throttled with a concrete retry hint.
    const denied = limiter.check('a', T0);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSec).toBeTypeOf('number');
    expect(Number.isInteger(denied.retryAfterSec)).toBe(true);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('omits retryAfterSec on an allowed decision', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1 });
    expect(limiter.check('a', T0).retryAfterSec).toBeUndefined();
  });

  it('refills over elapsed injected time (a throttled key recovers)', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1 });

    expect(limiter.check('a', T0).ok).toBe(true);
    expect(limiter.check('a', T0).ok).toBe(true);
    expect(limiter.check('a', T0).ok).toBe(false); // drained

    // One token per second: 1 s later exactly one call succeeds again, and the following one is denied.
    expect(limiter.check('a', T0 + 1000).ok).toBe(true);
    expect(limiter.check('a', T0 + 1000).ok).toBe(false);

    // Waiting long enough fully restores the bucket (a burst of `capacity` succeeds).
    expect(limiter.check('a', T0 + 10_000).ok).toBe(true);
    expect(limiter.check('a', T0 + 10_000).ok).toBe(true);
    expect(limiter.check('a', T0 + 10_000).ok).toBe(false);
  });

  it('never lets tokens exceed capacity no matter how long a key idles', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 100 });
    // A huge idle gap must not bank more than `capacity` tokens.
    expect(limiter.check('a', T0 + 1_000_000).ok).toBe(true);
    expect(limiter.check('a', T0 + 1_000_000).ok).toBe(true);
    expect(limiter.check('a', T0 + 1_000_000).ok).toBe(false);
  });

  it('keeps distinct keys fully independent', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1 });
    expect(limiter.check('a', T0).ok).toBe(true);
    expect(limiter.check('a', T0).ok).toBe(false); // 'a' is drained…
    expect(limiter.check('b', T0).ok).toBe(true); // …but 'b' has its own full bucket.
  });

  it('does not over-refill on a non-increasing (or backwards) clock', () => {
    const limiter = createRateLimiter({ capacity: 2, refillPerSec: 1 });
    expect(limiter.check('a', T0).ok).toBe(true);
    expect(limiter.check('a', T0).ok).toBe(true);
    expect(limiter.check('a', T0).ok).toBe(false); // drained at T0
    // A stale/backwards `now` must never manufacture tokens (no negative-elapsed refill).
    expect(limiter.check('a', T0 - 5_000).ok).toBe(false);
  });

  it('bounds memory: evicting an idle key does not disturb an active key', () => {
    // A small idle window + a tiny key cap so eviction is exercised deterministically.
    const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, idleEvictMs: 1000, maxKeys: 2 });

    // Drain 'active' at T0, then keep it hot.
    expect(limiter.check('active', T0).ok).toBe(true);
    expect(limiter.check('active', T0).ok).toBe(false);

    // Touch several other keys far in the future — enough to force idle-eviction / maxKeys eviction of
    // the stale ones — without ever evicting 'active' out from under its live throttle.
    for (const k of ['x', 'y', 'z']) expect(limiter.check(k, T0 + 5000).ok).toBe(true);

    // 'active' refilled by real elapsed time (5 s ≥ capacity/refill), so it's allowed again — proving
    // its bucket wasn't silently reset by eviction (that would also allow it, so pin the drained state
    // at its own instant instead): a second call at the same later instant is denied.
    expect(limiter.check('active', T0 + 5000).ok).toBe(true);
    expect(limiter.check('active', T0 + 5000).ok).toBe(false);
  });
});
