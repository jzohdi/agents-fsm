# Interface — Opt-in auto-merge of approved PRs (agents-fsm#15)

Contracts the `tdd` stage writes failing tests against, and the implementation satisfies. Grounded in
the plan (`.agent/plan.md`) and the current code. Layered outward: persistence → adapter seam →
loop/runner → API → dashboard. Every signature below is exact; where a choice is deferred to
implementation it says so.

**The security-critical invariant (repeated everywhere it applies):** auto-merge introduces **no new
approval gate**. It fires **only** when `applyEvent`'s FSM decision has already landed on the terminal
`done` state (i.e. `code_review`'s `approve`). There is **no independent "is approved?" check** — the
existing terminal-`done` decision is the sole authorization. When the flag is off, the code path is
byte-for-byte unchanged.

---

## 1. Persistence — per-repo `auto_merge` flag

Mirror the existing per-repo flag pattern (`conflict_policy`, `watch`, `source_mode`) exactly.

### 1.1 `src/store/schema.sql`
Append to the `repos` table, as the **last** column (additive-column-order / db-drift convention):
```sql
auto_merge INTEGER NOT NULL DEFAULT 0
```

### 1.2 `src/store/migrations.ts`
Add migration **version 18** (17 is the current max), titled `add repos.auto_merge`:
```ts
addColumnIfMissing(db, 'repos', 'auto_merge', 'INTEGER NOT NULL DEFAULT 0')
```
Invariants:
- Idempotent: applying twice is a no-op (`addColumnIfMissing` guard).
- Pre-existing DBs backfill every repo to `0` (off) → behavior unchanged.
- Fresh DBs get the column from `schema.sql`; the migrated shape and the `schema.sql` shape are
  identical (the db-drift guard test asserts this).

### 1.3 `src/store/repository.ts`
- **`Repo` interface** — add, adjacent to `conflictPolicy` (repository.ts:193):
  ```ts
  /** Opt-in auto-merge (agents-fsm#15): when true, a run reaching the terminal `done` state merges its
   *  PR into base via the GitHub adapter instead of parking merge-ready for a human. Gated on exactly
   *  the same approved signal `done` already requires — no new approval bypass. Default `false`. */
  autoMerge: boolean;
  ```
- **`RepoRow` interface** (repository.ts:371) — add `auto_merge: number;`.
- **`mapRepo`** (repository.ts:485) — add `autoMerge: r.auto_merge !== 0,` (mirrors `watch: r.watch !== 0`).
- **New setter**, modeled verbatim on `setRepoConflictPolicy` (repository.ts:576):
  ```ts
  /** Set a repo's auto-merge flag ({@link Repo.autoMerge}). Persisted independently of enrollment,
   *  like watch/source/conflict-policy: a re-enroll (`upsertRepo`) never resets the operator's choice. */
  setRepoAutoMerge(repoRef: string, enabled: boolean): void {
    this.db.prepare('UPDATE repos SET auto_merge = ? WHERE repo_ref = ? COLLATE NOCASE')
      .run(enabled ? 1 : 0, repoRef);
  }
  ```
- **`upsertRepo` invariant (re-enroll safety):** `upsertRepo` must **not** list `auto_merge` in its
  INSERT/UPDATE column set — exactly like the `watch*` and `conflict_policy` columns. A re-enroll of an
  already-enrolled repo leaves `auto_merge` untouched. (Verify against the current upsert SQL.)

---

## 2. GitHub adapter seam — a merge method

### 2.1 `src/integration/github.ts`
New result type + interface method (place the method near `getPr`/`updatePr`, ~line 365):
```ts
/**
 * Outcome of an auto-merge attempt (agents-fsm#15). A discriminated result, never a throw for the
 * expected "not mergeable" case: `merged:false` is a normal, first-class outcome the loop escalates on.
 * `merged:true` includes the already-merged case (idempotent under ledger replay).
 */
export type MergeResult =
  | { merged: true }
  | { merged: false; reason: string; mergeable?: PullRequest['mergeable'] };

export interface MergePrInput {
  prNumber: number;
  /** The PR's own base — merge into this and never stack (no-stacked-PRs discipline). */
  base: string;
  /** Merge strategy. Only `'merge'` (a merge commit) is used today; typed narrow to leave room. */
  method?: 'merge';
  /** Delete the (disposable per-run) branch after a successful merge. Default true at the call site. */
  deleteBranch?: boolean;
}
```
Add to the `GitHub` interface:
```ts
/**
 * Merge a PR into its base (agents-fsm#15 auto-merge). **Never forces**: on any non-mergeable/failed
 * merge (conflict, base moved, required checks unsatisfied, permission) it returns
 * `{ merged:false, reason, mergeable? }` and leaves the PR open — it must not `--force`/`--admin`.
 * An already-merged PR returns `{ merged:true }` (idempotent under ledger replay). Merges into the
 * PR's recorded base only; never stacks.
 */
mergePr(input: MergePrInput): Promise<MergeResult>;
```

### 2.2 `src/integration/github-cli.ts`
Implement via `gh pr merge <prNumber> --repo <repo> --merge --delete-branch` (see §5 for the
method/branch-deletion rationale). Contract:
- Zero exit → `{ merged: true }`.
- Non-zero exit → `{ merged: false, reason: <stderr, trimmed> }`. Do **not** pass `--admin`/`--force`.
- An already-merged PR (gh reports "not mergeable"/"already merged") → treat as `{ merged: true }`
  (idempotent). If a `getPr` cross-check is cheap, prefer confirming `state === 'merged'` over string
  matching — decide during implementation; the contract is only that a genuinely-merged PR reads as
  `merged:true`.

### 2.3 `src/integration/github-fake.ts`
Implement `mergePr` so the whole pipeline (incl. the continuous-mode dependency signal) runs against
the fake with zero network. Behavior:
- If the PR's `mergeable === 'conflicting'` → return `{ merged: false, reason: 'conflicting', mergeable:
  'conflicting' }` and do **not** change the PR state. (Lets tests drive the non-mergeable path via the
  existing `setPrMergeable(prNumber, 'conflicting')`.)
- If the PR is already `state === 'merged'` → return `{ merged: true }`, no-op (idempotency).
- Otherwise: set the PR's `state = 'merged'`; **parse the PR body** for GitHub closing keywords
  (`Closes|Fixes|Resolves #N`, case-insensitive) and mark each referenced issue `state = 'closed'`
  (reusing the internal close path, mirroring `closeIssue`). Return `{ merged: true }`.
  - This is what makes criterion 5 testable end-to-end: the fleet PR body always contains `Closes #N`
    (runner.ts prBody), so merging it closes the issue → the Scheduler's issue-closed dependency signal
    fires without a human.
- Honor `deleteBranch` cosmetically at most (the fake has no branch registry to prune); it must not
  affect the result. Keep the method signature identical to the interface (mirrored fake is required by
  the issue).

New test helper (parallels `setPrState`/`setPrMergeable`, not on the `GitHub` interface) if useful:
none strictly required — `setPrMergeable` + `listPrs`/`getPr` + `readIssue` already let tests assert
merged state and issue closure.

---

## 3. Loop & runner — the auto-merge pseudo-state

Auto-merge is a **loop-owned control operation**, modeled as a pseudo-state entered *in place of*
`done`, mirroring `RESOLVE_CONFLICTS_STATE`. **No `src/fsm/` change** — `decideNext` is never called
for a pseudo-state (memory: never touch `src/fsm/`).

### 3.1 `src/loop/event-loop.ts` — new constants (near the resolve-conflicts constants, ~line 35–56)
```ts
/** Event type for the loop-owned auto-merge step (agents-fsm#15). Like EVENT_RESOLVE_CONFLICTS it does
 *  NOT run the stage pipeline — it dispatches only the adapter merge and then finalizes the run to the
 *  terminal `done` state it was headed for. Payload carries `doneState` (the intended terminal target). */
export const EVENT_AUTO_MERGE = 'auto_merge';

/** The pseudo-state a run occupies WHILE its PR is being auto-merged. Not an FSM state (loop-owned,
 *  like resolve_conflicts) — used as the transition target, the `agent_runs.stage`/telemetry label, so
 *  the dashboard shows a distinct "auto_merge", never a masqueraded `done`. */
export const AUTO_MERGE_STATE = 'auto_merge';

/** Trigger on the control transition that ENTERS AUTO_MERGE_STATE (in place of committing `done`). */
export const AUTO_MERGE_TRIGGER = 'auto_merge';

/** Trigger on the transition AUTO_MERGE_STATE → doneState after the PR merged successfully. */
export const AUTO_MERGED_TRIGGER = 'auto_merged';

/** Escalation trigger when the PR was not mergeable / the merge failed (never forced). */
export const AUTO_MERGE_FAILED_TRIGGER = 'auto_merge_failed';
```

### 3.2 `applyEvent` — interpose the pseudo-state at the terminal-`done` branch
Current code computes `terminal`/`status`/`decision.to` (event-loop.ts:810–847) and, in the terminal
transaction, commits `decision.to` and (because terminal) enqueues no follow-up event.

Add a branch taken **only when all of** the following hold:
1. `terminal === true` **and** `decision.to` is the `done` state — i.e. `decision.to !== this.fsm.escalationState`
   (this is the sole approval gate; do not add any other check),
2. `run.prNumber !== null` (guard — a PR-less run must never wedge; §6),
3. auto-merge is enabled for the run's repo (read fresh — see §3.5).

When taken, **instead of** committing `done`, in the same transaction:
- commit the transition `fromState = run.currentState` → `toState = AUTO_MERGE_STATE`, `trigger =
  AUTO_MERGE_TRIGGER`, `status = 'running'`, `eventId = event.id`, carrying `envelope.reason`/flags/
  artifacts exactly as the normal terminal commit would (so nothing the approving review produced is
  lost);
- enqueue `EVENT_AUTO_MERGE` with `payload: { doneState: decision.to }`.

All other terminal/paused/stopped/escalation paths are **unchanged**. The `pause`/`stop` mid-stage
handling (interrupted status, event-loop.ts:816–823) still wins: if the run was paused/stopped mid
approval, take the normal path, not auto-merge (only enter the pseudo-state when the resolved `status`
would have been `done`).

**Flag off (default):** none of this fires; the terminal commit path is identical to today (criterion 2).

### 3.3 Route `EVENT_AUTO_MERGE` in `applyEvent`
Alongside the resolve-conflicts branch (event-loop.ts:706), before the config/budget stage machinery:
```ts
if (event.type === EVENT_AUTO_MERGE) return this.applyAutoMerge(run, event);
```

### 3.4 New private handler `applyAutoMerge`, modeled on `applyConflictResolution` (event-loop.ts:859)
```ts
private async applyAutoMerge(run: Run, event: EventRow): Promise<void>
```
Behavior:
- `doneState = (event.payload as { doneState?: string }).doneState ?? <the fsm's done/terminal target>`.
  (Fall back defensively; `doneState` is always set by §3.2.)
- Call `outcome = await this.runner.autoMergePr(run)` inside try/catch.
  - **Shutdown rule (mandatory, same as `applyConflictResolution`):** if a throw or an escalate outcome
    happens while `this.shuttingDown`, throw `ShutdownInterruptError` so the event stays `processing`
    for recovery — never park the run for our own interruption.
  - `FatalExecutorError` propagates.
  - Any other throw (not shutting down) → `this.escalate(run, event, 'executor_error', { error: String(err) })`.
- On `outcome.kind === 'merged'`: commit the finalizing transition out of the pseudo-state:
  `fromState = run.currentState` (AUTO_MERGE_STATE) → `toState = doneState`, `trigger =
  AUTO_MERGED_TRIGGER`, `status = 'done'`, `eventId = event.id`, `reason = { kind: 'auto_merged',
  prNumber: run.prNumber }`. Because `doneState` is terminal, **no follow-up event** is enqueued (run
  stops at `done`, PR merged, issue closed → dependency signal fires: criterion 5).
- On `outcome.kind === 'escalate'`: `this.escalate(run, event, AUTO_MERGE_FAILED_TRIGGER, outcome.reason)`
  → status `needs_human`, `toState = escalationState`. The PR stays open + merge-ready and surfaces in
  the attention queue; the PR Feedback Poller keeps watching it (criterion 4). **Never forced.**

Idempotency under recovery: `processEvent` finalizes-only when a transition already exists for the
event id (event-loop.ts:685); the runner's merge is ledger-guarded (§3.6) and the adapter treats an
already-merged PR as success — so a re-dispatched `EVENT_AUTO_MERGE` never double-merges.

### 3.5 Flag freshness — where the `auto_merge` flag is read
Read the flag **fresh at dispatch time**, consistent with `conflictPolicy` (runner.ts:576) — a
dashboard toggle applies from the next decision. Recommended placement: a small runner reader

```ts
/** The repo's auto-merge flag, read fresh from the registry (a dashboard change applies immediately).
 *  Runs without a registry row (one-shot CLI, mocks) default to `false` (off — conservative). */
autoMergeEnabled(run: Run): boolean {
  return this.repo.getRepo(run.repoRef)?.autoMerge ?? false;
}
```
`applyEvent` (§3.2 condition 3) calls `this.runner.autoMergeEnabled(run)`. (Reading it in the loop
directly via `this.repo.getRepo(...)` is an acceptable equivalent — implementer's choice, as the plan
notes; the observable contract is only that the flag is read at dispatch, defaults to `false` when
absent, and is never cached across stages.)

### 3.6 `src/agent/runner.ts` — new method `autoMergePr`
```ts
/**
 * Merge a finished run's PR into base (agents-fsm#15). Loop-owned, dispatched by applyAutoMerge only
 * after the FSM decided the terminal `done` transition — this method performs the mechanical merge, it
 * does NOT re-check approval. Ledger-guarded so a crash/replay never double-merges; maps the adapter's
 * MergeResult to the loop's disposition. Never forces: a non-mergeable PR becomes an `escalate`.
 */
async autoMergePr(run: Run): Promise<{ kind: 'merged' } | { kind: 'escalate'; reason: unknown }>
```
Implementation contract:
- `const { github, baseBranch } = this.repoContext(run);`
- Guard `run.prNumber === null` → return `{ kind: 'escalate', reason: { kind: 'auto_merge', detail:
  'run has no PR to merge' } }` (defensive; §3.2 already guards, so this should be unreachable).
- Ledger-guarded merge (M7 outbox), one slot so replay reuses the result:
  ```ts
  const result = await this.ledgerFor(run).once('auto_merge',
    () => github.mergePr({ prNumber: run.prNumber!, base: baseBranch, method: 'merge', deleteBranch: true }));
  ```
  Note: `ledgerFor(run)` keys on `${run.currentState}#${visit}`; here `currentState` is
  `AUTO_MERGE_STATE`, so the slot is stable across replay of this pseudo-state and distinct from any
  stage's slots.
- `result.merged === true` → record a log (`{ kind: 'auto_merge', result: 'merged', prNumber }`) and
  return `{ kind: 'merged' }`.
- `result.merged === false` → return `{ kind: 'escalate', reason: { kind: 'auto_merge_failed',
  prNumber: run.prNumber, base: baseBranch, reason: result.reason, mergeable: result.mergeable } }`.
  Do **not** retry-with-force.

**Invariant:** `autoMergePr` performs no approval logic and no FSM decision — the loop already
authorized it by reaching terminal `done`.

---

## 4. API surface

### 4.1 `src/api/orchestrator.ts` — mirror `setRepoConflictPolicy` (orchestrator.ts:921)
```ts
/** Set an enrolled repo's auto-merge flag (`POST /repos/auto-merge`). 404 if the repo is not enrolled.
 *  Returns the updated repo. */
setRepoAutoMerge(input: { repoRef: string; enabled: boolean }): Repo
```
- Normalize/validate `repoRef` exactly as the conflict-policy setter does.
- Require enrollment (throw the same not-found/404-mapped error when the repo row is absent).
- Call `this.repo.setRepoAutoMerge(ref, input.enabled)`, then return the freshly read `Repo`.

### 4.2 `src/api/server.ts` — mirror `/repos/conflict-policy` (server.ts:288) + `/repos/watch`'s boolean validation (server.ts:253–254)
The codebase has **no `bool()` helper**: routes read `readJson(req, ctx.maxBodyBytes)` and validate a
boolean inline with `typeof x !== 'boolean'` → `ApiError(400, ...)` (see `/repos/watch`). `repoRef` is
read with the existing `str(body, 'repoRef')`. Follow that exactly:
```ts
if (method === 'POST' && path === '/repos/auto-merge') {
  const body = await readJson(req, ctx.maxBodyBytes);
  const enabled = body.enabled;
  if (typeof enabled !== 'boolean') return sendError(res, new ApiError(400, '"enabled" (boolean) is required'));
  return sendJson(res, 200, orch.setRepoAutoMerge({ repoRef: str(body, 'repoRef'), enabled }));
}
```
Place it next to `/repos/conflict-policy` (both are body-carried-`repoRef` routes). Contract:
missing/invalid `repoRef` → the same error `str` raises today; non-boolean/absent `enabled` → 400.

---

## 5. Merge method & branch deletion (explicit per the issue)
- **Method:** `--merge` (a merge commit) — most conservative, preserves history. Making the strategy
  configurable is **deferred / out of scope**; `MergePrInput.method` is typed `'merge'` to leave room.
- **Branch deletion:** `--delete-branch` — per-run branches are disposable and this mirrors typical
  human cleanup. Call site passes `deleteBranch: true`.
- **Base:** merge into the PR's own recorded base only; never stack (no-stacked-PRs discipline).
These match "what a human merge does today / repo defaults"; the divergences (auto branch delete) are
called out here as the issue requires.

---

## 6. Invariants the implementation must uphold (checklist for tdd)
- **No approval bypass:** auto-merge fires iff `applyEvent`'s FSM decision is terminal-`done` (not
  escalation); no independent approval check exists. (§3.2 condition 1.)
- **Flag off ⇒ zero behavior change:** with `auto_merge` off, a run reaching approve/`done` commits
  `done`, PR stays `open`, exactly as today. (Criterion 2.)
- **Flag on ⇒ merged:** PR `state === 'merged'`, run `status === 'done'`, and the pseudo-state appears
  in the transition log (`auto_merge` → `done`). (Criterion 3.)
- **Never force:** a `conflicting`/failed merge yields `merged:false` → run `needs_human`, PR **not**
  merged, still surfaced; no `--force`/`--admin`. (Criterion 4.)
- **Dependency signal without a human:** merging the PR closes its `Closes #N` issue → Scheduler wakes
  the dependent run. (Criterion 5.)
- **PR-less guard:** `run.prNumber === null` at the terminal branch ⇒ commit plain `done` (never enter
  the pseudo-state). (§3.2 condition 2.)
- **Crash/replay idempotent:** ledgered `mergePr` + event-id-keyed transition + already-merged→success
  make a re-dispatched `EVENT_AUTO_MERGE` a no-op. (§3.4/§3.6.)
- **Re-enroll safety:** `upsertRepo` never resets `auto_merge`. (§1.3.)
- **Shutdown latch:** a merge interrupted by shutdown throws `ShutdownInterruptError`, not an
  escalation. (§3.4.)

---

## 7. Frontend contracts

### 7.1 `dashboard/src/lib/types.ts` (next to `conflictPolicy`, types.ts:244)
```ts
autoMerge: boolean;
```

### 7.2 `dashboard/src/lib/store.svelte.ts` (mirror `setRepoConflictPolicy`, store.svelte.ts:240)
```ts
export async function setRepoAutoMerge(repoRef: string, enabled: boolean): Promise<void> {
  // POST /repos/auto-merge { repoRef, enabled }; optimistic local update like the conflict-policy setter
}
```

### 7.3 `dashboard/src/lib/Home.svelte` (repo row, near the conflict-policy toggle, Home.svelte:416–429)
- Add an auto-merge toggle bound to `repo.autoMerge`, calling `setRepoAutoMerge`, **disabled when the
  repo is not enrolled** (same gating as the conflict-policy control).
- **Label collision guard:** the conflict-policy pill already renders the text "Auto-merge" for auto
  *conflict resolution*. Label the new control distinctly — e.g. **"Auto-merge PRs"** / **"Merge on
  approve"** — and, if the two read too closely, reword the conflict pill to "Auto-resolve conflicts"
  so operators are not misled. This is a naming decision, not a behavior change.
- If `render.ts` renders repo rows and would surface this flag, add the field to `render.ts` +
  `render.test.ts` to keep the pure-render snapshot honest; otherwise leave them untouched.

---

## 8. Docs
`README.md`: move auto-merge off the §1 out-of-scope list (now an opt-in per-repo flag, default off),
update the `done`-state description (§3.1 / state table) and §3.5 (auto-merge can now produce the merge
signal without a human). Re-run `docs.readme.test.ts` after edits. The §8 status test counts are
**frozen-as-shipped** — do not invent a live tally.
