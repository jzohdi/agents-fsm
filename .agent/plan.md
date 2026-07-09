# Plan — Opt-in auto-merge of approved PRs (agents-fsm#15)

## Goal (restated)

Let a run that reaches the terminal `done` state **auto-merge its PR into base** instead of parking
for a human, gated behind a new opt-in **per-repo `auto_merge` flag (default off)**. Today `done`
means merge-ready and a human always merges (`src/agent/runner.ts:1376` — "Merge-ready, not
auto-merged"; README §1 lists auto-merge as out-of-scope for the MVP). Auto-merge introduces **no new
approval bypass**: it fires on *exactly the same signal `done` already requires* (a run reaching the
terminal `done` state via `code_review`'s `approve`) and only automates the mechanical merge step a
human would otherwise perform. This closes the continuous-mode dependency chain (§3.5): a dependent
run is released when its dependency's **issue closes** (the merge signal), which auto-merge now
produces without a human.

## Current behavior (grounded)

- A run reaches `done` in `EventLoop.applyEvent` (`src/loop/event-loop.ts:810-850`): when the FSM
  decision lands on a terminal state, status is set to `done` (or `needs_human` for the escalation
  state) and — because it is terminal — **no follow-up `EVENT_ADVANCE` is enqueued**. The run stops.
- `runs.status = 'running'` is the dispatch gate (`Repository.claimNextEvent`,
  `src/store/repository.ts:1006`): a `done` run's events are never claimed. So any post-`done` work
  must be modeled as a **loop-owned control operation** that first moves the run into a *non-terminal
  pseudo-state* (status `running`) and enqueues its own event — exactly how `resolveMergeConflict`
  (`event-loop.ts:511`) + `EVENT_RESOLVE_CONFLICTS` + `RESOLVE_CONFLICTS_STATE` already work. These
  pseudo-states are **plain loop constants, not FSM states** — `decideNext` is never called for them —
  so they need **no `src/fsm/` change** (memory: never touch `src/fsm/`).
- The GitHub adapter (`src/integration/github.ts`) has **no merge method today**; `getPr` exposes
  `state: 'open' | 'closed' | 'merged'` and `mergeable: 'mergeable' | 'conflicting' | 'unknown'`.
- The PR body always contains `Closes #N` (`runner.ts:1381/1384`), so a real GitHub merge auto-closes
  the linked issue → the Scheduler's dependency signal (issue-closed, `scheduler-poller.ts:153`) fires.
- Per-repo flags follow a fixed pattern (`conflict_policy`, `source_mode`, `watch`,
  `watch_in_flight_cap`): additive migration + `schema.sql` mirror → `Repo` interface + `RepoRow` +
  `mapRepo` → dedicated setter that a re-enroll never clobbers → orchestrator method + server route →
  dashboard type + store fn + Home.svelte toggle.

## Approach & architecture

Model auto-merge as a **loop-owned pseudo-state entered in place of `done`** when the flag is on,
mirroring the established `resolveMergeConflict` scaffolding.

When `applyEvent` computes a terminal transition whose target is the **`done` state** (i.e. not the
escalation state), the run has a PR, and `auto_merge` is enabled for its repo:
1. Commit the transition into a new **`AUTO_MERGE_STATE`** pseudo-state with status `running` (instead
   of committing straight to `done`), and enqueue an **`EVENT_AUTO_MERGE`** whose payload remembers the
   intended terminal target (`done` state name). This keeps the approval gate identical — we only
   interpose the merge *after* the FSM has decided `done` and *before* finalizing it.
2. A dedicated dispatch handler **`applyAutoMerge`** (routed in `processEvent` alongside
   `EVENT_RESOLVE_CONFLICTS` at `event-loop.ts:706`) calls a new runner method
   `AgentRunner.autoMergePr(run)`, which resolves the repo's GitHub adapter (`repoContext`) and calls
   the new **`github.mergePr(...)`**, guarded by the M7 side-effect ledger (`ledgerFor(run).once(...)`)
   so a crash/replay never double-merges.
   - **Success** → commit the pseudo-state → `done` transition (status `done`, trigger `auto_merged`).
     The PR is merged; `Closes #N` closes the issue → the dependency signal fires (criterion 5).
   - **Not mergeable / merge failed** (conflict, base moved, checks unsatisfied) → **do not force**;
     `escalate(run, event, 'auto_merge_failed', reason)` → status `needs_human`, carrying the
     mergeability/error detail. The PR is left merge-ready and surfaced in the attention queue, not
     lost (criterion 4). The existing PR Feedback Poller keeps watching the PR.

When the flag is **off** (default) the `AUTO_MERGE_STATE` branch is not taken: `applyEvent` commits
`done` exactly as today — zero behavior change (criterion 2). This is the whole reason the pseudo-state
approach is preferred over merging inline in the commit path: it is recovery-safe (event replay +
idempotent ledgered merge), telemetry-clean (dashboard shows a distinct "auto_merge" state, never a
masqueraded stage), and reuses machinery the codebase already trusts.

### Merge method & branch deletion

`gh pr merge` requires an explicit method. Default to **`--merge`** (a merge commit — most
conservative, preserves history) with **`--delete-branch`** (per-run branches are disposable; mirrors
typical human cleanup and keeps the branch list clean). This is called out explicitly per the issue;
making the method configurable is deferred (not in scope). Merge into the PR's own base only — never
stack (the adapter merges by PR number into its recorded base, honoring the no-stacked-PRs discipline).

## Files to change

### Backend — persistence
- `src/store/schema.sql` — append `auto_merge INTEGER NOT NULL DEFAULT 0` to the `repos` table (last
  column, matching the additive-migration column order — the db-drift guard convention).
- `src/store/migrations.ts` — add migration **version 18** `add repos.auto_merge`:
  `addColumnIfMissing(db, 'repos', 'auto_merge', 'INTEGER NOT NULL DEFAULT 0')`. Pre-existing DBs
  backfill to off (behavior unchanged); fresh DBs get it from `schema.sql`.
- `src/store/repository.ts` — add `autoMerge: boolean` to the `Repo` interface; `auto_merge: number`
  to `RepoRow`; `autoMerge: r.auto_merge !== 0` in `mapRepo`; and a
  `setRepoAutoMerge(repoRef, enabled)` setter (single `UPDATE repos SET auto_merge = ?`), persisted
  independently of enrollment like `setRepoConflictPolicy` (a re-enroll / `upsertRepo` never resets it).

### Backend — GitHub adapter seam
- `src/integration/github.ts` — add to the `GitHub` interface:
  `mergePr(input: { prNumber: number; base: string; method?: 'merge'; deleteBranch?: boolean }):
  Promise<MergeResult>` where `MergeResult = { merged: true } | { merged: false; reason: string;
  mergeable?: PullRequest['mergeable'] }`. Document that it must not force and returns `merged:false`
  on any non-mergeable/failed merge.
- `src/integration/github-cli.ts` — implement via `gh pr merge <n> --repo <repo> --merge
  --delete-branch` (+ `--body`/no-edit as needed); non-zero exit → `{ merged: false, reason: stderr }`.
  Treat an already-merged PR as `{ merged: true }` (idempotent under ledger replay).
- `src/integration/github-fake.ts` — implement `mergePr`: set the PR's `state = 'merged'`, and **parse
  the PR body for `Closes/Fixes/Resolves #N` closing keywords and close those issues** (mirrors
  GitHub), so the Scheduler dependency signal fires end-to-end in tests. Return `{ merged: false }`
  when the PR's `mergeable === 'conflicting'` (lets tests drive the non-mergeable path via the existing
  `setPrMergeable`). Keep it in sync with the interface (mirrored fake is required by the issue).

### Backend — loop / runner
- `src/loop/event-loop.ts` —
  - New constants `AUTO_MERGE_STATE = 'auto_merge'`, `EVENT_AUTO_MERGE = 'auto_merge'`, trigger
    strings `AUTO_MERGE_TRIGGER` / `AUTO_MERGED_TRIGGER` / `AUTO_MERGE_FAILED_TRIGGER`.
  - In `applyEvent`, at the terminal-`done` branch (`~event-loop.ts:810-846`): when the target is the
    `done` state (not escalation), `run.prNumber !== null`, and the repo's `auto_merge` is on, commit
    into `AUTO_MERGE_STATE`/status `running` and enqueue `EVENT_AUTO_MERGE` (payload: intended
    `doneState`) in the same transaction, instead of committing `done`. All other terminal/paused/
    stopped paths unchanged.
  - Route `EVENT_AUTO_MERGE` in `processEvent` (next to line 706) to a new `applyAutoMerge(run, event)`
    handler modeled on `applyConflictResolution` (`event-loop.ts:859`): call
    `runner.autoMergePr(run)`; on `{ kind: 'merged' }` commit `AUTO_MERGE_STATE → done` (status
    `done`); on `{ kind: 'escalate', reason }` call `escalate(...)`. Honor the shutdown-latch rule
    (`ShutdownInterruptError`) exactly as the conflict handler does.
- `src/agent/runner.ts` — add `autoMergePr(run): Promise<{ kind: 'merged' } | { kind: 'escalate';
  reason: unknown }>`: resolve `repoContext(run).github` + base branch, call `github.mergePr(...)`
  ledger-guarded (`ledgerFor(run).once('auto_merge', ...)`); map `merged:true → merged`,
  `merged:false → escalate` with a structured reason. Add a small `autoMergeEnabled(run)` helper
  (`this.repo.getRepo(run.repoRef)?.autoMerge ?? false`) mirroring the existing `conflictPolicy`
  reader at `runner.ts:577`, OR read the flag in the loop — decide during implementation, keeping the
  flag read fresh at dispatch (consistent with conflict_policy).

### Backend — API surface
- `src/api/orchestrator.ts` — add `setRepoAutoMerge({ repoRef, enabled: boolean }): Repo` mirroring
  `setRepoConflictPolicy` (`orchestrator.ts:921`): validate `repoRef`, require enrollment (404 if not),
  call `repo.setRepoAutoMerge`, return the updated repo.
- `src/api/server.ts` — add `POST /repos/auto-merge` route mirroring `/repos/conflict-policy`
  (`server.ts:288`); body-carried `repoRef` + boolean `enabled`.

### Frontend — dashboard
- `dashboard/src/lib/types.ts` — add `autoMerge: boolean` to the `Repo` type (next to
  `conflictPolicy`, `types.ts:244`).
- `dashboard/src/lib/store.svelte.ts` — add `setRepoAutoMerge(repoRef, enabled)` calling
  `POST /repos/auto-merge` (mirrors `setRepoConflictPolicy`, `store.svelte.ts:240`).
- `dashboard/src/lib/Home.svelte` — add an auto-merge toggle to the repo row next to the conflict-policy
  toggle (`Home.svelte:416-429`), disabled when not enrolled. **Label carefully**: the existing
  conflict-policy pill already renders the text "Auto-merge" for auto *conflict resolution* — to avoid
  confusion, label the new toggle e.g. **"Auto-merge PRs" / "Merge on approve: off"** (and reword the
  conflict pill's label if the collision is too close). `render.ts`/`render.test.ts` may need a matching
  field if repo rows are rendered there.

### Docs
- `README.md` — update §1 out-of-scope list (auto-merge is no longer "out of scope"; note it as an
  opt-in per-repo flag, default off), the `done`-state description (§table row / §3.1), and §3.5 to
  say auto-merge can now produce the merge signal without a human. Re-run `docs.readme.test.ts`
  (asserts doc invariants; the status test counts are frozen-as-shipped — do not invent a live tally).

## Risks & edge cases

- **No approval bypass (the security-critical invariant).** Auto-merge must fire *only* when the FSM
  itself decided the terminal `done` transition (post-`code_review` `approve`). Do not add any
  independent "is approved?" check — reuse the existing terminal-`done` decision as the sole gate.
- **Non-mergeable / base moved / checks failing** → never `--force`/`--admin`. `mergePr` returns
  `merged:false`; the run escalates to `needs_human` with the reason. Reuse of existing merge-conflict
  handling: a run escalated here still has an open PR, so the PR Feedback Poller (and, under `auto`
  `conflict_policy`, `resolveMergeConflict`) continue to apply. (Optional future enhancement, out of
  scope now: on `mergeable === 'conflicting'` route straight to `resolveMergeConflict` then retry.)
- **Crash/recovery idempotency.** The ledgered `mergePr` + event replay make a re-dispatched
  `EVENT_AUTO_MERGE` safe; the adapter treats an already-merged PR as success.
- **`run.prNumber === null`** (should not happen at `done`, but guard): fall back to committing plain
  `done` rather than entering the pseudo-state, so a PR-less run is never wedged.
- **Dashboard label collision** with the existing conflict-policy "Auto-merge" text — resolve during
  frontend work so operators aren't misled.
- **Flag read freshness / re-enroll safety** — `setRepoAutoMerge` writes only `auto_merge`; `upsertRepo`
  must continue to leave it untouched (verify it is not in the upsert column list, like the watch cols).

## Testing

- `src/store/repository.test.ts` — new repo defaults `autoMerge: false`; `setRepoAutoMerge` toggles it;
  a subsequent `upsertRepo`/re-enroll does not reset it (mirrors the conflict-policy test).
- `src/store/db.test.ts` / migration test — migration 18 applies idempotently; column present, default 0.
- `src/integration/github-fake.test.ts` — `mergePr` sets `state: 'merged'`, closes the `Closes #N`
  issue, and returns `merged:false` when `mergeable === 'conflicting'`.
- `src/api/orchestrator.test.ts` + `src/api/server.test.ts` — `/repos/auto-merge` validates
  `repoRef`/enrollment and persists the flag.
- **Loop behavior** (new focused test in `src/loop/event-loop.test.ts` or an integration test using the
  fake, covering criteria 2/3/4):
  - flag **off** → a run reaching approve/`done` parks `done`, PR still `open` (unchanged).
  - flag **on** → run reaches `done`, PR `state === 'merged'`, run status `done`.
  - flag **on** but PR `mergeable === 'conflicting'` (via `setPrMergeable`) → run escalates
    `needs_human`, PR **not** merged (no force), and is still surfaced.
- **Dependency signal (criterion 5)** — extend the `dependency-gate` / `real-e2e` style test (fake):
  with `auto_merge` on, A reaching `done` merges its PR → closes A's issue → the Scheduler wakes the
  dependent B **without a human merge**.
- `dashboard/src/lib/render.test.ts` — if repo rows render the flag, cover it.
- Run full `npm test` + `docs.readme.test.ts` after README edits.

## Scope flags
- `needs_backend: true` — migration, repository accessor, GitHub adapter + fake, loop/runner wiring, API.
- `needs_frontend: true` — dashboard type, store fn, Home.svelte toggle.
