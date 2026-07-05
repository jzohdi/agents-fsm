# Plan — Clean up a run's worktree and freshen local base when its PR merges (agents-fsm#20)

## Goal (restated)

Per-run git worktrees (`<workingRoot>/run-<id>`) accumulate on disk and are never reclaimed, so a
fleet's disk usage grows unbounded. When a run's PR is **detected merged** — the terminal,
external/polled merge signal, **not** the `done` transition — the orchestrator should, exactly once
and idempotently:

1. **Reclaim the run's local working tree** — remove the `run-<id>` worktree *and* de-register it
   properly (not a bare `rm`), in both `clone` and `local` source modes.
2. **Freshen the local base branch** — fetch + fast-forward the operator's local base (e.g. `main`) so
   future worktrees branch off up-to-date refs and the operator's checkout stays current. A no-op in
   `clone` mode and when the local checkout is dirty or off-base.

This must **not** touch `src/fsm/`, must **not** fire while the PR is still open/merge-ready (`done`
alone must not trigger it), and must be safe to re-run across crash/restart.

## How the system works today (grounding)

- **`done` ≠ merged.** `done` means merge-ready (PR open, unmerged). A human merges; the merge is
  observed later by a **polled signal**, not by any FSM transition (README §3.5 / Milestone 9).
- **The merge-detection path already exists** in `src/loop/pr-feedback-poller.ts` →
  `PrFeedbackPoller.processRun`. Each tick it reads the finished run's PR (`github.getPr`). When the PR
  is no longer open it flags the run stopped (`PR_FEEDBACK_CLOSED_FLAG`) so it is never watched again,
  and **on `pr.state === 'merged'` it already calls `github.syncBaseBranch(baseBranch)`** (best-effort,
  guarded) — added for Milestone 12. This is precisely the hook the issue asks for. Both the background
  `checkOnce` loop and the dashboard's on-demand `checkRun` funnel through `processRun`, so wiring here
  covers both.
- **The two building blocks are complete and already mode-aware** (do **not** rebuild them):
  - `github.dropWorkingTree(runId)` (`src/integration/github.ts` iface;
    `github-cli.ts:318`; `github-fake.ts:374`). In `local` mode it runs `git worktree remove --force`
    + `git worktree prune` (de-registers, not a bare rm); in `clone` mode it `rm -rf`s the dir. Both are
    idempotent — a missing tree is a no-op (`--force` / `execIgnore` swallow the error). Currently the
    **only** caller is the Scheduler Poller (`scheduler-poller.ts:182`) when waking a dependency-blocked
    run onto a fresh base.
  - `github.syncBaseBranch(base)` (`github-cli.ts:334`; `github-fake.ts:382`). `local` mode: `git fetch
    origin`, then `git merge --ff-only origin/<base>` **only** when the checkout is on `base` with a clean
    tree (else it returns after just the fetch — never disturbs the operator's WIP or another branch).
    `clone` mode (`!this.localRepo`): returns immediately, a no-op. Currently the only caller is this same
    merged branch in `processRun`.
- **Adapter-level mode behavior is already unit-tested** in `src/integration/github-cli.test.ts`:
  `dropWorkingTree` de-registers the worktree (local) and handles clone/lost-tree; `syncBaseBranch`
  fast-forwards a clean on-base checkout, leaves a dirty/off-base one alone, and is a no-op for clone
  mode. So this change only needs to prove the *wiring* fires them on merge — not re-prove their
  per-mode semantics.
- **Transactional outbox** (`src/agent/side-effects.ts`) is for **non-idempotent GitHub API calls**
  made *inside a runner stage*, keyed by state-visit. It does **not** apply here: `dropWorkingTree` and
  `syncBaseBranch` are **idempotent local git operations** run from a background poller, not a stage.
  The issue's phrasing ("via the outbox *where a non-idempotent GitHub call is involved*") is
  conditional and no such call is involved — the flag + idempotent-retry gives once-only semantics.

## Approach

Extend the existing `pr.state === 'merged'` branch in `PrFeedbackPoller.processRun` to also reclaim the
run's worktree, and reorder so the reclaim happens **before** the run is flagged stopped — making the
poller's existing per-run retry the crash-safety mechanism.

Target shape of the `pr.state !== 'open'` block (in `processRun`):

```ts
const pr = await github.getPr(prNumber);
if (pr.state !== 'open') {
  if (pr.state === 'merged') {
    // Merge is the terminal signal (issue #20): reclaim disk + freshen base, exactly once.
    // dropWorkingTree runs BEFORE we flag the run stopped: if it throws (or the daemon crashes
    // mid-reclaim) the flag is never set, the run stays watched, and the next tick retries
    // (getPr still 'merged'). Both ops are idempotent — a missing tree is a no-op — so re-running
    // is safe. Removal applies to clone AND local modes.
    await github.dropWorkingTree(run.id);
    // Freshen the operator's local base (local mode: ff a clean on-base checkout; clone/dirty/off-base:
    // no-op). Best-effort: a freshen miss is cosmetic (next merge / prepareWorkingTree's fetch recovers)
    // and must not wedge the stop flag or abort the pass.
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

### Why this satisfies every acceptance criterion

- **Worktree removed + de-listed, both modes:** `dropWorkingTree` is invoked on merge; its adapter
  already does `worktree remove --force` + `prune` (local) or `rm -rf` (clone).
- **Base fast-forwarded (local) / no-op (clone/dirty/off-base):** unchanged `syncBaseBranch` call; its
  adapter already encodes the guards.
- **At most once + idempotent across crash/restart:** on the happy path the `PR_FEEDBACK_CLOSED_FLAG`
  drops the run out of `watchedRuns()`, so cleanup fires once. If reclaim fails or the daemon crashes
  before the flag is set, the run stays watched and the next tick re-runs both ops — both idempotent, so
  a missing tree / already-ff'd base is a no-op, not an error. Placing `dropWorkingTree` **before** the
  flag (today `syncBaseBranch` sits *after* it) is the key change that makes the reclaim crash-safe.
- **Never fires on `done` alone:** `processRun` only reaches this block when `getPr` reports the PR is no
  longer open; a `done` run with an open PR takes the `watching`/`reopened` paths. The FSM is untouched.
- **Doesn't disturb still-active runs sharing the checkout:** `dropWorkingTree(run.id)` removes only
  *this* run's `run-<id>` worktree (siblings are separate worktrees); `syncBaseBranch` ff's the shared
  checkout only when it's clean and on-base, so an operator (or another run) mid-work is left alone.

### Why not alternatives

- **Hook off the `done` transition / a new FSM state** — wrong by construction: `done` ≠ merged, and the
  issue forbids touching `src/fsm/`. Merge is only known via the poller.
- **A separate new poller / dedicated merge-cleanup service** — redundant: `processRun` already detects
  merge, already calls `syncBaseBranch`, already has the once-only flag and per-run error isolation.
  Adding one line + a reorder reuses all of it; a new poller would duplicate the getPr read and the
  stop-watching bookkeeping.
- **Wrap in the side-effects outbox** — unnecessary and mis-scoped (see above): these are idempotent
  local git ops from a poller, not non-idempotent GitHub API calls inside a stage.

## Files to change

- `src/loop/pr-feedback-poller.ts` — in `processRun`, add `await github.dropWorkingTree(run.id)` inside
  the `pr.state === 'merged'` branch, ordered before `mergeRunFlags` sets the stop flag; keep
  `syncBaseBranch` best-effort. Refresh the surrounding doc comment (and the file-header "Stops on
  merge/close" bullet) to note the merge-triggered reclaim.
- `src/integration/github-fake.ts` — add a `droppedTrees: number[]` tally to `dropWorkingTree` (mirroring
  the existing `syncedBases` array) so poller tests can assert the reclaim fired and count invocations
  (for the idempotent/once assertions). Keep the existing `workingTrees.delete` behavior.
- `src/loop/pr-feedback-poller.test.ts` — new/expanded tests (below).

No changes to `src/integration/github.ts` (interface unchanged), `github-cli.ts` (building blocks
unchanged), `scheduler-poller.ts`, or `src/fsm/` (untouched).

## Risks & edge cases

- **Ordering regression:** moving the flag-set to *after* the reclaim means a persistent
  `dropWorkingTree` failure keeps the run in the watch set (logging one warn/tick via `checkOnce`'s
  catch). Acceptable and intended — it's the retry that gives crash-safety; `dropWorkingTree` only throws
  on a genuine git failure (a missing tree is already a no-op). `syncBaseBranch` stays best-effort so a
  base-freshen network blip never blocks the stop flag.
- **`closed` (abandoned, not merged) PRs:** unchanged — they set the stop flag with no cleanup (worktree
  reclaim for abandoned PRs is out of scope; only `merged` triggers it, matching the acceptance criteria).
- **On-demand `checkRun`** shares `processRun`, so a dashboard "Check now" on a merged PR performs the
  same reclaim — consistent with a background tick (already asserted in the existing `checkRun` test,
  which now also drops the tree).
- **Double-fire safety:** even if two ticks race (or `checkRun` overlaps a background tick), both ops are
  idempotent, so the worst case is a redundant no-op.

## How it will be tested

Unit tests in `src/loop/pr-feedback-poller.test.ts` (Vitest, against `GitHubFake`):

1. **merge → worktree reclaimed + base freshened, once.** Run to `done`; ensure a tree exists
   (`prepareWorkingTree`); `setPrState(pr, 'merged')`; `checkOnce()` → assert the run's tree was dropped
   (`github.droppedTrees` contains `run.id`) **and** `github.syncedBases` recorded the base. Assert the
   stop flag is set and status stays `done`.
2. **idempotent re-run / at-most-once.** After (1), a second `checkOnce()` is a no-op — the flagged run
   leaves the watch set, so `droppedTrees`/`syncedBases` do not grow (count stays 1). Separately, drive
   the reclaim twice directly (e.g. via `checkRun` before the flag lands) to show re-running is safe (no
   throw) — a missing tree is a no-op.
3. **`done` alone does not reclaim.** With the PR still `open`, `checkOnce()`/`checkRun()` return
   `watching` and `droppedTrees` stays empty.
4. **`closed` (abandoned) does not reclaim.** `setPrState(pr, 'closed')` → run flagged stopped,
   `droppedTrees` empty, `syncedBases` empty.
5. **reclaim failure keeps the run watched + retries.** Stub `github.dropWorkingTree` to throw once →
   `checkOnce()` logs the warn, the stop flag is **not** set (run still watched); on the next tick (drop
   succeeding) the reclaim completes and the flag lands. Proves crash/restart idempotency at the poller
   level.
6. **base-sync failure is best-effort.** Stub `syncBaseBranch` to reject → the worktree is still dropped,
   a `post_merge_sync_error` warn is logged, and the run is still flagged stopped (a freshen miss does not
   wedge cleanup).

Per-mode behavior of `dropWorkingTree` (de-register in local, rm in clone) and `syncBaseBranch` (ff on
clean on-base, leave dirty/off-base, no-op for clone) is **already** covered by real-git tests in
`src/integration/github-cli.test.ts`; this change relies on those and does not duplicate them. Full
suite (`npm test`) plus lint/typecheck run before handoff.

## Scope

Backend only — a background poller + integration adapter + tests. No UI/frontend surface changes.
