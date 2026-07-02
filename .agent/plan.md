# Plan — Allow changing the harness (and model/effort) when resuming a paused run

Issue: jzohdi/agents-fsm#6

## Goal (restated)

Let an operator change a **paused** (non-terminal) run's **harness** — and, if desired, its
model/effort — before clicking **Resume**, and have the resumed run pick up the new harness/model on
its **next** stage. The change must persist (survive an app restart) and reach the next stage through
the existing per-stage config reload. Model/effort are already changeable; the net-new gap is
**harness**.

## Current state (verified against the code)

- **Model + effort are already per-run changeable.** `Orchestrator.setModel` / `setEffort`
  (`src/api/orchestrator.ts:433,462`) persist an override via `Repository.setRunModelOverride` /
  `setRunEffortOverride` (`src/store/repository.ts:589,597`), validated against the **run's own**
  harness catalog (`catalogFor(existing.harness)`), refusing terminal runs (409) and unknown
  model/effort (400). `AgentRunner.invokePhase` (`src/agent/runner.ts:477`) reads the override fresh
  from the run row each stage, so it lands on the next stage. Routes: `POST /runs/:id/model`,
  `POST /runs/:id/effort` (`src/api/server.ts:192,200`).
- **Harness is pinned at start.** `runs.harness` is set in `createRun` and never mutated. The runner
  resolves the executor per-stage via `this.harnesses.for(run.harness)` (`src/agent/runner.ts:507`),
  so a persisted harness change would already flow to the next stage — but there is **no** setter:
  no `Repository.setRunHarness`, no `Orchestrator.setHarness`, no `POST /runs/:id/harness`, no
  dashboard control. This is the real gap.
- **Resume already re-dispatches with a fresh row read.** `resumePausedRun` flips `paused → running`
  and the loop re-dispatches the parked stage, reloading the run row — so persisting the harness
  change is sufficient; no "detect on resume" step is needed (mirrors model/effort exactly).
- **Dashboard model/effort controls already exist** for a non-terminal run in `RunDetail.svelte`
  (`:129`), gated by `catalogMatchesRun` (`:41`) — the single `ui.models` catalog is the **default
  harness's**, loaded once (`store.svelte.ts:215`). So the model dropdown **hides** for a run whose
  harness ≠ the default harness. This is exactly the `plans/harness-abstraction.md` §9 deferral
  ("per-harness model catalogs for a non-default run's model dropdown"). After a harness switch to a
  non-default harness the dropdown would currently vanish — issue point #2 requires the dropdown to
  follow the **run's** (possibly newly-chosen) harness catalog, so we must fetch a per-run catalog.
- **Design intent:** harness was deliberately pinned per run for determinism across resume
  (`plans/harness-abstraction.md` §8.2/§9); per-run/per-resume override was designed-for but deferred.
  This issue intentionally relaxes that at a stage boundary.

## Approach

Mirror the existing `setModel`/`setEffort` pattern end-to-end (store → orchestrator → route →
dashboard). The change takes effect on the run's **next** stage because the runner re-reads the row
per stage; the current in-flight stage keeps its harness. No FSM changes (`src/fsm/` untouched — per
memory, never touch it). No loop/resume changes.

### Backend

1. **`Repository.setRunHarness(id, harness)`** (`src/store/repository.ts`) — a one-line
   `UPDATE runs SET harness = ?, updated_at = NOW WHERE id = ?`, alongside `setRunModelOverride`.
   Add a doc comment matching the neighbors (read fresh by the runner each stage → next-stage effect).

2. **`Orchestrator.setHarness(runId, harness): Run`** (`src/api/orchestrator.ts`) — mirror `setModel`:
   - `requireRun` (404).
   - Refuse terminal runs (409) via `TERMINAL_STATUSES` — same message shape as `setModel`. This
     naturally answers the "which statuses" question: **any non-terminal** run (paused, running,
     needs_human, awaiting_input) is allowed, exactly like model/effort; `stopped`/`done` are 409.
     (The issue is framed around pause→resume but consistency with `setModel` is simpler and correct —
     the current stage keeps its harness regardless.)
   - Validate the id with `isHarnessId` (already imported, `:45`) → 400 on unknown, before any write.
   - **Cross-harness catalog mismatch:** after `setRunHarness`, **clear both** `model_override` and
     `effort_override` (`setRunModelOverride(runId, null)` + `setRunEffortOverride(runId, null)`),
     because the stored model/effort belong to the **old** harness's catalog and may be invalid under
     the new one. This mirrors `setDefaultHarness` (`:693`), which already clears the persisted default
     model + effort on a harness change. (Alternative — re-validate and keep if still valid — is more
     code for little benefit; clearing to the new harness's default is the safe, predictable choice and
     guarantees no wrong-catalog model reaches the next stage.)
   - Reload the run, publish a `status` broadcast event (like `setModel`), and **return** it. No
     `kick()` (the run advances on its own event flow; matches `setModel`).

3. **Route `POST /runs/:id/harness`** (`src/api/server.ts`) — add `harness` to the `actionMatch` regex
   (`:160`) and a `case 'harness'` in the switch (`:163`): read `harness` (must be a string; else 400
   like the model/effort cases), call `orch.setHarness(id, harness)`, return the run. Update the route
   doc-comment header (`:17`).

4. **Per-run catalog: `getModels(harness?)`** (`src/api/orchestrator.ts:653`) — accept an optional
   harness id, defaulting to `this.defaultHarness` (preserving today's `GET /models` behavior). Extend
   the route (`src/api/server.ts:74`) to read `?harness=<id>` from `url.searchParams` and pass it
   through, validated with `isHarnessId` (400 on unknown). This lets the dashboard fetch the catalog
   for a run whose harness ≠ the default, closing the §9 gap so the model dropdown follows the run's
   harness.

### Frontend

5. **`store.svelte.ts`:**
   - `setHarness(id, harness)` — `POST /runs/${id}/harness` with `{ harness }`, `upsertRun` the
     returned run, and `refreshDetail()` when it's the selected run (mirrors `setModel`, `:305`).
     Because the server clears model/effort on harness change, the refreshed run row reflects that.
   - Per-run catalog: add `ui.runModels` (a `ModelCatalog | null`) and `loadRunModels(harness)` that
     fetches `GET /models?harness=<harness>` (tolerant of older daemons → null, like `loadModels`).
     Call it when the run detail opens / the selected run's harness changes / after `setHarness`
     resolves. This is what makes the model dropdown follow the run's harness.

6. **`RunDetail.svelte`:**
   - Add a **harness `<select>`** for a non-terminal run in `.af-controls` (`:128`), next to the
     model/effort controls, populated from `ui.harnesses` and shown only when `ui.harnesses.length > 1`
     (reuse the `FileRunBar.svelte:121` pattern + `humanizeHarness`), value = `run.harness`,
     `onchange → setHarness(run.id, value)`.
   - Switch the model/effort block from the default-harness `ui.models` + `catalogMatchesRun` gate to
     the **per-run** `ui.runModels` catalog (whose `harness` always equals `run.harness`). Recompute
     `model`, `runEfforts`, and the ModelPicker/EffortSelect `models=` / `defaultLabel=` from
     `ui.runModels`. The dropdown then shows for **any** harness (including after a switch), not just
     the default one — satisfying "the RunDetail model dropdown should follow the run's (possibly
     newly-chosen) harness catalog." Keep the live-box label (`:318`) reading `run.harness`.

### Handoff context (issue point #3)

Stage state lives in durable, harness-neutral artifacts on disk (`.agent/plan.md`, interface, etc.)
and the next stage reads them; the `reentry` mechanism already exists. A harness switch at a stage
boundary needs no special handoff. **Confirm** by inspecting the runner's `StagePrep`/prompt assembly
(`src/agent/runner.ts`) — the prompt is built from artifacts + recipe, not from harness-specific state.
Only add plumbing if a concrete gap surfaces; none is expected. No code change planned here.

### Mixed-harness representation

A run whose earlier stages ran on harness A and later on B is now possible. The dashboard already
distinguishes it: `Pipeline.svelte:67` shows a harness badge when `r.harness !== ui.defaultHarness`,
and cost/token accounting for a cost-blind harness (Cursor) already renders "n/a" via
`fmtRunCost`/`tracksCost`. The badge reflects the run's **current** harness; partial cost accounting
across a mid-flight switch is accepted (consistent with the §8.2 Cursor cost-blindness stance). No new
representation work is required beyond what already exists.

## Files to change

- `src/store/repository.ts` — `setRunHarness`.
- `src/api/orchestrator.ts` — `setHarness`; `getModels(harness?)` optional param.
- `src/api/server.ts` — `POST /runs/:id/harness` route + case; `GET /models?harness=` param; route
  header comment.
- `dashboard/src/lib/store.svelte.ts` — `setHarness`, `ui.runModels` + `loadRunModels`.
- `dashboard/src/lib/RunDetail.svelte` — harness `<select>`; model/effort block sourced from the
  per-run catalog.
- Tests: `src/api/orchestrator.test.ts`, `src/store/repository.test.ts` (and server test coverage if
  present) — see Testing.

## Risks & edge cases

- **Wrong-catalog model surviving a switch** — the core hazard the issue calls out. Mitigated by
  clearing both overrides in `setHarness`; assert this in a test (set model → switch harness → both
  overrides null).
- **Terminal / unknown-id guards** — 409 for `stopped`/`done`, 400 for a bad harness id, matching
  `setModel`. Cover both.
- **Older-daemon tolerance in the dashboard** — `GET /models?harness=` and `POST /runs/:id/harness`
  may 404 on an older daemon; the harness select and per-run catalog fetch must degrade gracefully
  (hide / null), like the existing `loadModels`/settings fallbacks.
- **Registered vs. valid harness** — `isHarnessId` only checks the id is known; the runner still
  resolves the executor per-stage via `harnesses.for` and escalates the single run to `needs_human` if
  a harness is unregistered (`runner.ts:504` comment). Switching to a known-but-unregistered harness
  fails safely per-run, not fleet-wide. No extra guard needed.
- **No `kick()`** — matches `setModel`; a paused run only advances on Resume, so the change simply
  sits on the row until the next dispatch. Verify a paused run's status/parked stage is unchanged by
  the call.
- **Keep the working tree clean** — no build output / dashboard `dist` committed; revert incidental
  lockfile churn.

## Testing

- **Unit (orchestrator):** `setHarness` happy path (persists, returns run, emits a `status` event);
  clears model + effort overrides; 409 on terminal; 400 on unknown id; `getModels('cursor')` returns
  the Cursor catalog and `getModels()` still returns the default. Mirror the existing `setModel`
  tests.
- **Unit (repository):** `setRunHarness` updates the column and bumps `updated_at`; round-trips via
  `getRun` (survives reload → the "persists across restart" acceptance criterion).
- **Route:** `POST /runs/:id/harness` → 200 with a valid id, 400 non-string / unknown id, 409
  terminal; `GET /models?harness=<id>` returns the right catalog and 400 on an unknown harness (follow
  the existing server test style if a server test file exists).
- **Resume integration (if a harness-swap fixture is cheap):** start a run, pause, `setHarness`,
  resume, assert the next dispatch resolves the new harness's executor and the cleared overrides.
- **Dashboard:** manual check — for a paused run the harness/model/effort controls all render; picking
  a different harness updates the model dropdown to that harness's catalog and clears the shown
  model/effort; the model dropdown no longer hides for a non-default-harness run.
- Full `npm test` + typecheck/lint before finishing.

## Scope flags

- `needs_backend: true` — repository setter, orchestrator method, routes.
- `needs_frontend: true` — RunDetail harness control + per-run catalog wiring in the store.
