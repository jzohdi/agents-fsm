# Plan — Per-stage harness override (agents-fsm#12)

## Goal

A run is currently pinned to one harness (`runs.harness`) for its whole life; the runner resolves
the executor **per run** (`AgentRunner.invokePhase` → `this.harnesses.for(run.harness)`). This issue
builds the designed-for extension point from `plans/harness-abstraction.md` §9: let a **stage recipe**
(Layer 4, `src/fsm/config.ts` `StageAgentConfig`) name its own `harness`, so the runner resolves the
executor **per stage** as `recipe.harness ?? run.harness ?? DEFAULT_HARNESS` — e.g. Claude Code for
`plan`, Cursor for `backend`. Behavior-preserving when no recipe sets `harness`.

This is **config-file plumbing on top of the existing registry/profile design** — no new executors,
no UI (both are explicit non-goals).

## How the code works today (grounding)

- `StageAgentConfig` (`src/fsm/config.ts:202`) is the Layer 4 per-stage recipe: `phases`, `models`,
  `reviewCap`, `allowedTools`, `io`. Validated by `stageAgentSchema` (`:245`, `.strict()`), read by
  `recipeFor(stage, agents)` (`:281`) which returns the effective recipe with per-field defaults.
- `Recipe = ReturnType<typeof recipeFor>` (`src/agent/runner.ts:1225`) — so **adding a field to
  `recipeFor`'s return automatically widens `Recipe`**; no separate type to touch.
- The runner already accepts `StageExecutor | HarnessResolver` and normalizes a bare executor via
  `singleHarness` (`runner.ts:325`). It resolves the executor **inside the per-phase `try`** in
  `invokePhase` (`runner.ts:1079`): `const executor = this.harnesses.for(run.harness)`. A miss throws;
  the surrounding `catch` records a failed `agent_run` and rethrows, so the loop escalates that one run
  as `executor_error → needs_human` (never crashes the drain). This is the exact PR 1 per-run behavior
  the issue says to match.
- `HarnessRegistry.for` (`src/agent/harness.ts:66`) is **strict** — an unregistered id throws with a
  clear message; it must never silently fall back to another harness. `isHarnessId` (`:44`) narrows an
  untrusted value to a known `HarnessId` (`'claude-code' | 'cursor'`), backed by `HARNESS_IDS`.
  `DEFAULT_HARNESS = 'claude-code'` (`:25`).
- `harness.ts` has **only type-only imports** (`import type { StageExecutor } from './executor'`), and
  `runner.ts` (agent) already imports `fsm/config`. So a `fsm/config → agent/harness` **value** import
  of `isHarnessId` introduces **no import cycle** (graph: runner → config → harness → executor →
  store, no path back to config).

## Approach

Two small, layered changes plus tests. The per-stage `harness` keys off **FSM stage names** (the
recipe is keyed by stage), so it applies to every real stage the phase pipeline runs (`triage`,
`plan`, `frontend`, `backend`, `tdd`, review stages) and — by construction — **not** to the pseudo-
stages (`chat`, `advise`, `resolve_conflicts`), which are not FSM states, have no recipe, and rightly
keep running on `run.harness`. `validateAgents` (`config.ts:302`) already rejects an `agents` key that
isn't a real non-terminal state, so no one can configure a pseudo-stage recipe.

### 1. `src/fsm/config.ts` — add the recipe field + validation

- Add `harness?: string` to the `StageAgentConfig` interface, documented alongside the existing
  per-stage fields (its comment: an optional per-stage harness override; absent → the run's harness,
  then the shipped default; must be a valid `HarnessId`, e.g. `claude-code` — **not** `claude`).
- In `stageAgentSchema`, add `harness: z.string().refine(isHarnessId, { message: '…' }).optional()`,
  importing `isHarnessId` from `../agent/harness`. This is the **static** guard the issue asks for:
  "validate the configured id against … `HarnessId` in `src/agent/harness.ts`" — a config typo like
  `claude` fails at load with a clear message (consistent with how `POST /runs` validates a per-run
  harness via `isHarnessId`), rather than silently escalating every run that hits the stage.
- In `recipeFor`, add `harness: c?.harness` to the returned object and to its inline return type. Left
  `undefined` when unset, so the runner's `?? run.harness ?? DEFAULT_HARNESS` fallback drives
  precedence (behavior-preserving).

Layering note: `fsm/config` importing a pure predicate from `agent/harness` mirrors `agent/runner`
already importing `recipeFor` from `fsm/config`, and creates no cycle (harness.ts has no value
imports). This is a deliberate, narrower coupling than the store→agent boundary the store avoids
(the store keeps `harness: string` unvalidated); a Layer 4 recipe naming a Layer 5 harness id is the
same coupling the runner already has.

### 2. `src/agent/runner.ts` — resolve per stage

- Import `DEFAULT_HARNESS` from `./harness` (already imports `singleHarness`, `isHarnessResolver`,
  `HarnessResolver` from there).
- In `invokePhase`, change the resolution line (`runner.ts:1079`) from
  `this.harnesses.for(run.harness)` to
  `this.harnesses.for(recipe.harness ?? run.harness ?? DEFAULT_HARNESS)`.
  `recipe` is already a parameter; the resolution stays **inside the existing `try`**, so an
  unregistered/unknown per-stage id is caught by the same `catch` → `executor_error` escalation as a
  per-run miss. Update the adjacent comment to note the per-stage precedence.
- **Do not** touch `runChat`, `runAdvisor`, or `invokeConflictResolver` — those pseudo-stage
  invocations have no recipe and correctly continue resolving `run.harness`.

### 3. Precedence, restated

`recipe.harness` (per-stage) > `run.harness` (per-run, pinned at start) > `DEFAULT_HARNESS`
(`claude-code`). Since `runs.harness` is `NOT NULL DEFAULT 'claude-code'`, `run.harness` is always
present in practice; the `?? DEFAULT_HARNESS` is a defensive tail matching the issue's exact
expression and the deferred-design note.

## Files to change

- `src/fsm/config.ts` — `StageAgentConfig` field, `stageAgentSchema` validation, `recipeFor` return
  (+ its inline return type), `isHarnessId` import.
- `src/agent/runner.ts` — `DEFAULT_HARNESS` import; per-stage resolution in `invokePhase` (one line +
  comment).
- `src/fsm/config.test.ts` — schema/recipe coverage (below).
- `src/agent/runner.test.ts` — per-stage dispatch + fallback + unknown-id escalation (below).

No migration, no store change (the field lives only in the config file / recipe), no API/dashboard
change, no default-config.json change (no stage sets `harness` by default → shipped behavior
unchanged).

## Risks & edge cases

- **Import cycle** — ruled out above (harness.ts has no value imports; no path back to config). The
  implementation must still confirm `npm run build`/typecheck is clean.
- **Precedence correctness** — `recipe.harness ?? …` must use nullish coalescing (not `||`) so an
  empty string can't slip through; the schema forbids empty/invalid anyway via `isHarnessId`.
- **Unregistered valid id vs. invalid id** — two distinct guards, both preserved:
  - *Invalid id* (not a `HarnessId`, e.g. `claude`) → rejected at **config load** by `isHarnessId`
    (never reaches a run).
  - *Valid but unregistered id* (e.g. `cursor` in a daemon/test that only wired `claude-code`) →
    passes config, then the strict `HarnessRegistry.for` throws at **runtime** inside the per-phase
    `try` → `executor_error` escalates that one run. This is the "unknown-id escalation" acceptance
    criterion; it exercises via a test registry that registers a subset.
- **Pseudo-stages** — confirmed out of scope by construction (`validateAgents` blocks non-state keys;
  chat/advise/resolve keep `run.harness`). No behavior change there.
- **Existing per-run dispatch tests** (`runner.test.ts:667`) construct `AgentsConfig`/registry
  literals directly (keys like `other`, `ghost`) — they bypass `parseAgentsConfig`, so static config
  validation doesn't affect them.

## Testing

- **`config.test.ts`**
  - `parseAgentsConfig` accepts a stage with a valid `harness: 'cursor'` and `recipeFor` surfaces it;
    a stage without `harness` yields `harness: undefined`.
  - `parseAgentsConfig` **rejects** an invalid `harness` (e.g. `'claude'`) with a `ConfigValidationError`
    (the isHarnessId static guard).
- **`runner.test.ts`** (mirroring the existing per-run dispatch block at `:667`)
  - **Per-stage override selects a different executor than the run default:** a two-executor
    `HarnessRegistry` (`claude-code`, `cursor` spies), a run with default harness, and
    `agents: { plan: { harness: 'cursor' } }`; assert the `plan` stage hits the `cursor` spy, and a
    stage with no recipe `harness` (or a different run) hits the run's default.
  - **Fallback precedence:** with no recipe `harness`, the stage dispatches to `run.harness`; assert
    the recipe override wins when both are set.
  - **Unknown-id escalation:** `agents: { plan: { harness: 'cursor' } }` against a registry that only
    registers `claude-code` → `runStage` rejects with `no executor registered for harness "cursor"`,
    a failed `agent_run` is recorded, and the loop's `executor_error` path parks that one run (same
    assertion shape as the existing `ghost` per-run test at `:695`).
- **Full suite** stays green (`npm test`); typecheck/build clean.

## Scope flags

Backend-only: `src/fsm/config.ts`, `src/agent/runner.ts`, and their tests. No frontend/UI (explicit
non-goal). → `needs_backend: true`, `needs_frontend: false`.
