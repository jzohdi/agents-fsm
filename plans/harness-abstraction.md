# Multi-harness support (Claude Code + Cursor) — implementation plan

Status: in progress · Author: design spike · Supersedes nothing · Depends on: Milestone 8 (complete)

## Implementation status & revisions

Two things changed since the plan below was first written; read this first.

1. **A per-run *model* selection feature already landed** (commits "ability to select models" / "repository
   enrollment and selection improvements"): [`harness-models.ts`](../src/agent/harness-models.ts) defines a
   per-harness `HarnessCatalog` (`CLAUDE_CODE_CATALOG`, `harness: 'claude-code'`), a `runs.model_override`
   column, and `GET /models` + `setModel`. Harness selection layers *above* this: a run picks a harness,
   and that harness determines the model catalog. To stay consistent, the harness id is **`claude-code`**
   (matching the catalog's `harness` field), not `claude` as the draft below assumed.

2. **PR 1 (shipped on branch `harness-selection-foundation`) — per-run harness selection plumbing,
   Claude-Code-only, behavior-preserving.** It is a tighter slice than the draft "Phase 1": the
   `HarnessProfile` executor refactor and the settings/default-persistence were **deferred** (YAGNI — a
   profile with only one profile, and a persisted default with nothing yet able to change it, are
   speculative until the second harness exists). PR 1 delivers:
   - [`src/agent/harness.ts`](../src/agent/harness.ts): `HarnessId`, `HARNESS_IDS`, `DEFAULT_HARNESS`,
     `isHarnessId`, `HarnessResolver`, `HarnessRegistry` (strict — throws on an unregistered id),
     `singleHarness`, `isHarnessResolver`.
   - `runs.harness` column (migration 6, `NOT NULL DEFAULT 'claude-code'`, no CHECK — §6.1) + `Run.harness`
     (typed `string` in the store to avoid an upward store→agent dependency) + `CreateRunInput.harness`.
   - `AgentRunner` accepts `StageExecutor | HarnessResolver` and resolves the executor per-run *inside* its
     per-phase try, so an unregistered harness escalates that one run (`executor_error`), never the fleet.
   - Wiring: `real-run` registers the Claude Code executor under `claude-code`; mock/tests pass a bare
     executor (normalized via `singleHarness`).
   - Tests: `harness.test.ts`, a runner dispatch-by-harness test (+ unknown-harness escalation), a store
     round-trip + default test, and a migration-6 backfill test. Full suite stays green.

3. **PR 2 (stacked on `harness-selection-foundation`) — the Cursor harness executor.** The executor
   layer only; still behavior-preserving (Cursor is not yet registered or selectable). Delivers:
   - `HarnessProfile` seam in [`subprocess-executor.ts`](../src/agent/subprocess-executor.ts) + `CLAUDE_PROFILE`
     (a pure refactor — the generic engine of spawn/stream/timeout/retry/parse is unchanged; only argv,
     model map, error policy, and activity summaries move behind the profile). `SubprocessStageExecutor`
     takes an optional `profile` (default `CLAUDE_PROFILE`), so every existing call site is unchanged.
     `HarnessAuthError` now carries a per-harness remedy; `classifyFailure(profile, …)` centralizes the
     auth-fatal / rate-limit / generic split for both the exit-code and `is_error` paths.
   - [`cursor-profile.ts`](../src/agent/cursor-profile.ts): `CURSOR_PROFILE` — `cursor-agent -p …
     --output-format stream-json --force --model`, the system prompt folded into the prompt (no
     `--append-system-prompt`), no `--allowedTools`, Cursor auth matcher, `authFatal: false` (§8.1),
     provisional `summarize` reuse.
   - Tests: `cursor-profile.test.ts` (argv, model map, and the auth-is-recoverable-not-fatal §8.1 guard) +
     a Cursor participant in the shared `stageExecutorContract` proving the same parse path yields the
     contract's "structured result out" (Cursor's missing token usage → `tokens: 0`, which the contract
     allows). Full suite stays green.

4. **PR 3 (stacked on `harness-selection-foundation`) — register + select Cursor.** Cursor is now a
   registered, selectable harness; the behavior-preserving default stays `claude-code`. Delivers:
   - `cursor` added to `HarnessId`/`HARNESS_IDS`. The Cursor executor is registered in
     [`real-run.ts`](../src/real-run.ts) alongside Claude Code via the new exported `buildHarnessRegistry`
     — each harness gets its own `SubprocessStageExecutor`; the Claude-shaped daemon flags
     (`--permission-mode`, `--model`/`frontierModel`) ride only on the Claude executor (Cursor has no
     `--permission-mode`, and its models come from `CURSOR_MODEL_MAP`).
   - `CURSOR_CATALOG` + a `HARNESS_CATALOGS`/`catalogForHarness` resolver in
     [`harness-models.ts`](../src/agent/harness-models.ts). `Orchestrator` now takes `defaultHarness` +
     `catalogFor` (replacing the single fixed `modelCatalog`): `getModels` resolves the *default*
     harness's catalog, `setModel` the *run's*, so a per-run model override is validated against the
     harness that will actually run it.
   - `POST /runs` accepts an optional `harness` (absent/empty → default; present-but-unknown → 400 via
     `isHarnessId`), threaded `Orchestrator.start` → `loop.startRun` → `createRun`. Both run-creation
     entry points stamp the harness: the daemon (`buildOrchestrator`) and the one-shot CLI
     ([`cli.ts`](../src/cli.ts) `start()`).
   - Default-harness resolution + persistence (§5): `resolveDefaultHarness(args, repo)` (precedence
     `--harness`/`FLEET_HARNESS` > persisted setting > `claude-code`; fail-fast on an invalid flag,
     defensive read of a stale persisted value) + a tiny `settings` KV (migration 7 + `schema.sql` +
     `Repository.getSetting`/`setSetting`) for the persisted default. `Orchestrator` gets a
     `defaultHarness` option used by `start`; `--harness`/`FLEET_HARNESS` is a new CLI arg.
   - Tests: `CURSOR_CATALOG`/`catalogForHarness` + a map↔catalog drift guard; `buildHarnessRegistry`
     registration + Claude-flag withholding + per-harness model resolution; `resolveDefaultHarness`
     precedence (incl. stale/garbage persisted → default and invalid-flag throw); settings round-trip +
     migration-7 backfill; orchestrator harness passthrough/default/400 + per-run-catalog `setModel`
     validation; `POST /runs` harness passthrough/400; `--harness` parsing. Full suite stays green (545).

**Next PR (dashboard selector):** the only remaining piece is §7 — the dashboard's harness `<select>` +
persistence + run-card badge, and its backing HTTP settings routes (§6.5: `GET /settings` /
`PUT /settings/default-harness` writing `settings.default_harness`, the currently write-less persisted
default). The §8.1 fleet-abort finding and the strict-registry decision remain honored.

## 0. Goal & scope

Let a run be executed by a **selectable agent harness** — Claude Code (today) or Cursor's headless CLI
(`cursor-agent`) — behind the existing `StageExecutor` seam, so we inherit each harness's own tool-use
loop and context management and never hand-roll tool calling.

Requirements this plan satisfies (from the request):

1. Ship with **Claude as the default** harness.
2. **Select a different harness at runtime** (no restart).
3. **Remember the last-selected harness** and boot with it next time.
4. **Per-issue harness selection** (defaulting to the current default), chosen from a small, out-of-the-way
   control before starting a run. **Per-stage** selection is designed-for but **deferred** (YAGNI).
5. Account for workflow consequences without over-engineering (§8).

Non-goals (deferred, see §9): per-stage harness override, Cursor cost/token accounting, per-tool
allow-list enforcement under Cursor, additional harnesses beyond these two.

## 1. Why this is a small change — the existing seam

The single boundary between the orchestrator and any harness is
[`StageExecutor.run(req) → { output, usage }`](../src/agent/executor.ts) (Layer 5). Its own doc comment
states the intent: *"we do NOT hand-roll a tool-use loop here … swapping harnesses never touches the
engine, loop, runner, or store."* The Claude implementation
[`SubprocessStageExecutor`](../src/agent/subprocess-executor.ts) is thin: build argv → spawn
`claude -p --output-format stream-json …` → scan newline-delimited JSON for the terminal `type:"result"`
event.

Cursor's headless CLI maps onto the same shape. Proven by the archived spike
([`archive/harness-cursor-spike/`](../archive/harness-cursor-spike/)):

- Cursor supports `-p/--print`, `--output-format stream-json`, and `--model` (Cursor docs:
  [headless](https://cursor.com/docs/cli/headless), [output-format](https://cursor.com/docs/cli/reference/output-format),
  [parameters](https://cursor.com/docs/cli/reference/parameters)).
- Cursor's terminal event is `{ "type":"result", "subtype":"success", "is_error":…, "result":"<text>" }` —
  the **same family** Claude Code emits. `cursor-result-parsing.test.ts` feeds that exact shape to the
  **existing** `parseHarnessOutput` and it returns the correct envelope unchanged → **the parser is reusable**.
- The same spike proves the two documented **gaps**: Cursor's result carries no `usage`/`total_cost_usd`
  (token/cost accounting comes back `0`/`undefined`), and there is no per-tool `--allowedTools` analog.

The one structural change everything else hangs off: **today the runner holds one executor, fixed at
daemon boot** ([`AgentRunner` ctor](../src/agent/runner.ts), built once in
[`real-run.ts`](../src/real-run.ts)). Per-issue selection requires resolving the executor **per run**.
We do this by mirroring the codebase's own `RepoResolver` pattern (per-run GitHub adapter resolution,
Milestone 8), which the runner already normalizes via `github: GitHub | RepoResolver`.

## 2. Architecture overview

```
POST /runs { issueRef, harness? }
        │  harness ?? current default (persisted)                 ┌─ 'claude' → SubprocessStageExecutor (Claude profile)
        ▼                                                         │
  Orchestrator.start ──▶ loop.startRun ──▶ runs.harness (column)  │
        │                                                         │
        ▼   run.harness                                           │
  AgentRunner.invokePhase ──▶ HarnessRegistry.for(run.harness) ───┼─ 'cursor' → SubprocessStageExecutor (Cursor profile)
                                                                  │
                                                                  └─ (mock mode) every id → StubExecutor

Default harness: --harness flag (session)  >  settings.default_harness (persisted)  >  'claude'
Dashboard dropdown reads & writes settings.default_harness; each run is stamped with the value at click time.
```

Key idea: a run's harness is **pinned at start** (a new `runs.harness` column), exactly like
`fsm_config_version` is pinned — so a run uses one harness for its whole life, including across
crash/resume, with no ambiguity. Per-stage override (deferred) later layers on top without moving this.

## 3. New building blocks

### 3.1 `HarnessId` + `HarnessRegistry` — `src/agent/harness.ts` (new)

```ts
export type HarnessId = 'claude' | 'cursor';
export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'cursor'];
export const DEFAULT_HARNESS: HarnessId = 'claude';
export function isHarnessId(v: unknown): v is HarnessId { … }

/** Resolve the executor for a harness id (mirrors RepoResolver). */
export interface HarnessResolver { for(id: string): StageExecutor; }

/**
 * A registry over a fixed set of pre-built executors. An unknown/unregistered id **throws** a clear
 * error — it must never silently fall back to another harness (a run stamped `cursor` running on `claude`
 * would mismatch its badge and could change results). The runner resolves inside its existing try/catch
 * (§6.2), so a miss escalates that one run to `needs_human` (`executor_error`), never crashing the fleet.
 */
export class HarnessRegistry implements HarnessResolver { … }

/** Wrap one executor as a resolver that always returns it (mirrors singleRepoResolver). */
export function singleHarness(executor: StageExecutor): HarnessResolver { … }
```

Rationale for `singleHarness`: it lets `AgentRunner` accept `StageExecutor | HarnessResolver` and normalize
(the exact idiom already used for `github: GitHub | RepoResolver`), so the ~dozen tests that construct
`AgentRunner` with a bare `StubExecutor` need **zero changes**.

### 3.2 Harness "profile" — parameterize the subprocess executor

`SubprocessStageExecutor` already contains all the harness-neutral machinery: spawn, cross-chunk line
streaming, timeout kill, rate-limit retry+backoff, and the result parse. Extract the harness-specific
bits into a small profile and keep one generic executor:

```ts
export interface HarnessProfile {
  command: string;                              // 'claude' | 'cursor-agent'
  buildArgs(req: AgentRunRequest, model: string): string[]; // owns prompt composition (system + input)
  modelMap: Record<string, string>;             // logical (frontier/cheap) → concrete; MUST be complete (§4)
  isAuthFailure(text: string): boolean;
  authRemedy: string;                           // fatal → printed banner; non-fatal → escalation reason
  authFatal: boolean;                           // Claude: true (fleet-abort). Cursor: false (per-run escalate) — §8.1
  isRateLimit(text: string): boolean;
  summarize(event: unknown): AgentActivity[];   // stream-json event → live-activity summaries
}
```

- `CLAUDE_PROFILE` = today's exact behavior (argv with `--append-system-prompt`, `--allowedTools`,
  `--verbose`; `DEFAULT_MODEL_MAP` opus/haiku; existing `summarizeEvent`, auth/rate-limit regexes;
  `authFatal: true`, preserving the existing `HarnessAuthError`/`FatalExecutorError` behavior). This is a
  pure refactor — the existing `subprocess-executor.test.ts` and the contract suite must stay green.
- `CURSOR_PROFILE` = §4 (`authFatal: false`).

Keep `parseHarnessOutput` shared (the spike proves it works for both). `buildArgs`/`summarize`/matchers
move behind the profile. Note: the currently module-private `userPrompt` helper is needed by
`buildArgs`, so export it (or pass it in) rather than duplicating the "input → prompt text" rule.

To keep the Phase 1 refactor churn-free, `SubprocessStageExecutor`'s constructor takes an **optional
`profile` defaulting to `CLAUDE_PROFILE`** — so `real-run.ts` and the existing tests/contract participants
construct it unchanged, and only the Cursor executor passes `{ profile: CURSOR_PROFILE }`.

## 4. The Cursor profile (§3.2)

`buildArgs(req, model)` →
```
['-p', <prompt>, '--output-format', 'stream-json', '--force', '--model', model, ...extraArgs]
```
with these harness-specific adaptations, each traceable to a gap the spike/docs identified:

- **System prompt (gap #1 — required).** Cursor has no `--append-system-prompt`. Compose the prompt as
  `req.system + "\n\n" + userPrompt(req.input)` (a single combined prompt string). This keeps the recipe's
  per-phase system prompts working. (Alternative considered: writing `.cursor/rules` files into the working
  tree per stage — more moving parts, deferred; the combined-prompt approach is sufficient and simplest.)
- **Tool scoping (gap #2 — accepted).** No `--allowedTools`. Drop it; `-p` grants write/shell and `--force`
  auto-approves so a headless run can't stall on a prompt. Review stages lose flag-level read-only
  enforcement under Cursor — noted in §8, not blocking.
- **Models.** `modelMap` = `{ frontier: <cursor frontier model>, cheap: <cursor cheap model> }`, overridable
  via config/env (do not hard-code beyond a sensible default; confirm names with `cursor-agent --list-models`).
  The Cursor `modelMap` **must** map every logical name the recipe uses; an unmapped logical name passes
  through verbatim (`resolveModel`), so Cursor would get `--model frontier` and fail. **Portability caveat:**
  the recipe stays harness-portable only while `agents[stage].models` uses *logical* names — the shipped
  [`default-config.json`](../src/fsm/default-config.json) sets no per-phase models, so it uses the logical
  `DEFAULT_MODELS` (portable). A config that hard-codes a *concrete* Claude model (e.g. `sonnet`) is
  Claude-specific and will fail under Cursor; that's the operator's responsibility and out of scope here.
- **Auth — must NOT be fatal (see §8.1).** `isAuthFailure` matches Cursor's "not logged in / unauthorized"
  wording. Critically, a Cursor auth failure is classified as a **recoverable** `HarnessError` that
  **escalates the affected run to `needs_human`** (via the loop's `executor_error` path) — it does **not**
  throw a `FatalExecutorError`. `FatalExecutorError` aborts the *entire* drain
  ([`event-loop.ts` applyEvent](../src/loop/event-loop.ts): *"which every run would hit … propagate it so
  the drain aborts"*), which in a mixed fleet would wedge Claude runs behind a Cursor auth problem. The
  operator-facing remedy (`cursor-agent login` / `export CURSOR_API_KEY=…`) travels in the escalation
  `reason` instead of a printed banner, so only the Cursor runs park while Claude keeps flowing.
- **Rate limit.** Reuse the generic `isRateLimit` (429/529/"rate limit"/"overloaded") unless the live probe
  shows Cursor-specific wording; the retry/backoff machinery is unchanged.
- **`summarize`.** Cursor emits distinct tool-call start/completion events rather than Claude's content
  blocks. Provide a Cursor mapping so the live "what's the agent doing now" feed isn't blank. Observability
  only — if imperfect at first it degrades gracefully (unknown events → no activity), never affecting results.

Verify real shapes with `archive/harness-cursor-spike/cursor-live-probe.test.ts` on a machine with the
Cursor CLI installed before finalizing `summarize` and the auth/rate-limit matchers.

## 5. Persistence & default resolution (reqs 1–3)

### 5.1 A tiny settings KV store (new)

There is no key-value/settings store today. Add the smallest possible one:

- **Migration 5** + `schema.sql`: `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
- `Repository.getSetting(key): string | undefined` / `setSetting(key, value): void` (`INSERT … ON CONFLICT
  DO UPDATE`). One row: `default_harness`.

### 5.2 Effective default (precedence)

`--harness <id>` CLI flag / `FLEET_HARNESS` env (session override)  >  persisted `settings.default_harness`
>  `DEFAULT_HARNESS` (`'claude'`).

- First-ever boot has no setting → `'claude'` (req 1).
- The dashboard's harness control writes `settings.default_harness` (req 3); next boot reads it.
- The CLI flag overrides for that session **without** clobbering the persisted user choice (so a one-off
  `--harness cursor` boot doesn't silently change the remembered default).
- **Read defensively**: validate the persisted value with `isHarnessId` on read and fall back to
  `'claude'` if it's absent, empty, or a stale/removed id — a bad settings row must never wedge boot.
- **Fail fast on a bad flag**: an invalid `--harness`/`FLEET_HARNESS` value should error at startup (a
  typo is operator error), rather than silently falling through to the persisted/default value — this is
  the one place we prefer a loud failure over a silent fallback (it's a boot-time config, not run data).

This effective default is what auto-pickup (future) will use for repo-sourced issues, and what the
dashboard dropdown pre-fills.

## 6. Store & wiring changes

### 6.1 Store

- **Migration 5**: `settings` table (above).
- **Migration 6**: `ALTER TABLE runs ADD COLUMN harness TEXT NOT NULL DEFAULT 'claude'`. SQLite allows
  ADD COLUMN with a constant default; existing rows backfill to `'claude'`. **Do not add a `CHECK
  (harness IN …)` constraint** — SQLite can't `ALTER` one in, so adding it to `schema.sql`'s `CREATE
  TABLE` would make a fresh DB diverge from a migrated one (the repo's migrations invariant is fresh ==
  migrated). Validate harness ids in the app layer via `isHarnessId` instead. The `schema.sql` `runs`
  definition gains the same `harness TEXT NOT NULL DEFAULT 'claude'` column (no CHECK), matching migration 6.
- `Run` type gains `harness: HarnessId`; `mapRun` reads the column; `CreateRunInput` gains `harness`.
- Keep the migration invariant (gap-free 1..N) and update `LATEST_VERSION` accordingly.

### 6.2 Runner

- `AgentRunner` ctor: accept `harnesses: StageExecutor | HarnessResolver` (normalize with `singleHarness`,
  mirroring the `github` param). Replace the single `this.executor` field.
- `invokePhase`: resolve `const executor = this.harnesses.for(run.harness)` **inside the existing
  try/catch** that wraps `executor.run(...)`, so an unknown/unregistered harness is recorded as a failed
  `agent_run` and rethrown → the loop escalates `executor_error` (never a raw crash of the drain).
  Everything else (telemetry, usage, activity) is unchanged. `run` is already in scope here.

### 6.3 Build wiring — `build-runner.ts` / `real-run.ts`

- Build **both** executors at boot (cheap & side-effect-free per the `real-run.ts` note) and register them:
  `new HarnessRegistry({ claude: claudeExec, cursor: cursorExec })`. Pass the registry to `AgentRunner`.
- **Mock mode**: register the same `StubExecutor` under every id, so selecting "cursor" in mock still
  exercises the full selection path with no tokens/network (dashboard dev + tests).
- Add one shared helper `resolveDefaultHarness(args, repo): HarnessId` (precedence §5.2: flag/env >
  persisted setting > `'claude'`), used by **both** entry points so the default can't drift between them.

### 6.4 Orchestrator / event-loop

- `Orchestrator.start({ issueRef, repoRef?, harness? })`: validate `harness` with `isHarnessId` (400 on a
  bad value); fall back to the effective default; pass to `loop.startRun`.
- `EventLoop.startRun` + `Repository.createRun`: thread `harness` into the new column.
- **Both** run-creation paths must stamp the harness — not just `Orchestrator.start`. The one-shot CLI
  ([`cli.ts` `start()`](../src/cli.ts) → `loop.startRun(...)`) bypasses the orchestrator, so it must resolve
  `resolveDefaultHarness(args, repo)` (honoring `--harness`) and pass it explicitly. Missing this would
  silently stamp one-shot runs with the column default and ignore `--harness`.
- Everything downstream (recover, resume, revert) already reloads the run row, so the pinned harness
  survives restarts automatically.

### 6.5 API — `server.ts`

- `POST /runs`: read optional `harness` (`optStr`). Absent or empty → use the effective default (not a
  400); a **present but unknown** id → 400 via `isHarnessId`. Pass the resolved id through to `start`.
- Settings routes: `GET /settings` (or `GET /settings/default-harness`) → `{ defaultHarness, harnesses: HARNESS_IDS }`;
  `PUT /settings/default-harness { harness }` → persists via `setSetting` (400 on bad id). Also expose the
  available harness ids so the dashboard never hard-codes them.

## 7. Dashboard (req 4)

- **`types.ts`**: `Run.harness`; a `HarnessId` type; extend the config/settings fetch types.
- **`store.svelte.ts`**: `ui.defaultHarness` + `ui.harnesses`; `loadSettings()` (GET) on boot;
  `setDefaultHarness(id)` (PUT, optimistic); `startRun(issueRef, harness)` sends the chosen harness.
- **`FileRunBar.svelte`**: a small `<select>` beside "Start run", bound to `ui.defaultHarness`. Changing it
  calls `setDefaultHarness` (persists → remembered) and is the value sent on submit. This single control
  satisfies reqs 2–4 at once: it's the runtime selector, it's remembered, and it's the per-run value.
  Keep it visually minimal (a compact dropdown, default label e.g. "Harness: Claude").
- **Run card**: show a small harness badge when it isn't the default (cheap, and genuinely useful once runs
  can differ). Optional but recommended.

> **Decision to confirm (one real product choice):** the recommended model makes the dropdown selection
> *both* the per-run choice *and* the persisted default — i.e. picking Cursor for a manual run also makes
> Cursor the default that future auto-pickup would use. This matches "remember my last selected." If you'd
> rather a one-off manual pick **not** move the fleet default (default only changes via an explicit
> control), that's a small variant: keep the dropdown transient and add a separate "set as default" action.
> Recommend shipping the simple unified model now and revisiting when auto-pickup lands (YAGNI).

## 8. Workflow consequences (req 5) — flagged, mostly accepted

### 8.1 `FatalExecutorError` is fleet-wide — harness auth must not use it (foundational)

Today [`event-loop.ts`](../src/loop/event-loop.ts) re-throws a `FatalExecutorError` to abort the **whole**
drain (comment: *"which every run would hit"*), because with one shared harness an auth failure did affect
every run. That assumption breaks with per-run harnesses: a Cursor auth failure must **not** stop Claude
runs. So the Cursor profile classifies auth/unavailability as a **recoverable** `HarnessError` →
per-run `needs_human` escalation (§4), never `FatalExecutorError`.

**Known asymmetry (consciously deferred):** the existing Claude path keeps `authFatal: true`, so in a
*mixed* fleet a **Claude** auth failure still aborts the drain — including Cursor runs. Fully fixing this
means redefining `FatalExecutorError` as "affects all harnesses" and making Claude auth a per-run
escalation too, which changes existing Claude behavior + tests. That is out of scope for this milestone;
this plan deliberately avoids *adding a second* fleet-abort trigger and flags the Claude side as a
follow-up so future PRs build on a known boundary rather than discovering it. Recommendation: revisit when
a mixed fleet is actually run in anger.

- **A missing/unauthed harness binary escalates, it does not crash.** If `cursor-agent` isn't installed,
  `spawn` errors → the executor rejects → the runner records a failed `agent_run` and rethrows → the loop
  escalates that run `executor_error` (`needs_human`). Good default; a friendlier "cursor-agent not
  installed" remedy is a nice-to-have, not required.

### 8.2 Other consequences

- **Cost/token accounting is blind under Cursor** (proven by the spike). The run-budget guard
  (`budget.maxTokens`) and the **M8 B3 global cost ceiling** read `usage.tokens`/`usage.cost`, which come
  back `0`/`undefined` for Cursor. Consequence: those guards effectively no-op for Cursor runs. **Accept &
  document** for now; a rough estimator (from Cursor's `duration_*`/text length) or a per-harness flat
  budget is a clean follow-up (§9). Do **not** let a Cursor run silently look "free" in the dashboard —
  show "cost n/a" rather than "$0.00" for Cursor runs.
- **Review-stage tool scoping weakens under Cursor** (no `--allowedTools`). Read-only review stages rely on
  the prompt instead of a flag. Acceptable; revisit with Cursor deny-rules if it matters in practice.
- **Determinism across resume**: harness pinned per run (like `fsm_config_version`) → a crash/resume uses
  the same harness. Good; no special handling.
- **Live activity feed**: needs the Cursor `summarize` mapping (§4) or it's sparse for Cursor. Observability
  only.
- **Auth is per-harness**: a Cursor run with no `CURSOR_API_KEY`/login escalates *that run* to
  `needs_human` with its own remedy in the reason (§8.1) — it does not affect Claude runs. Preflight only
  the harnesses actually in use.

## 9. Deferred (YAGNI) — designed-for, not built

- **Per-stage harness override.** Extension point: add optional `harness` to `StageAgentConfig` (Layer 4
  recipe, [`config.ts`](../src/fsm/config.ts)); the runner picks `recipe.harness ?? run.harness ?? default`.
  Nothing in this plan precludes it; not built now (explicitly not needed yet).
- **Cursor cost estimation** (§8).
- **Cursor `.cursor/rules` system-prompt path** (§4 alternative), if combined-prompt proves insufficient.
- **More harnesses**: the registry + profile design makes a third harness a new `HarnessProfile` + id.

## 10. Phasing & test strategy

Each phase is independently shippable and behavior-preserving until Cursor is registered.

- **Phase 0 — Spike (done).** `archive/harness-cursor-spike/` proves parser reuse + the cost gap; the live
  probe captures real shapes when `cursor-agent` is present. Keep as archive.
- **Phase 1 — Harness abstraction core.** `harness.ts` (registry + `singleHarness`); refactor
  `SubprocessStageExecutor` behind `HarnessProfile` with `CLAUDE_PROFILE`; `AgentRunner` accepts a resolver;
  `runs.harness` column + settings KV + migrations. **Register only `'claude'`.** *Tests:*
  - existing suite stays green (proves the refactor is behavior-preserving);
  - **runner dispatch-by-harness (the crux):** a registry of two spy executors + two runs with different
    `harness`; assert each run's stage dispatches to the executor its column names, and that an
    unregistered id escalates `executor_error` rather than throwing/crashing the drain;
  - `HarnessRegistry.for` (hit + unknown-id throw) and `singleHarness` back-compat;
  - `resolveDefaultHarness` precedence (flag/env > persisted setting > `'claude'`, incl. a stale/garbage
    persisted value falling back to `'claude'`);
  - `Repository` settings round-trip (`getSetting`/`setSetting` upsert) + `createRun`/`mapRun` round-trip
    of the `harness` column;
  - **migration 6 backfill:** seed a DB at the pre-migration schema with a run row, run migrations, assert
    the row reads `harness === 'claude'` and the column + `settings` table exist (extend the migrations test).
- **Phase 2 — Cursor executor.** `CURSOR_PROFILE`; register `'cursor'`. *Tests:*
  - run the **existing `stageExecutorContract`** ([executor-contract.ts](../src/agent/executor-contract.ts))
    against the Cursor profile with a fake spawn emitting Cursor-shaped stream-json (the same shapes the
    spike pins) — the core guard that the Cursor executor honors the "structured result out" contract;
  - **Cursor auth → per-run escalation, NOT fatal (regression guard for §8.1):** a fake spawn returning
    Cursor's unauthorized output makes `run()` throw a *recoverable* `HarnessError` (not a
    `FatalExecutorError`), and an event-loop test asserts it escalates `executor_error` (`needs_human`)
    while a sibling Claude run is untouched;
  - Cursor `buildArgs` (combined system+input prompt, `--force`, model mapping, no `--allowedTools`), auth
    matcher, and `summarize` unit tests.
- **Phase 3 — API + default persistence.** `POST /runs` harness param; settings routes; orchestrator
  default resolution + validation. *Tests:* `server.test.ts`/`orchestrator.test.ts` cases for harness
  passthrough, bad-id 400, default fallback, and persisted-default round-trip.
- **Phase 4 — Dashboard.** Dropdown + persistence + badge. *Tests:* extend `render.test.ts` view-model
  coverage where applicable; manual preview check of the file-run bar.
- **Phase 5 — Deferred items (§9)** as separately prioritized follow-ups.

## 11. File-change checklist

| Area | Files |
| --- | --- |
| New | `src/agent/harness.ts`, `archive/harness-cursor-spike/*` (done) |
| Executor | `src/agent/subprocess-executor.ts` (profiles), `src/agent/executor.ts` (only if a type is shared) |
| Runner | `src/agent/runner.ts` (resolver + per-run `for()`) |
| Wiring | `src/build-runner.ts` (registry + `resolveDefaultHarness`), `src/real-run.ts`, `src/cli-args.ts` (`--harness`/`FLEET_HARNESS`), `src/cli.ts` (one-shot stamps `loop.startRun`) |
| Store | `src/store/schema.sql`, `src/store/migrations.ts`, `src/store/repository.ts` (`harness`, settings) |
| Loop/API | `src/loop/event-loop.ts`, `src/api/orchestrator.ts`, `src/api/server.ts` |
| Dashboard | `dashboard/src/lib/types.ts`, `store.svelte.ts`, `FileRunBar.svelte`, run card |
| Docs | README §3.3 (Layer 5 harnesses), operating guide |

## 12. Risks

- **Cursor CLI drift** (flags/JSON shapes change). Mitigation: the live-probe archive + the contract suite
  catch shape changes; the profile localizes anything harness-specific.
- **`--append-system-prompt` gap** makes Cursor's per-stage prompting slightly less isolated than Claude's.
  Mitigation: combined-prompt now, `.cursor/rules` fallback available (§9).
- **Refactor regressions** in Phase 1. Mitigation: it's behavior-preserving with `'claude'` only; the whole
  existing suite (incl. the contract suite) is the guard before Cursor is added.
