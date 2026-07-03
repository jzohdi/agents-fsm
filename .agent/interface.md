# Interface — Allow changing the harness (and model/effort) when resuming a paused run

Issue: jzohdi/agents-fsm#6 · builds on `.agent/plan.md`.

This pins the exact types, signatures, routes, data shapes, and invariants the TDD stage writes
tests against and the implementation satisfies. The whole change **mirrors the existing
`setModel`/`setEffort` pattern** end-to-end (store → orchestrator → route → dashboard). No `src/fsm/`
changes; no loop/resume changes.

---

## 1. Repository layer — `src/store/repository.ts`

### `setRunHarness(id: number, harness: string): void`

One-statement column update, placed next to `setRunModelOverride` (`:589`) /
`setRunEffortOverride` (`:597`):

```ts
/**
 * Change a run's pinned harness. The runner resolves the executor per-stage via
 * `harnesses.for(run.harness)`, reading this fresh each stage, so a change takes effect on the run's
 * **next** stage (the current in-flight stage keeps its harness). Persisted → survives an app restart.
 */
setRunHarness(id: number, harness: string): void {
  this.db.prepare(`UPDATE runs SET harness = ?, updated_at = ${NOW} WHERE id = ?`).run(harness, id);
}
```

**Invariants**

- Writes only the `harness` column (+ bumps `updated_at`); no other run fields touched.
- No validation here — the id is validated one layer up in `Orchestrator.setHarness` (matches how
  `setRunModelOverride` trusts its caller).
- Round-trips: `getRun(id).harness === harness` after the call (the "persists across restart"
  criterion is proven at this layer).

---

## 2. Orchestrator layer — `src/api/orchestrator.ts`

### `setHarness(runId: number, harness: string): Run`

Mirrors `setModel` (`:433`) / `setEffort` (`:462`). Placed alongside them.

```ts
/**
 * Change a **non-terminal** run's harness (the dashboard's harness selector). Takes effect on the
 * run's **next** stage — the runner resolves `harnesses.for(run.harness)` per stage — while the
 * current in-flight stage keeps its harness (no `kick`; the run advances on its own event flow, and a
 * paused run only advances on Resume). Refuses (`409`) a terminal run and (`400`) an unknown harness id.
 * Because the model catalog is per-harness, a `model_override`/`effort_override` from the old harness
 * may be invalid under the new one, so **both overrides are cleared** — the run falls back to the new
 * harness's default, guaranteeing no wrong-catalog model reaches the next stage.
 */
setHarness(runId: number, harness: string): Run
```

**Behavior (ordered)**

1. `const existing = this.requireRun(runId);` — 404 if missing.
2. If `TERMINAL_STATUSES.has(existing.status)` → `throw new ApiError(409, ...)`, message shape
   matching `setModel`: `cannot set the harness for a "${existing.status}" run — it has no further
   stages`. Terminal = `done` / `stopped`; **any** non-terminal status is allowed (paused, running,
   needs_human, awaiting_input, stopped-is-terminal) — same policy as model/effort, chosen for
   consistency over pause-only gating.
3. If `!isHarnessId(harness)` → `throw new ApiError(400, `unknown harness "${harness}"`)`. Validate
   **before** any write. (`isHarnessId` already imported `:45`.)
4. `this.repo.setRunHarness(runId, harness);`
5. **Clear both overrides** — `this.repo.setRunModelOverride(runId, null);` and
   `this.repo.setRunEffortOverride(runId, null);`. This mirrors `setDefaultHarness` (`:693`), which
   already clears the persisted default model + effort on a harness change. Clear unconditionally
   (simpler and safe) rather than re-validate-and-keep.
6. `const run = this.requireRun(runId);`
7. `this.broadcaster.publish({ type: 'status', runId: run.id, status: run.status, run });`
8. `return run;`

**Invariants**

- No status change: `run.status === existing.status` (a paused run stays paused; its parked stage is
  untouched).
- On the returned run: `run.harness === harness`, `run.modelOverride === null`,
  `run.effortOverride === null`.
- Exactly one `status` broadcast published; **no** `kick()` call.
- On the 400/409 throw paths, **nothing** is written (harness unchanged, overrides unchanged) — the
  guards precede every `repo` write.

### `getModels(harness?: string): { harness: string | null; models: HarnessCatalog['models']; defaultModel: string | null }`

Extend the existing `getModels` (`:653`) with an **optional** harness argument so the dashboard can
fetch the catalog for a run whose harness ≠ the default.

```ts
getModels(harness?: string): { harness: string | null; models: HarnessCatalog['models']; defaultModel: string | null }
```

**Behavior**

- `const target = harness ?? this.defaultHarness;` — absent arg preserves today's behavior exactly
  (default-harness catalog), so `GET /models` with no query is unchanged.
- `const catalog = this.catalogFor?.(target);`
- `defaultModel`: keep the existing rule — report `this.defaultModel` only when
  `catalog && catalogHasModel(catalog, this.defaultModel)`, else `null`. (For a non-default `harness`
  arg the daemon's `defaultModel` won't be in that catalog → `null`, which is correct: a non-default
  harness has no daemon-configured default model.)
- Return `{ harness: catalog?.harness ?? null, models: catalog?.models ?? [], defaultModel }`.

**Note:** validation of an unknown `harness` id is done at the **route** layer (400), not here — here
an unknown id just yields an empty catalog via `catalogFor` returning `undefined`. (Route validates so
the API contract is explicit; see §3.)

---

## 3. HTTP routes — `src/api/server.ts`

### `POST /runs/:id/harness`

Extend the `actionMatch` regex (`:160`) to include `harness`:

```
/^\/runs\/(\d+)\/(pause|resume|stop|revert|archive|unarchive|cost-override|model|effort|harness)$/
```

Add a `case 'harness'` in the switch (`:163`), mirroring `case 'model'` (`:192`):

```ts
case 'harness': {
  // `harness`: a harness id to run this run under on its next stage. Must be a non-empty string
  // (unlike model/effort, there is no "clear to default" — a run always has a harness).
  const raw = (await readJson(req)).harness;
  if (typeof raw !== 'string') {
    return sendError(res, new ApiError(400, '"harness" (string) is required'));
  }
  return sendJson(res, 200, orch.setHarness(id, raw));
}
```

- **Request body:** `{ "harness": string }` (a known harness id, e.g. `"claude-code"` | `"cursor"`).
  Unlike model/effort, `null` is **not** accepted — a run must always have a harness.
- **Responses:** `200` → the updated `Run` JSON; `400` non-string body **or** unknown harness id (the
  latter from `setHarness` via `isHarnessId`); `409` terminal run; `404` unknown run id.

### `GET /models?harness=<id>`

Extend the `/models` route (`:74`) to read an optional `harness` query param:

```ts
if (method === 'GET' && path === '/models') {
  const harness = url.searchParams.get('harness') ?? undefined;
  if (harness !== undefined && !isHarnessId(harness)) {
    return sendError(res, new ApiError(400, `unknown harness "${harness}"`));
  }
  return sendJson(res, 200, orch.getModels(harness));
}
```

- Requires importing `isHarnessId` into `server.ts` if not already imported.
- **No `harness` param** → unchanged behavior (default-harness catalog).
- **Unknown `harness`** → `400 unknown harness "<id>"`.
- **Known `harness`** → that harness's catalog, shape identical to today's `GET /models` payload
  (`{ harness, models, defaultModel }`).

Update the route-header doc comment (server file top `:17`) to mention the new harness setter and the
`?harness=` param, matching the existing comment style.

---

## 4. Dashboard store — `dashboard/src/lib/store.svelte.ts`

### New UI state: `ui.runModels`

Add a per-run catalog field to the `ui` reactive object, alongside `ui.models`:

```ts
runModels: null as ModelCatalog | null,
```

- `ui.models` (unchanged) = the **default-harness** catalog (used by the new-run bar).
- `ui.runModels` = the **selected run's** harness catalog (used by RunDetail). Its `harness` field
  always equals the selected `run.harness` once loaded.

### `loadRunModels(harness: string): Promise<void>`

```ts
/** Fetch the model catalog for a specific harness (the selected run's), into `ui.runModels`;
 *  tolerant of an older daemon (no `?harness=` support) → null, like `loadModels`. */
export async function loadRunModels(harness: string): Promise<void> {
  try {
    ui.runModels = await request<ModelCatalog>('GET', `/models?harness=${encodeURIComponent(harness)}`);
  } catch {
    ui.runModels = null; // older daemon / unknown harness — the RunDetail dropdown just won't render
  }
}
```

**When called:**
- When the run detail opens for a run and whenever the selected run's `harness` changes (drive from a
  `$effect` in `RunDetail.svelte` keyed on `run.harness`, or from `selectRun`/`refreshDetail` in the
  store — implementation's choice, as long as `ui.runModels.harness` tracks the selected run).
- After `setHarness` resolves (so the dropdown follows the newly-chosen harness).

### `setHarness(id: number, harness: string): Promise<void>`

Mirrors `setModel` (`:305`):

```ts
/**
 * Change the selected run's harness. Takes effect on the run's next stage (the current stage keeps its
 * harness). The daemon clears the run's model/effort overrides on this change, so the refreshed run row
 * reflects that. Reloads the per-run catalog for the new harness so the model dropdown follows it.
 */
export async function setHarness(id: number, harness: string): Promise<void> {
  try {
    upsertRun(await request<Run>('POST', `/runs/${id}/harness`, { harness }));
    await loadRunModels(harness);          // catalog follows the new harness
    if (id === ui.selectedId) await refreshDetail();
  } catch (err) {
    banner(`Harness change failed: ${(err as Error).message}`, 'err');
  }
}
```

**Invariant:** after resolution `ui.runModels?.harness === harness` (when the daemon supports the
per-run catalog), and the upserted run row shows the cleared overrides.

---

## 5. Dashboard RunDetail — `dashboard/src/lib/RunDetail.svelte`

### Harness `<select>` (new control)

In `.af-controls` (`:128`), before the model/effort block, for a **non-terminal** run and only when
more than one harness exists — reuse the `FileRunBar.svelte` harness-select pattern + `humanizeHarness`
(already imported `:5`) and `setHarness` from the store:

```svelte
{#if !terminal && ui.harnesses.length > 1}
  <label class="af-harness">
    <span class="lbl">harness</span>
    <select value={run.harness} onchange={(e) => setHarness(run.id, e.currentTarget.value)} aria-label="run harness">
      {#each ui.harnesses as h (h)}<option value={h}>{humanizeHarness(h)}</option>{/each}
    </select>
  </label>
{/if}
```

- `import { ..., setHarness } from './store.svelte'` (add to the `:2` import).

### Model / effort block — source from the **per-run** catalog

Replace the default-harness `ui.models` + `catalogMatchesRun` gate (`:38`–`:51`, `:129`) with the
per-run `ui.runModels` catalog (whose `harness` always equals `run.harness`), so the dropdown shows
for **any** harness — including after a switch — closing the `plans/harness-abstraction.md` §9 gap.

Recompute the derived values from `ui.runModels`:

```ts
// The per-run catalog (GET /models?harness=run.harness) — always this run's harness, unlike ui.models
// (the default harness's). Loaded via loadRunModels; null on an older daemon → controls hide.
const runCatalog = $derived(ui.runModels && ui.runModels.harness === run?.harness ? ui.runModels : null);
const model = $derived(run?.modelOverride ?? runCatalog?.defaultModel ?? 'default');
const runEfforts = $derived.by(() => {
  const id = run?.modelOverride ?? runCatalog?.defaultModel;
  return (id ? runCatalog?.models.find((m) => m.id === id)?.efforts : undefined) ?? [];
});
```

Gate the model picker on `runCatalog` instead of `catalogMatchesRun`:

```svelte
{#if !terminal && runCatalog && runCatalog.models.length}
  <div class="af-model">
    <span class="lbl">model</span>
    <ModelPicker
      models={runCatalog.models}
      value={run.modelOverride}
      defaultLabel={runCatalog.defaultModel}
      onselect={(id) => setModel(run.id, id)}
      ariaLabel="run model"
    />
  </div>
  {#if runEfforts.length}
    <EffortSelect efforts={runEfforts} value={run.effortOverride} onselect={(e) => setEffort(run.id, e)} ariaLabel="run reasoning effort" />
  {/if}
{/if}
```

- The live-box harness label (RunDetail `:318` area) keeps reading `run.harness` — unchanged.
- `catalogMatchesRun` is removed once nothing references it.

---

## 6. Data shapes (unchanged, referenced)

- **`Run`** (`dashboard/src/lib/types.ts:~10`) — already carries `harness: string`,
  `modelOverride: string | null`, `effortOverride: string | null`. No shape change; the harness change
  just mutates these three fields on the returned row.
- **`ModelCatalog`** (`types.ts:66`) — `{ harness: string | null; models: HarnessModel[]; defaultModel: string | null }`.
  The `GET /models?harness=` response reuses this shape verbatim.
- **`Settings`** (`types.ts:41`) — already exposes `harnesses: string[]`; `ui.harnesses` (populated by
  `loadSettings`) is the option list for the new select. No change.

---

## 7. Handoff context (issue point #3) — confirm-only, no code

Stage state lives in durable, harness-neutral artifacts on disk (`.agent/plan.md`, `.agent/interface.md`,
tests, etc.); the next stage's prompt is assembled from artifacts + recipe (`src/agent/runner.ts`
`StagePrep`/prompt assembly), not from harness-specific in-memory state, and the `reentry` mechanism
already exists. A harness switch at a stage boundary therefore needs no special handoff. **Confirm** by
inspecting the runner's prompt assembly during implementation; add plumbing only if a concrete gap
surfaces (none expected). No code change planned here.

---

## 8. Mixed-harness representation (accepted, no new work)

A run whose earlier stages ran on harness A and later on B is now possible. The dashboard already
distinguishes it: `Pipeline.svelte:~67` shows a harness badge when `r.harness !== ui.defaultHarness`,
and cost/token accounting for a cost-blind harness (Cursor) already renders "n/a" via
`fmtRunCost`/`tracksCost`. The badge reflects the run's **current** harness; partial cost accounting
across a mid-flight switch is accepted, consistent with the §8.2 Cursor cost-blindness stance. No new
representation work.

---

## 9. Invariants the implementation must uphold (summary)

1. **Next-stage effect, not mid-stage:** a harness change never affects the current in-flight stage;
   it lands on the next dispatch because the runner re-reads `run.harness` per stage. `setHarness`
   makes no `kick()` call and does not change run status.
2. **No wrong-catalog carryover:** after any harness change, `model_override` and `effort_override`
   are both `null`. (Core hazard the issue calls out.)
3. **Guard parity with model/effort:** unknown harness id → `400`; terminal run → `409`; unknown run
   → `404`. Guards precede all writes (a rejected call mutates nothing).
4. **Persistence:** the harness change is written to the `runs.harness` column and survives an app
   restart (proven at the repository layer via `getRun`).
5. **Backward compatibility:** `GET /models` with no query and existing `setModel`/`setEffort`
   behavior are unchanged; new dashboard controls degrade gracefully (hide / null) against an older
   daemon lacking `?harness=` or `POST /runs/:id/harness`.
6. **Dropdown follows the run:** the RunDetail model/effort controls source from `ui.runModels`
   (the run's harness catalog), so they render for **any** harness, not only the default one.

---

## 10. Test surface (for the TDD stage)

- **Repository** (`src/store/repository.test.ts`): `setRunHarness` updates the column, bumps
  `updated_at`, round-trips via `getRun` (survives reload).
- **Orchestrator** (`src/api/orchestrator.test.ts`, mirror the `setModel` tests):
  - happy path — persists harness, returns the run, emits exactly one `status` event;
  - **clears both** model + effort overrides (set model+effort → `setHarness` → both `null`);
  - status/parked stage unchanged (a `paused` run stays `paused`);
  - `409` on a terminal (`done`/`stopped`) run — nothing written;
  - `400` on an unknown harness id — nothing written;
  - `getModels('cursor')` returns the Cursor catalog; `getModels()` still returns the default;
    `getModels('<unknown>')` returns an empty catalog (route enforces the 400).
- **Route** (`src/api/server.test.ts`): `POST /runs/:id/harness` → `200` valid, `400` non-string /
  unknown id, `409` terminal; `GET /models?harness=<id>` → correct catalog, `400` unknown harness.
- **Dashboard:** manual — for a paused run, harness/model/effort controls all render; picking a
  different harness updates the model dropdown to that harness's catalog and clears the shown
  model/effort; the model dropdown no longer hides for a non-default-harness run.
- Full `npm test` + typecheck/lint before finishing; keep the working tree clean (no `dist`, no
  lockfile churn).
