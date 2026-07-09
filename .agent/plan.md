# Plan — Per-harness model catalogs for off-default runs: doc cleanup + verify (#13)

## Goal (restated)

The runtime feature this issue originally tracked **already shipped on `main`** — the server resolves any
harness's catalog via `GET /models?harness=<id>` and the dashboard run inspector loads the *run's own*
harness catalog. This run must **not** re-implement anything. It closes a documentation gap and locks the
off-default run-inspector picker with a small unit test:

1. Fix the README §9.8 caveat that still claims off-default per-harness catalogs are deferred.
2. Remove the stale `#13` entry from the README "not-yet-built planned work" roadmap.
3. Add (only if missing) a small unit test that the dashboard store's `loadCatalog` caches a per-harness
   catalog **only when the returned `harness` matches the requested one** (the mismatch-refusal guard).

## What already exists (verified in the tree)

- **Server:** `GET /models?harness=<id>` → `Orchestrator.getModels(harness?)`
  (`src/api/orchestrator.ts:970`), returns `400` for an unknown id. Covered by
  `src/api/server.test.ts:161` ("serves a specific harness's catalog via GET /models?harness=, 400ing an
  unknown one"). **No change needed; no new test needed here.**
- **Dashboard:** `loadCatalog(harness)` in `dashboard/src/lib/store.svelte.ts:419` fetches
  `GET /models?harness=<harness>`, caches into `ui.catalogs[harness]` **only if `catalog.harness ===
  harness`** (refuses an older daemon's default-catalog fallback where `catalog.harness` is `null`/another
  id). `RunDetail.svelte` reads `ui.catalogs[run.harness]`, loaded lazily via an `$effect` on the run's
  harness. So a live off-default run is offered its own harness's models.
- `ModelCatalog.harness` is typed `string | null` (`dashboard/src/lib/types.ts:66`), which is exactly what
  the guard defends against.

## Exact edits

### 1. README §9.8 caveat (lines ~920–922)

Current bullet (obsolete):
> - The per-run **model picker** (in the run inspector) appears only for a run whose harness matches the
>   loaded catalog (i.e. the current default's), so it never offers wrong-harness models; per-harness
>   catalogs for off-default runs are deferred.

Replace with an accurate description: the run inspector loads the catalog of the **run's own** harness via
`GET /models?harness=<run.harness>` (cached per harness in `ui.catalogs`), so an off-default run gets a
working per-run model picker showing *its* harness's models — never the daemon default's. Note the
graceful degradation: against an older daemon that ignores the query param and returns the default
catalog, the harness-field mismatch guard refuses to cache it, so such a run simply shows no picker rather
than wrong-harness models. This bullet is no longer an "accepted caveat" — it now describes shipped
behavior, so it should be reworded to read as behavior/notes rather than a deferral. (Keep the other two
caveat bullets — Cursor cost `n/a` and Cursor auth — unchanged.)

### 2. README roadmap (line 682)

Remove the entire line:
> - **Per-harness model catalogs for off-default runs** — [#13](...).
from the "Everything below is not-yet-built planned work" list, since it is built. Leave the surrounding
list entries intact.

### 3. Dashboard test — the `loadCatalog` mismatch guard

The store's per-harness caching behavior is **not** currently unit-tested (existing dashboard tests —
`model-picker.test.ts`, `render.test.ts`, `auth.test.ts` — only cover pure `.ts` modules; none import a
`.svelte.ts` rune module). Add a small unit test asserting `loadCatalog`:

- caches into `ui.catalogs[harness]` when the response's `catalog.harness === harness`;
- **refuses** to cache when `catalog.harness` is a different id or `null` (older-daemon fallback);
- short-circuits (no refetch) when `ui.catalogs[harness]` is already populated.

**Approach — primary:** add `dashboard/src/lib/store.test.ts` that `vi.mock('./api')`s the `request`
export, then imports `loadCatalog` and `ui` from `./store.svelte.ts` and asserts against `ui.catalogs`.
Because `store.svelte.ts` uses the `$state` rune, the root `vitest.config.ts` must transform `.svelte.ts`
via the Svelte plugin, which is **already a devDependency** (`@sveltejs/vite-plugin-svelte`, `svelte` ^5).
The change to `vitest.config.ts` is a single `plugins: [svelte()]` (with the runes/hot preprocessing the
plugin applies by default) — it is a no-op for the existing plain-`.ts` backend and dashboard tests
(the transform only touches `.svelte`/`.svelte.ts` files) and needs **no** jsdom/testing-library/e2e
scaffolding (runes run under the default node environment). This stays within the issue's "do not add
heavyweight e2e scaffolding" boundary.

**Fallback (only if enabling the plugin proves disruptive to the existing suite):** extract the guard as a
pure predicate in a plain `.ts` module (e.g. `catalogMatchesHarness(catalog, requested)` returning
`catalog.harness === requested`), have `loadCatalog` call it, and unit-test the predicate directly — no
vitest-config change. This is a smaller but shallower test; prefer the primary approach if the plugin
integrates cleanly.

The implementer should confirm which path the suite supports by running `npm test` after the change, and
must not leave the plugin registered if it breaks unrelated tests.

## Files to change

- `README.md` — reword §9.8 caveat bullet (~L920–922); delete roadmap line L682.
- `dashboard/src/lib/store.test.ts` — **new**, the `loadCatalog` guard test (primary approach).
- `vitest.config.ts` — register the Svelte plugin so `.svelte.ts` rune modules load in tests (primary
  approach only).
- *(Fallback only)* small pure predicate in a plain `.ts` module + its use in `loadCatalog`.

No `src/` (backend) runtime changes. No changes to `FileRunBar`/new-run bar (non-goal). No new API surface.

## Risks & edge cases

- **Plugin registration side effects:** adding `svelte()` to the root vitest config could, in principle,
  alter how the ~existing backend tests resolve. Mitigation: the transform is scoped to Svelte files;
  verify with a full `npm test` run. If it regresses anything, use the fallback (no config change).
- **Rune reactivity in a non-DOM test:** `$state` works under node without a DOM; assert on `ui.catalogs`
  synchronously after `await loadCatalog(...)`. No `flushSync`/DOM needed since we read plain state.
- **Test isolation:** `ui.catalogs` is module-global state; reset it (e.g. `beforeEach` clearing
  `ui.catalogs`) so cases don't leak the "already cached → short-circuit" path into each other.
- **Doc drift:** ensure the reworded §9.8 bullet no longer reads as a deferral and the roadmap no longer
  lists #13 — both are explicit acceptance criteria.
- **Clean tree:** remove any stray build/coverage output; `.agent/` scratch is stripped before merge by
  the orchestrator.

## How it will be tested

- `npm test` — the whole vitest suite, including the existing `src/api/server.test.ts` off-default server
  coverage and the new store guard test, must pass.
- `npm run check:dashboard` (svelte-check) — ensure the new test + any config change typecheck cleanly.
- Manual doc read-through of README §9.8 and the roadmap list against the acceptance criteria.

## Scope flags

- `needs_frontend: true` — the substantive change is the dashboard store test (+ its vitest wiring) and the
  README docs describe frontend behavior.
- `needs_backend: false` — the server path is already shipped and covered; no `src/` runtime change.
