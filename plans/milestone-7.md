# Milestone 7 — Polish (design + plan)

> Status: **done** (353 tests passing, 1 flag-gated real run skipped; +19 over M6). The MVP is
> feature-complete through M6; M7 hardens the edges the earlier milestones deliberately deferred.
> It adds no new product surface — it makes the existing one **safe to crash, easy to recover, and
> documented to operate**. Shipped: the transactional outbox (`src/agent/side-effects.ts` + the
> `side_effects` ledger / migration 2), the `needs_human` escalation inspector
> (`escalationModel` → `RunDetail.svelte`), counter-reset assertions, and the §9 operating guide.

## 1. Goal and scope (README §5 Milestone 7)

Three threads, in priority order:

1. **Harden restart correctness across all layers.** The core idempotency property and its
   crash-recovery test already exist (M2). M7 closes the one remaining honest gap the README names
   in its risk register: **non-idempotent GitHub side effects** — posting issue/PR comments and
   creating sub-issues — can be **repeated** if the daemon crashes in the window after the GitHub
   call returns but before the run's transition commits. The fix is a **transactional outbox**
   (an idempotency ledger). This thread also extends crash/adapter-failure **test coverage**.
2. **Error handling & `needs_human` UX.** Make "inspect → fix → resume/revert (with counter reset)"
   a first-class loop the operator can actually run. The control endpoints and counter-reset
   semantics already exist (M5); what is missing is **inspectability** — surfacing *why* a run
   escalated — and the new `partial_side_effect` escalation that thread 1 introduces.
3. **Documentation.** A concise operator guide: point it at a repo, configure the FSM, set secrets,
   run it (CLI + daemon + dashboard), and resolve a `needs_human` run.

**Out of scope** (unchanged, post-MVP): per-run versioned config store, multi-repo / parallel
execution (M8), multi-issue ordering (M9), the Agent SDK executor (M10), exactly-once delivery
(we keep at-least-once — the outbox shrinks the duplicate window, it does not abolish it).

---

## 2. Thread 1 — Transactional outbox (idempotency ledger)

### 2.1 The problem, precisely

`EventLoop.applyEvent` runs a stage (`runner.runStage`), then commits a transition keyed to the
event id. Transition application is already idempotent (the `UNIQUE(event_id)` index — a replayed
event that already produced a transition is finalized, not re-run). **But the GitHub side effects
happen inside `runStage`, before the transition commits.** If the process dies after a GitHub call
returns but before the commit, recovery reclaims the event (`recoverProcessingEvents`), sees no
transition, and re-runs the *entire* stage — re-posting comments and **re-creating sub-issues**.

The non-idempotent calls (today, all in `src/agent/runner.ts`):

| Call                          | Where                          | Worst case on replay        |
|-------------------------------|--------------------------------|-----------------------------|
| `postIssueComment` (signoff)  | triage `proceed`               | duplicate comment           |
| `postIssueComment` (clarify)  | triage `clarify`               | duplicate question comment  |
| `createIssue` (×N)            | triage `split`                 | **duplicate sub-issues**    |
| `postIssueComment` (split)    | triage `split`                 | duplicate comment           |
| `postComment` (×N)            | review stages → PR             | duplicate review comments   |

Already idempotent — **left untouched**: `updateIssue` (re-writing the same text is harmless),
`commitAndPush` (re-committing the same tree is a no-op; proven by the github-cli test), and
`openPr`/`ensurePr` (already find-or-create via `findOpenPrForBranch` + the persisted `pr_number`).

### 2.2 Design: a two-phase side-effect ledger keyed by a deterministic slot

A new `side_effects` table records each non-idempotent external call. Before performing a wrapped
call the runner **claims** a ledger row; after it returns the runner **completes** the row with the
result. On replay the runner consults the ledger instead of calling GitHub again.

**The deterministic key.** The key must be identical across replays of *the same logical stage
execution*, yet *different* across legitimate re-visits (e.g. a back-edge that brings a run back to
`code_review` for a genuine second review round must post fresh comments). The key is:

```
key = `${state}#${visitIndex}:${slot}`        // scoped per run via the (run_id, key) unique index
```

- `state` = `run.currentState` (stable until this stage's transition commits).
- `visitIndex` = number of transitions whose `to_state === state` so far — a new repo helper
  `stateVisitCount(runId, state)`. **Stable across a crash/replay of the same visit** (the outgoing
  transition has not committed yet), and **incremented by a legitimate re-entry** (a back-edge or a
  resume/clarify transition into the state), which is exactly what gives a real second round fresh
  keys. *This is the crux that makes the ledger correct without any cleanup logic.*
- `slot` = a fixed, output-independent discriminator per call site:
  `signoff` · `clarify` · `subissue:${i}` · `split` · `comment:${i}` (review).

The key is **independent of agent output** on purpose: an automatic replay re-runs the (paid, LLM)
produce phase and may yield different text, but the externally-visible action is pinned to the first
attempt's result — that is what idempotency means here.

**Two phases (claim → complete), and why.**

```ts
// src/agent/side-effects.ts
async function once<T>(repo, runId, key, perform: () => Promise<T>): Promise<T> {
  const claim = repo.beginSideEffect(runId, key);     // INSERT status='pending', or read existing
  if (claim.state === 'done') return claim.result as T;       // replay: reuse, no GitHub call
  if (claim.state === 'pending') throw new AmbiguousSideEffectError(key); // partial — escalate
  const result = await perform();                     // claim.state === 'fresh'
  repo.completeSideEffect(runId, key, result);        // INSERT status='done', result JSON
  return result;
}
```

- `done` on replay → return the stored result; **GitHub is never called twice.** This is the whole win:
  a split that crashed pre-commit re-uses the *same* created sub-issues instead of making more.
- `pending` on replay → the previous attempt claimed the slot but never recorded completion: the
  call **may or may not** have reached GitHub (crash mid-call, or after the call but before
  `completeSideEffect`). For a non-idempotent op, blindly retrying is exactly what causes
  duplicates, so we **do not auto-retry** — we throw `AmbiguousSideEffectError`, which the runner
  turns into an `escalate` outcome (trigger `partial_side_effect`). A human inspects GitHub and
  resumes. This is the irreducible at-least-once tail, converted from a *silent duplicate* into a
  *visible, safe escalation* — and it is precisely M7's "partial agent actions" charter.

**Why no cleanup of stale ledger rows is needed.** An operator `resume` (`resumeRun`) or `revert`
commits a *new* transition into the target state, so `visitIndex` increments and the next attempt
computes entirely fresh keys. The failed visit's `pending`/`done` rows are simply never consulted
again. So: **automatic recovery dedups within a visit; an operator resume is a deliberate clean
retry of a new visit** (the runbook tells the operator to verify/clean partial GitHub artifacts
first). One coherent model, no extra bookkeeping.

### 2.3 Wiring

- `src/store/schema.sql`: add the table.
  ```sql
  CREATE TABLE IF NOT EXISTS side_effects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     INTEGER NOT NULL REFERENCES runs(id),
    key        TEXT    NOT NULL,                       -- `${state}#${visit}:${slot}`
    status     TEXT    NOT NULL CHECK (status IN ('pending','done')),
    result     TEXT,                                   -- JSON result of the external call (NULL while pending)
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_side_effects_key ON side_effects(run_id, key);
  ```
- `src/store/migrations.ts`: append **migration 2** (`create side_effects`) — idempotent
  (`CREATE TABLE/INDEX IF NOT EXISTS`), so a no-op on a fresh DB and a retrofit on an on-disk one.
  Bumps `LATEST_VERSION` to 2.
- `src/store/repository.ts`: `beginSideEffect(runId, key) → { state: 'fresh' | 'pending' | 'done'; result?: unknown }`
  (INSERT-or-read, atomic via the unique index), `completeSideEffect(runId, key, result)`, and
  `stateVisitCount(runId, state)`.
- `src/agent/side-effects.ts` (new): `AmbiguousSideEffectError` + the `once(...)` helper (a thin
  pure-ish function over the three repo methods — unit-testable with a fake repo).
- `src/agent/runner.ts`: wrap the five call sites in `once(...)` with their slot keys; catch
  `AmbiguousSideEffectError` and return `{ kind: 'escalate', trigger: 'partial_side_effect', reason }`.
  The clarify/split paths already need the call result (comment id, created issues) — `once` returns
  it transparently (fresh or replayed).

No change to `EventLoop`: a `partial_side_effect` escalate is just another escalate outcome it
already handles. The ledger writes are standalone autocommitted writes (deliberately *outside* the
transition transaction) — that immediacy is what makes them a durable outbox.

### 2.4 Tests

- **Repository** (`repository.test.ts`): `beginSideEffect` returns `fresh` then `pending` then
  (after complete) `done` with the round-tripped result; `stateVisitCount` counts entries and
  increments on re-entry.
- **Ledger** (`side-effects.test.ts`, new): `once` performs on `fresh`, reuses on `done` **without
  calling perform**, throws `AmbiguousSideEffectError` on `pending`.
- **Crash recovery, extended** (`src/integration/`): drive a triage **split** and a **review**
  stage through the loop; simulate the M2-style crash (`applyEvent` without `markEventDone`),
  `recover()`, re-drain, and assert the fake GitHub saw **exactly one** `createIssue` per child and
  **one** comment per slot — the regression test for the README risk. Add a `pending`-row case
  asserting the run escalates `partial_side_effect`.

---

## 3. Thread 2 — Error handling & `needs_human` UX

### 3.1 What already exists (verify + cover, don't rebuild)

- `Orchestrator.resume` dispatches on status: `paused` → `running`; `needs_human` →
  `loop.resumeRun` (back to the escalated-from stage, **counter reset** via `isReset`).
- `Orchestrator.revert(toState, reason)` → `loop.revertRun` (counter reset, fresh advance event,
  refuses 409 mid-flight).
- The dashboard `RunDetail.svelte` already renders Pause / Resume / Revert(form) / Stop.

M7 adds **event-loop tests** that assert `computeCounters` is zero immediately after `resumeRun`
and after `revertRun` (the "with counter reset" clause, currently relied upon but not directly
asserted).

### 3.2 The gap: inspectability ("inspect → fix → resume/revert")

The operator can resume/revert but the dashboard does not show **why** a run escalated — only a
"⚠ escalated" badge. To *fix* the cause they must read the transition reason. M7 adds an
**escalation inspector**:

- **Pure view-model in `dashboard/src/lib/render.ts`** (so it is unit-tested by the root suite):
  `escalationModel(transitions) → { trigger, reason, guidance } | null` — finds the last transition
  into the escalation state and maps each known `trigger` to a one-line operator guidance string:
  - `malformed_output` → "the agent's output failed validation N times; revert with a clarifying reason."
  - `git_error` → "a git/GitHub operation failed; check auth/branch/conflicts, then resume."
  - `executor_error` → "the harness errored after its own retries; check the harness, then resume."
  - `internal_review_cap` → "self-review never converged; revert to the produce stage with notes."
  - `budget_exceeded` → "the run hit its token/cost/time budget; raise the budget or stop."
  - `config_version_mismatch` → "the run was started under a different FSM config; resume to retry."
  - `should_split` → "triage split this issue; start runs for the children (see the reason payload)."
  - `partial_side_effect` → **"a comment or sub-issue may have been partly created — verify on
    GitHub and remove any partial artifact before resuming."** (the new trigger from thread 1.)
- **`RunDetail.svelte`** renders the panel when `run.status === 'needs_human'`: the trigger, the
  guidance line, the formatted reason payload, and the existing Resume/Revert controls — the whole
  inspect→fix→act loop in one place.

### 3.3 Tests + verification

- `render.test.ts`: `escalationModel` for each trigger (and `null` when not escalated).
- Browser verification via the preview tool against `npm run dev:preview` (the seed already includes
  an escalated run): the panel shows the trigger + guidance, and Resume clears it.

---

## 4. Thread 3 — Documentation

A single concise **"Operating the fleet"** section in `README.md` (the README is the spec home;
keep one source of truth rather than a scattered `docs/` tree). It covers, end to end:

1. **Prerequisites** — Node ≥ 20, `gh` authenticated, `.env` from `.env.example` (`GITHUB_TOKEN`,
   `ANTHROPIC_API_KEY`; secrets are env-only, never in SQLite).
2. **Point it at a repo** — `npm start -- <owner/repo#issue> --repo <owner/repo>` (real by default;
   `--mock` for a no-cost run). Note the `[real mode] … spends tokens` banner.
3. **Run the daemon + dashboard** — `npm run build:dashboard` then `npm start -- serve --config
   <path> --db <path>`; open `http://127.0.0.1:4319`. `npm run dev` for the one-command dev loop.
4. **Configure the FSM** — edit via the dashboard's FSM editor (`PUT /config`, writable only when
   `--config` is set and no run is in flight) or the config file directly.
5. **Resolve a `needs_human` run** — the runbook: inspect the escalation panel → fix the cause
   (incl. the `partial_side_effect` GitHub-cleanup step) → Resume (retry, counter reset) or Revert
   `<state>` with a reason.
6. **Crash recovery** — restart the daemon; `recover()` reclaims stranded events automatically; the
   outbox prevents duplicate comments/sub-issues. Nothing manual required.

Also update the README **status block** (the M0–M6 "Added in…" list) with an M7 entry and the new
test count, and the Milestone-7 risk-register lines (the transactional-outbox "proper fix" is now
*shipped*, not deferred).

---

## 5. File layout (new / touched)

```
src/store/schema.sql            + side_effects table & unique index
src/store/migrations.ts         + migration 2 (create side_effects), LATEST_VERSION → 2
src/store/repository.ts         + beginSideEffect / completeSideEffect / stateVisitCount
src/store/repository.test.ts    + ledger + visit-count tests
src/agent/side-effects.ts       NEW: AmbiguousSideEffectError + once() helper
src/agent/side-effects.test.ts  NEW
src/agent/runner.ts             wrap the 5 non-idempotent calls; partial_side_effect escalate
src/integration/*recovery*      + outbox crash-recovery + partial-effect tests
src/loop/event-loop.test.ts     + counter-reset-on-resume/revert assertions
dashboard/src/lib/render.ts     + escalationModel()
dashboard/src/lib/render.test.ts + escalationModel tests
dashboard/src/lib/RunDetail.svelte + escalation inspector panel
README.md                       + "Operating the fleet" section; status & risk updates
```

## 6. Definition of done

- A crash in the post-GitHub-call / pre-commit window **never** produces a duplicate comment or
  sub-issue; the irreducible mid-call window escalates `partial_side_effect` instead of duplicating.
  Proven by the extended crash-recovery integration tests.
- The dashboard shows, for any `needs_human` run, the escalation **trigger + guidance + reason**, and
  Resume/Revert resolve it with counters reset (asserted in tests; verified in the browser).
- The README's "Operating the fleet" guide takes a reader from zero to a running, recoverable fleet.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:dashboard` all green; the dashboard
  builds. Migration 2 is verified to upgrade an on-disk DB without data loss (as migration 1 was).

## 7. Sequencing

1. Store layer (schema + migration + repo methods + tests) — the foundation.
2. Ledger helper + runner wiring + crash-recovery tests — thread 1 complete and proven.
3. `escalationModel` + RunDetail panel + counter-reset tests — thread 2.
4. README operating guide + status/risk updates — thread 3.

Each step keeps the suite green, so the milestone is shippable at every checkpoint.
