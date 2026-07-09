# Interface — Per-harness catalogs off-default runs: doc cleanup + verify (#13)

This is a **documentation + test-coverage** change. The runtime already shipped and is unchanged.
There is **no new production API, type, or signature** to design. The only "interfaces" to pin are:
(1) the exact behavioral contract of the existing `loadCatalog` that the new test asserts, and
(2) the test-harness wiring required so a `.svelte.ts` rune module loads under vitest.

## 1. Contract under test — `loadCatalog` (already shipped; do NOT change it)

`dashboard/src/lib/store.svelte.ts`

```ts
export async function loadCatalog(harness: string): Promise<void>
```

Observable behavior the new test must lock (source of truth: `store.svelte.ts:419`):

| # | Precondition | Action | Postcondition (the invariant) |
|---|---|---|---|
| C1 | `ui.catalogs[h]` empty; `request('GET', '/models?harness=<h>')` resolves a catalog whose `.harness === h` | `await loadCatalog(h)` | `ui.catalogs[h]` **is** the returned catalog |
| C2 | `ui.catalogs[h]` empty; response `.harness` is a **different id** (e.g. the daemon default) | `await loadCatalog(h)` | `ui.catalogs[h]` stays **undefined** (mismatch refused) |
| C3 | `ui.catalogs[h]` empty; response `.harness` is `null` (older daemon, default-catalog fallback) | `await loadCatalog(h)` | `ui.catalogs[h]` stays **undefined** |
| C4 | `ui.catalogs[h]` already populated | `await loadCatalog(h)` | **no** `request` call is made (short-circuit); the cached value is untouched |
| C5 | `request` **rejects** (throws) | `await loadCatalog(h)` | resolves without throwing; `ui.catalogs[h]` stays undefined |

The guard being verified is the single line `if (catalog.harness === harness) ui.catalogs[harness] = catalog;`
plus the leading `if (ui.catalogs[harness]) return;` short-circuit. These are the acceptance-criteria
"harness-mismatch guard".

### Request-URL invariant
`loadCatalog(h)` must call `request('GET', \`/models?harness=${encodeURIComponent(h)}\`)`. C4 asserts the
short-circuit by checking the mock `request` was **not** called; C1–C3/C5 by checking it **was** called
(optionally with that URL).

## 2. Test module contract — `dashboard/src/lib/store.test.ts` (new)

- Uses `vitest` (`describe/it/expect/vi/beforeEach`), matching the sibling tests' import style.
- Mocks the API layer, NOT `fetch`: `vi.mock('./api', () => ({ request: vi.fn(), AuthError: class extends Error {} }))`.
  `store.svelte.ts` imports `{ request, AuthError }` from `./api` — both named exports must be provided by
  the mock or the module fails to load. `request` is the `vi.fn()` the test drives per case.
- Imports `{ loadCatalog, ui }` from `./store.svelte.ts` and asserts synchronously on `ui.catalogs`
  after `await loadCatalog(...)` (plain `$state` reads need no `flushSync`/DOM).
- **Isolation:** module-global `ui.catalogs` leaks between cases. In `beforeEach`, reset it
  (`for (const k of Object.keys(ui.catalogs)) delete ui.catalogs[k];`) and `vi.mocked(request).mockReset()`.
  Mutate the existing object — do **not** reassign `ui.catalogs` (it is a `$state` field; keep the same reference).
- A `ModelCatalog` fixture shape: `{ harness: <id|null>, models: [], defaultModel: null }` (see
  `dashboard/src/lib/types.ts:66`). `models` may be empty; the guard only reads `.harness`.
- Drive each case by setting the mock's resolved value: `vi.mocked(request).mockResolvedValueOnce(catalog)`
  (C1–C3), `.mockRejectedValueOnce(new Error('x'))` (C5). C4 pre-seeds `ui.catalogs[h]` then asserts
  `expect(request).not.toHaveBeenCalled()`.

## 3. Test-harness wiring — `vitest.config.ts`

`store.svelte.ts` uses the `$state` rune, so it must be compiled by the Svelte plugin to run under vitest.
Register the plugin (already a devDependency: `@sveltejs/vite-plugin-svelte@^4`, `svelte@^5`):

```ts
import { svelte } from '@sveltejs/vite-plugin-svelte';
// ...
export default defineConfig({
  plugins: [svelte()],
  test: { exclude: [...configDefaults.exclude, '.agent-work/**', 'dashboard/dist/**'] },
});
```

Invariants this wiring must uphold:
- **No regression:** the transform only touches `.svelte`/`.svelte.ts`; existing plain-`.ts` backend and
  dashboard tests (`server.test.ts`, `model-picker.test.ts`, `render.test.ts`, `auth.test.ts`) must still
  pass unchanged. Verify with a full `npm test`.
- Default node test environment is sufficient — runes need no jsdom/testing-library. Do **not** add
  jsdom, `environment: 'jsdom'`, testing-library, or any e2e scaffolding (issue non-goal).
- If, and only if, registering the plugin breaks the existing suite, fall back to the plan's §3 fallback
  (extract a pure `catalogMatchesHarness(catalog, requested): boolean` predicate in a plain `.ts` module,
  have `loadCatalog` call it, and unit-test the predicate directly — no config change). Prefer the primary
  approach when the suite stays green.

## 4. Documentation contract — `README.md`

Two edits, both verifiable by string match against the acceptance criteria:

- **§9.8 caveat (~L920–922):** replace the bullet claiming "per-harness catalogs for off-default runs are
  deferred" / "appears only for a run whose harness matches the loaded catalog". The replacement must state
  that the run inspector loads the **run's own** harness catalog via `GET /models?harness=<run.harness>`
  (cached per harness in `ui.catalogs`), so an off-default run gets a working per-run picker of *its*
  harness's models; and note the graceful degradation — against an older daemon that ignores the query
  param, the harness-field mismatch guard refuses to cache the default catalog, so such a run shows **no**
  picker rather than wrong-harness models. It must no longer read as a deferral/"accepted caveat". Leave the
  other two caveat bullets (Cursor cost `n/a`, Cursor auth) untouched.
- **Roadmap (~L682):** delete the entire `Per-harness model catalogs for off-default runs — #13` line from
  the "not-yet-built planned work" list. Leave surrounding entries intact.

## Invariants / non-goals (enforced by acceptance criteria)

- **No `src/` runtime change.** The server path (`GET /models?harness=`, `Orchestrator.getModels`) and its
  test (`server.test.ts`) are already correct — do not touch them.
- **No `FileRunBar` / new-run bar change** (it intentionally follows the default harness).
- **No new API surface or behavior change.** Only docs + tests (+ minimal vitest wiring) change.
- `npm test` and `npm run check:dashboard` must pass; clean working tree (no build/coverage artifacts).

## Files the tdd/impl stages touch

- `README.md` — reword §9.8 caveat bullet; delete roadmap line. (no test)
- `dashboard/src/lib/store.test.ts` — **new**; asserts C1–C5.
- `vitest.config.ts` — register `svelte()` plugin (primary approach).
- *(fallback only)* pure predicate module + its use in `loadCatalog`.
