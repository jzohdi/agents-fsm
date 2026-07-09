# Plan — Continuous mode: configurable in-flight cap > 1 (parallel pickup)

Issue: `jzohdi/agents-fsm#10`

## Goal (restated)

Continuous mode (Milestone 11) currently admits a watched repo's issues **strictly one at a time**:
the Issue Intake Poller hardcodes `inFlightCap: 1` (`src/loop/issue-intake-poller.ts:88`). Make the
per-repo in-flight cap **configurable and persisted**, thread it into the pure decision
(`decideIntake`), expose it on `POST /repos/watch` and the dashboard repo/watch UI, so an operator can
let a watched repo work up to **N** issues in parallel. Per-run worktrees (M8 Phase B) already make
concurrent pickup safe; actual concurrent *execution* remains bounded by the drain pool's
`FLEET_CONCURRENCY`, so a large cap just means more runs queued, never more processes than that limit.

Default stays **1** (today's sequential behavior) — nothing changes for a repo that doesn't opt in.

## Key design decision — fill free slots per pass (not one-per-tick)

`decideIntake` today returns **at most one** `start` per pass and relies on successive ticks to
re-observe the new run in-flight before admitting the next (`src/loop/issue-intake.ts:101-108`,
"one admission per pass"). If we only thread the cap and keep one-per-pass, a repo with `cap=5` and a
backlog would take **5 poll intervals** to reach 5 in-flight — surprising for a control literally
labelled "parallel pickup." So this change makes `decideIntake` admit **up to `cap - inFlight`**
eligible issues in a single pass (oldest-first), and the poller starts each.

This is a contained contract change — `decideIntake` is only called by the poller and its tests
(verified by grep). Each admitted issue still flows through the *same* per-run admission the manual
path uses (`RunStarter.start` → dedup guard, cost ceiling, enrollment), applied independently per
start, so filling slots in a burst is not a bypass. The poller loop **stops starting more this pass**
the moment a `start()` throws (e.g. the global cost ceiling / 429), to avoid N identical failures per
tick; the next tick re-evaluates once the condition clears — mirroring today's single-start catch.

## Approach / files to change

### 1. Persist the cap (Layer 1 — store)

- **`src/store/schema.sql`** — append `watch_in_flight_cap INTEGER NOT NULL DEFAULT 1` **last** in the
  `repos` table (after `watch_filter_milestone`), with a drift-guard comment matching the existing
  additive-column convention. Default `1` = today's sequential behavior.
- **`src/store/migrations.ts`** — add **migration version 17**
  (`add repos.watch_in_flight_cap`): `addColumnIfMissing(db, 'repos', 'watch_in_flight_cap',
  'INTEGER NOT NULL DEFAULT 1')`. Constant default so a pre-existing DB backfills to `1` (unchanged
  behavior) and a fresh DB already has it from `schema.sql`. The version-sequence + unique-name guards
  at the bottom of the file already enforce `1..N`; 17 is the next free number (16 = watch filters).
- **`src/store/repository.ts`**:
  - `RepoRow`: add `watch_in_flight_cap: number`.
  - `Repo` interface: add `watchInFlightCap: number` (doc: max runs a watched repo admits at once;
    default `1`; only meaningful while `watch` is on; actual concurrency still bounded by
    `FLEET_CONCURRENCY`).
  - `mapRepo`: map `watchInFlightCap: r.watch_in_flight_cap`.
  - `setRepoWatch(...)`: extend to optionally set the cap following the **same
    absent→leave / value→set** dynamic-SET convention already used for `label`/`filter`. Add an
    `inFlightCap?: number` parameter (or fold into the existing options object) and, when present,
    push `watch_in_flight_cap = ?`. A plain toggle must never clobber a previously-set cap.

### 2. Thread the cap into the decision (pure core)

- **`src/loop/issue-intake.ts`**:
  - Change `IntakePlan.start: {…} | null` → **`starts: Array<{ issueRef: string; issueNumber: number }>`**
    (kept `inFlight`, `cap`, `skipped`).
  - In `decideIntake`: after computing `inFlight` and the clamped `cap`, compute
    `free = cap - inFlight`; if `free <= 0` return with `starts: []`. Then walk the oldest-first
    `candidates`, collecting eligible ones into `starts` until it holds `free` entries; keep pushing
    ineligible ones onto `skipped`. `Math.max(1, Math.trunc(cap))` clamping already present stays.
  - Update the doc comments (the "one admission per pass"/"sequential by construction" prose) to
    describe filling up to `free` slots per pass.

### 3. Wire it in the poller (impure driver)

- **`src/loop/issue-intake-poller.ts`**:
  - `checkRepo`: pass `inFlightCap: repo.watchInFlightCap` into `decideIntake` instead of the
    hardcoded `1`.
  - Replace the single `plan.start` block with a loop over `plan.starts`: for each, `starter.start`,
    `recordLog` the auto-pick, `pass.started += 1`, `emit`. **Break** the loop on a thrown `start()`
    (cost ceiling / lost race) after emitting, so we don't hammer the same failure N times a tick.
  - `IntakePass.started` doc already says "at most one per repo" — update to "up to the repo's free
    in-flight slots."
  - Class/file header comment: soften "Sequential by default (in-flight cap 1)" to note the cap is now
    per-repo configurable, default 1.

### 4. API surface

- **`src/api/orchestrator.ts` — `setRepoWatch`**: add `inFlightCap?: number` to the input. Validate at
  this boundary: `undefined` → leave as-is; otherwise require a **positive integer** (`Number.isInteger`
  and `>= 1`), else `throw new ApiError(400, …)`. Pass it through to `repo.setRepoWatch`. (A soft upper
  sanity bound — e.g. reject absurd values — is optional; note that real concurrency is capped by
  `FLEET_CONCURRENCY` regardless, so an over-large cap only inflates the queue.)
- **`src/api/server.ts` — `POST /repos/watch`**: parse `body.inFlightCap`; if present and not a number,
  `400 '"inFlightCap" must be a positive integer or omitted'`. Forward to `orch.setRepoWatch({… inFlightCap})`.
  Update the route's leading comment (currently documents `watch`/`label`/`filter*`) to mention the cap.

### 5. Dashboard UI (frontend)

- **`dashboard/src/lib/types.ts`** — `Repo`: add `watchInFlightCap: number`.
- **`dashboard/src/lib/render.ts`** — `RepoLedgerRow`: add `watchInFlightCap: number`; default to `1`
  in `blank(...)`; in `repoLedgerModel`, set `watchInFlightCap: repo.watchInFlightCap ?? 1` (older
  daemons that predate the column don't send it → default 1, matching the store default).
- **`dashboard/src/lib/store.svelte.ts`** — add `setRepoWatchInFlightCap(repoRef, cap)` that POSTs
  `/repos/watch` with the row's **current** `watch` value plus `inFlightCap` (never toggles watching),
  then `loadRepos()` + a success/error banner — mirroring `setRepoWatchFilter`.
- **`dashboard/src/lib/Home.svelte`** — add a compact cap control on the repo row next to the **Watch**
  toggle / **Scope** chip, following the existing `af-hwatch` chip + expandable-editor pattern (or a
  small inline number stepper). Only meaningful for an enrolled + configured repo; show the current
  value (e.g. "Parallel: N" / "In-flight cap: N"), edit via a `min=1` integer input with an Apply
  action calling `setRepoWatchInFlightCap`. Import the new store fn.

### 6. Docs

- **`README.md` §5 "Milestone 11"** — update the "Still open: a configurable cap > 1" note to reflect
  that it has shipped (this issue).
- **`README.md` §9.10** — revise "**Sequential by default (in-flight cap 1):**" to document the
  configurable per-repo cap (default 1 = sequential), how to set it (the dashboard control /
  `inFlightCap` field of `POST /repos/watch`), oldest-first fill up to N free slots, and that a
  `needs_human`/parked run still holds its slot. Note actual concurrency is bounded by
  `FLEET_CONCURRENCY`.

## Risks & edge cases

- **Contract change to `decideIntake` (`start` → `starts`)**: contained — only the poller + the two
  test files consume it. All call sites updated in the same change.
- **Cost ceiling burst**: admitting N at once could hit the global cost ceiling mid-loop. Handled by
  breaking the per-pass start loop on the first `start()` throw (same catch semantics as today).
- **Slot accounting unchanged**: a non-`stopped` run (including `needs_human`) still counts as
  in-flight, so a parked issue holds its slot and the queue pauses rather than skipping ahead — the
  existing dedup + slot rules are reused verbatim, just with `free = cap - inFlight` instead of a
  binary check.
- **Clamping / validation**: `decideIntake` already clamps `cap` to `>= 1`; the API layer additionally
  rejects non-integer / `< 1` so a bad value never reaches the store. Empty/absent leaves the column
  untouched.
- **Backward-compat**: additive column with constant default `1`; older DBs backfill to 1; older
  dashboards/daemons without the field default to 1. No behavior change unless an operator opts in.
- **Migration drift guard**: `src/store/db.test.ts` compares `columns(db,'repos')` between a migrated
  old DB and a fresh one; keeping `schema.sql` and migration 17 in lockstep keeps that green.

## Testing

- **`src/loop/issue-intake.test.ts`** (pure): update existing assertions from `plan.start` to
  `plan.starts`. Add:
  - cap N with ≥ N+1 eligible issues → `starts` has exactly N entries, oldest-first; the extra is
    neither started nor skipped (it just waits).
  - cap N with `inFlight` already at N → `starts` empty.
  - cap N with `inFlight = k < N` and M eligible → `starts` length = `min(N-k, M)`.
  - default cap 1 still admits exactly one (regression).
  - ineligible issues within the fill window still land in `skipped`.
- **`src/loop/issue-intake-poller.test.ts`** (driver): the required ingestion test — a watched repo at
  **cap N** with N+1 eligible open issues → **one pass admits exactly N runs**, the N+1th is not
  started; then free a slot (close/stop one run's issue) and a further pass admits the N+1th. Assert
  `pass.started` and `repo.listRuns()` counts.
- **`src/store/repository.test.ts`**: `setRepoWatch` persists `watchInFlightCap`; a plain watch toggle
  leaves a previously-set cap untouched; default is 1.
- **`src/store/db.test.ts`**: add a retrofit test (mirroring the conflict_policy / watch-filter ones) —
  a DB created before `watch_in_flight_cap` gets the column via migration 17, backfilled to `1`, and
  the migrated `repos` columns equal a fresh DB's.
- **`src/api/server.test.ts` / `src/api/orchestrator.test.ts`**: `POST /repos/watch` accepts a valid
  `inFlightCap` and persists it (round-trips via `GET /repos`); rejects `0`, negative, and non-integer
  with `400`; omitting it leaves the stored cap unchanged.
- **`dashboard/src/lib/render.test.ts`**: `repoLedgerModel` surfaces `watchInFlightCap` (and defaults
  to 1 when the daemon omits it).

## Scope flags

- `needs_backend`: **true** (store schema/migration, pure decision, poller, API).
- `needs_frontend`: **true** (types, render model, store action, Home.svelte control).
