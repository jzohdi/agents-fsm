# Interface — Clean up a run's worktree and freshen local base on PR merge (agents-fsm#20)

This change is **wiring**, not new API surface. The two building blocks already exist on the `GitHub`
interface with the correct per-mode semantics; the work is invoking `dropWorkingTree` on the
merge-detected path (alongside the already-present `syncBaseBranch` call), reordering so the reclaim
is crash-safe, and adding one test-observability tally to the fake. **No public interface changes.**

## 1. Unchanged contracts the implementation builds against (do NOT modify)

These are already declared in `src/integration/github.ts` and implemented in both adapters. The
implementation only *calls* them — it must not alter their signatures or per-mode behavior.

```ts
// src/integration/github.ts (existing — unchanged)
interface GitHub {
  // Reclaim a run's worktree: de-register + remove <workingRoot>/run-<id>.
  //   local mode: `git worktree remove --force` + `git worktree prune` (de-registers, not a bare rm)
  //   clone mode: `rm -rf` the run dir
  // Idempotent: dropping a missing tree is a no-op (not an error). Applies to BOTH source modes.
  dropWorkingTree(runId: number): Promise<void>;

  // Freshen the operator's local base checkout after a merge.
  //   local mode: `git fetch origin`, then `git merge --ff-only origin/<base>` ONLY when the checkout
  //               is on <base> with a clean tree; otherwise returns after the fetch (never disturbs
  //               operator WIP / another branch).
  //   clone mode: immediate no-op (no shared local checkout).
  syncBaseBranch(base: string): Promise<void>;

  getPr(prNumber: number): Promise<Pr>; // Pr.state ∈ 'open' | 'merged' | 'closed'
}
```

**Invariant relied upon:** both operations are idempotent local git ops. Re-running after a crash —
already-removed tree, already-fast-forwarded base — is a safe no-op, never a throw (except a genuine
git failure, which the retry path tolerates by leaving the run watched).

## 2. The wiring change — `PrFeedbackPoller.processRun`

File: `src/loop/pr-feedback-poller.ts`. Method: `private async processRun(run)`. Only the
`pr.state !== 'open'` block changes. Target shape:

```ts
const pr = await github.getPr(prNumber);
if (pr.state !== 'open') {
  if (pr.state === 'merged') {
    // Merge is the terminal signal (issue #20): reclaim disk + freshen base, exactly once.
    // Ordering is load-bearing — dropWorkingTree runs BEFORE the stop flag is set: if it throws (or the
    // daemon crashes mid-reclaim) the flag is never set, the run stays watched, and the next tick retries
    // (getPr still 'merged'). Both ops are idempotent, so re-running is safe. Removal covers clone + local.
    await github.dropWorkingTree(run.id);
    // Freshen the operator's local base (local: ff a clean on-base checkout; clone/dirty/off-base: no-op).
    // Best-effort: a freshen miss is cosmetic (next merge / prepareWorkingTree's fetch recovers) and must
    // not wedge the stop flag or abort the pass.
    try {
      await github.syncBaseBranch(baseBranch);
    } catch (err) {
      this.repo.recordLog({ runId: run.id, level: 'warn',
        message: `post-merge sync of the local checkout failed: ${String(err)}`,
        data: { kind: 'post_merge_sync_error', prNumber } });
    }
  }
  this.repo.mergeRunFlags(run.id, { [PR_FEEDBACK_CLOSED_FLAG]: true });
  this.repo.recordLog({ runId: run.id,
    message: `PR #${prNumber} is ${pr.state} — no longer watching for feedback`,
    data: { kind: 'pr_feedback_stopped', prNumber, state: pr.state } });
  return 'stopped';
}
```

### Behavioral contract of this block (invariants the tests pin)

- **On `merged`:** `dropWorkingTree(run.id)` is called exactly once (happy path), then `syncBaseBranch`
  (best-effort), then the stop flag + `pr_feedback_stopped` log, then `return 'stopped'`.
- **On `closed`:** neither `dropWorkingTree` nor `syncBaseBranch` is called — only the stop flag + log.
  Worktree reclaim for abandoned PRs is out of scope; only `merged` triggers cleanup.
- **On `open` (still merge-ready / `done`):** this block is not reached — no reclaim ever fires from
  `done` alone; flow continues to conflict-detection / feedback-scanning.
- **Ordering:** `dropWorkingTree` **before** `mergeRunFlags(...PR_FEEDBACK_CLOSED_FLAG)`. This is the
  crash-safety mechanism: a persistent drop failure keeps the run in `watchedRuns()` so the next tick
  retries; `checkOnce`'s per-run `try/catch` logs a `pr_feedback_poll_error` warn and continues.
  (Note: this reorders relative to today, where `syncBaseBranch` sits *after* the stop flag.)
- **`syncBaseBranch` stays best-effort:** its own `try/catch` logs `post_merge_sync_error` and never
  blocks the stop flag or aborts the pass. A sync failure still lets the worktree drop + stop flag land.
- **At-most-once:** once the flag is set, `isWatchable` returns false, the run leaves `watchedRuns()`,
  and no further reclaim runs. On-demand `checkRun` shares `processRun`, so a dashboard "Check now" on a
  merged PR performs the same one-shot reclaim.
- **Isolation:** `dropWorkingTree(run.id)` removes only this run's `run-<id>` worktree (siblings are
  separate worktrees); `syncBaseBranch` ff's the shared checkout only when clean + on-base, leaving an
  operator or another active run mid-work untouched.

No change to `checkOnce`, `poll`, `checkRun`, `watchedRuns`, `isWatchable`, or any public type. Refresh
the file-header "Stops on merge/close" doc bullet to note the merge-triggered reclaim.

## 3. Test-observability addition — `GitHubFake`

File: `src/integration/github-fake.ts`. Add a `droppedTrees` tally to `dropWorkingTree` mirroring the
existing `syncedBases: string[]`, so poller tests can assert the reclaim fired and count invocations
(for at-most-once / idempotency). Keep the existing `workingTrees.delete(runId)` behavior.

```ts
/** Records each dropped run id so a test can assert the merge reclaim fired and count invocations. */
readonly droppedTrees: number[] = [];
async dropWorkingTree(runId: number): Promise<void> {
  this.droppedTrees.push(runId);
  this.workingTrees.delete(runId); // unchanged: forget the tree (idempotent on a missing tree)
}
```

This is a test-visibility field only; it does not change adapter semantics. The real `github-cli.ts`
adapter is **not** touched — its per-mode `dropWorkingTree`/`syncBaseBranch` behavior is already
covered by real-git tests in `src/integration/github-cli.test.ts`.

## 4. Data shapes / log events (for test assertions)

- `PR_FEEDBACK_CLOSED_FLAG` (`'pr_feedback_closed'`) — boolean run flag; set once on merge/close.
- Log `data.kind` values emitted on this path: `pr_feedback_stopped` (state transition off `open`),
  `post_merge_sync_error` (best-effort sync failure), `pr_feedback_poll_error` (per-run tick failure).
- `GitHubFake.droppedTrees: number[]` and `GitHubFake.syncedBases: string[]` — invocation tallies.
- Merge-detection helper on the fake used to drive tests: `setPrState(prNumber, 'merged' | 'closed')`
  (or the equivalent existing fake mechanism for flipping a PR's `state`).

## 5. Files touched

- `src/loop/pr-feedback-poller.ts` — wiring + doc-comment refresh (§2).
- `src/integration/github-fake.ts` — `droppedTrees` tally (§3).
- `src/loop/pr-feedback-poller.test.ts` — new/expanded tests (per plan §"How it will be tested").

**Not touched:** `src/integration/github.ts` (interface unchanged), `src/integration/github-cli.ts`
(building blocks unchanged), `src/loop/scheduler-poller.ts`, `src/agent/side-effects.ts` (outbox does
not apply — these are idempotent local git ops from a poller, not non-idempotent GitHub API calls in a
stage), and `src/fsm/` (forbidden by the issue).
