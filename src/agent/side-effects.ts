/**
 * Transactional outbox for non-idempotent external side effects (README §3.3 risk register /
 * Milestone 7). Posting issue/PR comments and creating sub-issues are not idempotent: a crash in
 * the window after the GitHub call returns but before the run's transition commits would re-run the
 * stage and repeat them (a duplicate comment, or — worse — duplicate sub-issues).
 *
 * The ledger closes that window. Before a wrapped call the runner **claims** a slot ('pending'); after
 * it returns the runner **completes** the slot with the result. On a crash/replay:
 *  - a `done` slot returns its stored result, so the external call is never made twice;
 *  - a `pending` slot means a prior attempt claimed it but never completed — the call may or may not
 *    have applied, so we throw {@link AmbiguousSideEffectError} (the caller escalates to a human)
 *    rather than blindly retrying a non-idempotent operation.
 *
 * The slot key is `${state}#${visit}:${slot}` — independent of (nondeterministic) agent output, stable
 * across a replay of the same state visit, and fresh on a legitimate re-entry (a back-edge or an
 * operator resume bumps `visit`, so a real second round performs its side effects anew). See
 * {@link Repository.stateVisitCount} / {@link Repository.beginSideEffect}.
 */

import type { SideEffectClaim } from '../store/repository';

/**
 * A side effect was claimed by a prior attempt but never recorded as completed — i.e. the daemon
 * crashed mid-call. The operation is non-idempotent, so we cannot safely retry; the runner turns this
 * into a `partial_side_effect` escalation for a human to inspect (README Milestone 7 needs_human UX).
 */
export class AmbiguousSideEffectError extends Error {
  constructor(public readonly key: string) {
    super(`side effect "${key}" was claimed by a prior attempt but never completed — it may have partly applied`);
    this.name = 'AmbiguousSideEffectError';
  }
}

/** The slice of the store the ledger needs. {@link Repository} satisfies it structurally. */
export interface SideEffectStore {
  beginSideEffect(runId: number, key: string): SideEffectClaim;
  completeSideEffect(runId: number, key: string, result: unknown): void;
}

/**
 * A per-stage handle that runs each non-idempotent external call at most once for a given state visit.
 * Built by the runner with a key prefix of `${state}#${visit}`, so call sites pass only a stable
 * `slot` discriminator (e.g. `signoff`, `subissue:0`, `comment:1`).
 */
export class SideEffectLedger {
  constructor(
    private readonly store: SideEffectStore,
    private readonly runId: number,
    private readonly keyPrefix: string,
  ) {}

  /**
   * Perform `slot`'s external call, unless this visit already did: a completed slot returns its stored
   * result without calling out again, and an in-flight (crashed) slot throws {@link AmbiguousSideEffectError}.
   */
  async once<T>(slot: string, perform: () => Promise<T>): Promise<T> {
    const key = `${this.keyPrefix}:${slot}`;
    const claim = this.store.beginSideEffect(this.runId, key);
    if (claim.state === 'done') return claim.result as T;
    if (claim.state === 'pending') throw new AmbiguousSideEffectError(key);
    const result = await perform();
    this.store.completeSideEffect(this.runId, key, result);
    return result;
  }
}
