# Interface — Continuous mode: configurable in-flight cap > 1 (parallel pickup)

Issue: `jzohdi/agents-fsm#10`. Plan: `.agent/plan.md`.

This pins the contracts the TDD stage writes tests against and the implementation satisfies. The
change is **additive** end-to-end: a new persisted per-repo integer `watchInFlightCap` (default `1`),
threaded from the store → pure decision → poller → API → dashboard. Nothing changes for a repo that
does not opt in — default `1` reproduces today's strictly-sequential behavior byte-for-byte.

The one genuine **contract change** is the pure decision's return shape: `IntakePlan.start`
(single-or-null) becomes `IntakePlan.starts` (an ordered array). Only the poller and the two intake
test files consume it.

---

## 1. Store layer

### 1.1 `src/store/schema.sql` — `repos` table

Append **last** in the `repos` table (after `watch_filter_milestone`), matching the additive-column
convention with a trailing comment:

```sql
watch_in_flight_cap INTEGER NOT NULL DEFAULT 1   -- max runs a watched repo admits at once (continuous mode); 1 = sequential
```

Invariant: `schema.sql` and migration 17 must stay in lockstep — `db.test.ts` compares a migrated
old DB's `repos` columns against a fresh DB's.

### 1.2 `src/store/migrations.ts` — migration version 17

Append after version 16 (`add repos watch filter columns`). The bottom-of-file guards require a
gap-free `1..N` sequence and unique names, so 17 is the next free number and the name must be unique.

```ts
{
  version: 17,
  name: 'add repos.watch_in_flight_cap',
  // Continuous mode configurable in-flight cap (agents-fsm#10). Additive column with a constant
  // default 1, so a pre-existing DB backfills to 1 (sequential — behaviour unchanged) and a fresh DB
  // already has it from schema.sql. Mirrors schema.sql.
  apply: (db) => addColumnIfMissing(db, 'repos', 'watch_in_flight_cap', 'INTEGER NOT NULL DEFAULT 1'),
}
```

### 1.3 `src/store/repository.ts`

- **`RepoRow`** (raw row shape): add `watch_in_flight_cap: number;` (after `watch_filter_milestone`).
- **`Repo`** (domain): add, after `watchFilterMilestone`:
  ```ts
  /** Continuous mode (agents-fsm#10): max runs this watched repo admits in flight at once. Default 1
   *  (sequential). Only meaningful while {@link watch} is on; clamped to `>= 1` by the decision, and
   *  actual concurrency is still bounded by the drain pool's FLEET_CONCURRENCY regardless. */
  watchInFlightCap: number;
  ```
- **`mapRepo`**: add `watchInFlightCap: r.watch_in_flight_cap,`.
- **`setRepoWatch`**: extend the existing dynamic-SET method with an optional cap, following the
  **same absent→leave / value→set** convention as `label`/`filter`. New signature:
  ```ts
  setRepoWatch(
    repoRef: string,
    watch: boolean,
    label?: string | null,
    filter?: { filterLabel?: string | null; filterMilestone?: string | null },
    inFlightCap?: number,        // absent → leave the column as-is; a number → set watch_in_flight_cap
  ): void
  ```
  When `inFlightCap !== undefined`, push `'watch_in_flight_cap = ?'` / the value onto the dynamic
  SET-list. A plain toggle (`setRepoWatch(ref, watch)`) must never clobber a previously-set cap.
  Store the value as given (the API boundary is responsible for integer/`>= 1` validation); the pure
  decision additionally clamps defensively.

**Invariants**
- INV-STORE-DEFAULT: a repo never assigned a cap reads back `watchInFlightCap === 1`.
- INV-STORE-LEAVE: `setRepoWatch(ref, watch)` (cap absent) leaves a previously-set cap untouched.
- INV-STORE-SET: `setRepoWatch(ref, watch, undefined, undefined, 5)` persists `watchInFlightCap === 5`.

---

## 2. Pure decision — `src/loop/issue-intake.ts`

### 2.1 `IntakePolicy` (unchanged shape)

`inFlightCap: number` already exists and is documented as clamped to `>= 1`. No field change; the
poller now supplies `repo.watchInFlightCap` instead of a literal `1`.

### 2.2 `IntakePlan` — **contract change**

Replace the single `start` field with an ordered array `starts`:

```ts
export interface IntakePlan {
  /** The issues to admit **this pass**, oldest-first (issue number asc), up to `cap - inFlight`
   *  free slots. Empty when the cap is full, nothing is new, or nothing eligible. */
  starts: Array<{ issueRef: string; issueNumber: number }>;
  /** How many of the repo's open issues already hold a slot (a non-`stopped` run). */
  inFlight: number;
  /** The resolved (clamped) in-flight cap. */
  cap: number;
  /** New issues rejected by the guards this pass — never admitted, surfaced for the operator. */
  skipped: IntakeSkip[];
}
```

### 2.3 `decideIntake` behavior

Signature unchanged: `decideIntake(openIssues, runStatusByRef, policy): IntakePlan`.

New logic:
1. `cap = Math.max(1, Math.trunc(policy.inFlightCap))` (existing clamp — keep).
2. Compute `inFlight` and collect run-less `candidates` exactly as today (dedup: an issue with any
   run status is never a fresh candidate; a non-`stopped` run counts toward `inFlight`).
3. `free = cap - inFlight`. If `free <= 0`, return `{ starts: [], inFlight, cap, skipped: [] }`.
4. Sort `candidates` oldest-first (`a.number - b.number`).
5. Walk candidates in order: for each, `ineligibleReason(issue, policy)`.
   - Eligible (`null`): push `{ issueRef, issueNumber }` onto `starts`. **Stop collecting once
     `starts.length === free`** — remaining candidates are neither started nor skipped (they simply
     wait for a future pass).
   - Ineligible: push `{ ref, number, reason }` onto `skipped` and continue.

Update the doc comments (the "one admission per pass" / "sequential by construction" prose) to
describe filling up to `free` slots per pass, oldest-first.

**Invariants**
- INV-DEC-FILL: with `cap = N`, `inFlight = 0`, and `M >= N` eligible issues → `starts.length === N`,
  ordered by ascending issue number; the `N+1`th eligible issue is **absent from both** `starts` and
  `skipped`.
- INV-DEC-PARTIAL: `cap = N`, `inFlight = k` (`0 <= k < N`), `M` eligible → `starts.length ===
  min(N - k, M)`.
- INV-DEC-FULL: `inFlight >= cap` → `starts === []` (and `skipped === []`; no candidate is evaluated).
- INV-DEC-DEFAULT: `cap = 1`, `inFlight = 0`, ≥1 eligible → exactly one start (today's behavior).
- INV-DEC-SKIP: ineligible candidates encountered **before** `free` is reached still land in
  `skipped` with their reason; the guard logic (`ineligibleReason`, override label, WIP/owner/assignee
  rules) is unchanged.
- INV-DEC-CLAMP: `policy.inFlightCap` of `0`, negative, or fractional resolves to `cap >= 1`
  (`Math.max(1, Math.trunc(...))`).

`ownerOf`, `DEFAULT_WATCH_LABEL`, `IntakeIssue`, `IntakeSkip`, and `ineligibleReason` are unchanged.

---

## 3. Poller — `src/loop/issue-intake-poller.ts`

`RunStarter` interface unchanged: `start(input: { issueRef: string }): { id: number }`.

### 3.1 `IntakePass`

`started` semantics widen from "at most one per repo" to "up to the repo's free in-flight slots".
Field shape unchanged (`{ reposScanned, started, skipped }`); update its doc comment.

### 3.2 `checkRepo`

- Pass the repo's cap into the decision:
  ```ts
  const plan = decideIntake(openIssues, statusByRef, {
    owner: ownerOf(repoRef), overrideLabel, inFlightCap: repo.watchInFlightCap,
  });
  ```
- Emit skips as today (loop over `plan.skipped`, `announceSkip`).
- Replace the single `plan.start` block with a loop over `plan.starts` (already oldest-first). For
  each start:
  1. `const run = this.starter.start({ issueRef: start.issueRef });`
  2. `this.repo.recordLog({ runId: run.id, message: 'auto-picked from … backlog …', data: { kind:
     'issue_intake', issueRef: start.issueRef, issueNumber: start.issueNumber } });` (same log shape).
  3. `pass.started += 1;` and `this.emit(...)`.
- **On a thrown `start()`**: catch, `this.emit('could not start … : …')`, then **`break`** out of the
  starts loop — do not attempt the remaining starts this pass (avoids N identical failures when the
  global cost ceiling / a 429 is hit mid-burst). The next tick re-evaluates once the condition clears.
  This mirrors today's single-start catch semantics.

Update the file/class header comment: soften "Sequential by default (in-flight cap 1)" to note the
cap is now per-repo configurable, default 1.

**Invariants**
- INV-POLL-FILL: a watched repo at `cap = N` with `>= N+1` eligible open issues → **one pass admits
  exactly N runs** (`pass.started === N`, N run rows created); the `N+1`th is not started that pass.
- INV-POLL-DRAIN: after a slot frees (an admitted issue's run reaches `stopped`, or the issue closes so
  its run no longer blocks — per the existing dedup/slot rules), a subsequent pass admits the waiting
  issue.
- INV-POLL-BREAK: if the `k`-th `start()` throws, starts `k+1..` are not attempted that pass; the pass
  still returns (per-repo error isolation intact) and `pass.started` reflects only the successful ones.
- INV-POLL-ISOLATION: a repo whose GitHub read throws still isolates to that repo (unchanged).

---

## 4. API layer

### 4.1 `src/api/orchestrator.ts` — `setRepoWatch`

Extend the input object with an optional cap:

```ts
setRepoWatch(input: {
  repoRef: string;
  watch: boolean;
  label?: string | null;
  filterLabel?: string | null;
  filterMilestone?: string | null;
  inFlightCap?: number;        // absent → leave; else must be a positive integer
}): Repo
```

Validation at this boundary (after the existing ref/enrollment/source-mode checks):
- `inFlightCap === undefined` → leave the stored value as-is (pass `undefined` through).
- Otherwise require a **positive integer**: `Number.isInteger(input.inFlightCap) && input.inFlightCap
  >= 1`; else `throw new ApiError(400, '"inFlightCap" must be a positive integer')`.
- Forward the validated value as the 5th argument to `this.repo.setRepoWatch(ref, input.watch,
  input.label, { …filters }, input.inFlightCap)`.

Return the refreshed `Repo` (so the caller round-trips the persisted `watchInFlightCap`).

**Invariants**
- INV-API-VALID: a valid `inFlightCap` (integer `>= 1`) persists and round-trips via `GET /repos`.
- INV-API-REJECT: `0`, a negative number, and a non-integer (e.g. `1.5`) each throw `ApiError(400)`.
- INV-API-LEAVE: omitting `inFlightCap` leaves the stored cap unchanged (e.g. a plain watch toggle
  after a cap was set keeps the cap).

### 4.2 `src/api/server.ts` — `POST /repos/watch`

Parse and shallow-validate `body.inFlightCap` alongside the existing `label`/`filterLabel`/
`filterMilestone` checks:

```ts
const inFlightCap = body.inFlightCap;
if (inFlightCap !== undefined && typeof inFlightCap !== 'number') {
  return sendError(res, new ApiError(400, '"inFlightCap" must be a positive integer or omitted'));
}
```

Forward `inFlightCap: inFlightCap as number | undefined` into `orch.setRepoWatch({ … })`. (The
integer/`>= 1` check lives in the orchestrator, the single validation authority — the route only
rejects a non-number/non-omitted value, matching how it handles the other optional fields.)

Update the route's leading comment block to mention the optional `inFlightCap`.

---

## 5. Dashboard (frontend)

### 5.1 `dashboard/src/lib/types.ts` — `Repo`

Add after `watchFilterMilestone`:
```ts
watchInFlightCap: number;
```

### 5.2 `dashboard/src/lib/render.ts` — `RepoLedgerRow` + `repoLedgerModel`

- `RepoLedgerRow`: add `watchInFlightCap: number;`.
- `blank(...)`: default `watchInFlightCap: 1`.
- `repoLedgerModel` enrolled branch: `watchInFlightCap: repo.watchInFlightCap ?? 1` — an older daemon
  that predates the column omits it → default 1 (matches the store default).

**Invariant** INV-RENDER-DEFAULT: `repoLedgerModel` surfaces `watchInFlightCap` from the repo, and
defaults to `1` when the daemon omits it.

### 5.3 `dashboard/src/lib/store.svelte.ts` — new action

Add `setRepoWatchInFlightCap`, mirroring `setRepoWatchFilter` (POST the row's **current** `watch`
value plus `inFlightCap`, so it never toggles watching; then `loadRepos()` + a success/error banner):

```ts
export async function setRepoWatchInFlightCap(repoRef: string, inFlightCap: number): Promise<void>
```

Implementation notes: read `watch` from `ui.repos.find((r) => r.repoRef === repoRef)?.watch ?? false`,
`request<Repo>('POST', '/repos/watch', { repoRef, watch, inFlightCap })`, banner on ok/err, refresh.

### 5.4 `dashboard/src/lib/Home.svelte` — cap control

Add a compact per-repo in-flight-cap control near the **Watch** toggle / **Scope** chip, following the
existing `af-hwatch` chip + expandable-editor (or inline number stepper) pattern. Only meaningful for
an enrolled repo. Show the current value (e.g. "Parallel: N" / "In-flight cap: N"); edit via a
`min=1`, integer `<input type="number">` with an Apply action calling `setRepoWatchInFlightCap`.
Import the new store action.

---

## 6. Docs — `README.md`

- §5 "Milestone 11": update the "Still open: a configurable cap > 1" note to reflect it has shipped
  (this issue).
- §9.10: revise "Sequential by default (in-flight cap 1)" to document the configurable per-repo cap
  (default 1 = sequential), how to set it (the dashboard control / the `inFlightCap` field of `POST
  /repos/watch`), oldest-first fill up to N free slots, that a `needs_human`/parked run still holds its
  slot, and that actual concurrency is bounded by `FLEET_CONCURRENCY`.

---

## Data-flow summary

```
POST /repos/watch {inFlightCap}
  → server.ts (typeof number | omitted)
  → orchestrator.setRepoWatch (Number.isInteger && >= 1, else 400)
  → repository.setRepoWatch (dynamic SET watch_in_flight_cap)
  → repos.watch_in_flight_cap  [persisted, default 1]

IssueIntakePoller.checkRepo
  → repo.watchInFlightCap
  → decideIntake(..., { inFlightCap })  → IntakePlan.starts (≤ cap - inFlight, oldest-first)
  → for each start: RunStarter.start (break on throw)

GET /repos → Repo.watchInFlightCap
  → dashboard types → repoLedgerModel (default 1) → Home.svelte control
```

## Backward-compatibility guarantees

- Additive column, constant default `1`; older DBs backfill to 1 via migration 17.
- Older daemons/dashboards without the field default to 1 (`?? 1` in the render model).
- `decideIntake` with `cap = 1` is behaviorally identical to the prior single-`start` logic (exactly
  one admission per pass), so no observable change for a repo that never sets a cap.
