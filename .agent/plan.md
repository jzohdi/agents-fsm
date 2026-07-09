# Plan — Configure custom agent/stage/issue context prompts from the UI (jzohdi/agents-fsm#5)

## Goal (restated)

Let the operator inject reusable prompt context into agents from the dashboard so recurring
instructions don't have to be retyped into every issue. Context composes in three layers, broadest
to narrowest:

1. **Global base** — one prompt applied to *every* agent on *every* stage.
2. **Per-stage-type** — a prompt applied to every run of a given stage type (`plan`, `tdd`,
   `frontend`, `backend`, `code_review`, `plan_review`, `interface_design`, `triage`).
3. **Per-issue/per-run** — a prompt attached to a single run, extending the broader layers for that
   run only.

Effective context = `global` + `stage` + `issue`, concatenated in that order; empty layers
contribute nothing. Per-issue is **extend (append)**; override mode is out of scope. The custom
context must reach the agent at the documented injection point, clearly delimited/labeled as
operator-provided, and persist across daemon restarts.

## How the code works today (grounding)

- **Prompt composition** — `src/agent/prompts.ts` `createSystemPromptFn(options)` reads the
  versioned markdown files once and returns `SystemPromptFn = (stage, phase) => string`
  (`src/agent/runner.ts:172`). Composition is `base + stage role + (phase instructions) + output
  contract`, joined by `SECTION_SEPARATOR` (`'\n\n---\n\n'`). **The output contract is deliberately
  LAST** — it is the load-bearing "your final message must be exactly this JSON" instruction. Prompts
  are code, not config, and are intentionally excluded from the FSM config hash.
- **Invocation** — `AgentRunner.invokePhase()` (`src/agent/runner.ts:1048`) builds the `input`
  object and calls `executor.run({ system: this.systemPrompt(run.currentState, phase), input, ... })`
  at `runner.ts:1087`. The runner has `this.repo` (Repository) and the `run` snapshot in scope here.
  The pseudo-stages call `this.systemPrompt(...)` the same way: `runChat` (`~768`), `advise`
  (`~866`), `resolveConflicts` (`~935`). `SystemPromptFn` is injected via
  `AgentRunnerOptions.systemPrompt` (real wiring: `src/real-run.ts:133`).
- **Stage type** = `run.currentState` (a plain string). Canonical stages are the `stages/*.md` role
  files: `triage`, `plan`, `plan_review`, `interface_design`, `tdd`, `frontend`, `backend`,
  `code_review`. Pseudo-stages: `chat`, `advise`, `resolve_conflicts`.
- **Settings store** — `settings(key TEXT PK, value TEXT)` KV table (`schema.sql:219`). Accessors:
  `Repository.getSetting(key)` / `setSetting(key, value|null)` (`repository.ts:571-587`; `null`
  clears). Existing keys live in `src/agent/harness.ts` (`DEFAULT_HARNESS_SETTING_KEY`, etc.).
- **Runs table** — per-run overrides are additive nullable columns (`model_override`,
  `effort_override`) with `setRunModelOverride`/`setRunEffortOverride` (`repository.ts:727-737`) and
  matching `Run`/`RunRow` fields (`repository.ts:290, 395`). Migrations are additive, idempotent,
  tracked by name in `schema_migrations` (`migrations.ts`); helper `addColumnIfMissing`.
- **API** — routes in `src/api/server.ts` delegate to `Orchestrator` methods
  (`src/api/orchestrator.ts`). Settings: `GET /settings` → `getSettings()` (orch:990),
  `PUT /settings/default-harness` / `PUT /settings/default-model`. Per-run:
  `POST /runs/:id/model` / `POST /runs/:id/effort` → `setModel`/`setEffort` returning the updated
  `Run`.
- **Dashboard** — thin `request<T>(method, path, body)` client (`dashboard/src/lib/api.ts`); single
  `ui = $state({...})` store with optimistic-update-then-rollback actions
  (`dashboard/src/lib/store.svelte.ts`; `loadSettings`, `setDefaultHarness`, `setModel`, `setEffort`).
  Global controls live in the **new-run bar** `FileRunBar.svelte`; per-run controls in the
  `.af-rig` rail of `RunDetail.svelte`. Reusable input components: `ModelPicker`, `EffortSelect`.
  Routes (`App.svelte`): `home` / `pipelines` / `editor`.

## Approach & architecture

Assemble the effective operator context **in the runner** (the one place with both `this.repo` and
the `run` snapshot), then inject it into the composed **system prompt** as a clearly-labeled block
positioned **immediately before the output contract**, so the contract stays the final load-bearing
instruction. The versioned prompt files stay untouched.

Concretely:

1. **Storage (3 tiers, reusing existing config layers):**
   - Global → `settings` key `context_global`.
   - Per-stage → `settings` keys `context_stage:<stage>` (one row per stage that has context).
   - Per-issue → new additive nullable `runs.issue_context TEXT` column (run-scoped, per the
     guardrail "per-issue → a runs/issue-scoped field"; it naturally survives PR-feedback re-entry
     and back-edge re-runs, which reuse the same run row).

2. **Context composer (pure, unit-tested):** new module `src/agent/operator-context.ts` exporting
   `composeOperatorContext({ global, stage, issue }): string`. Trims each layer, drops empty ones,
   joins the survivors, and wraps the result in a labeled delimiter (empty layers omitted cleanly;
   returns `''` when all three are empty). The label makes it unambiguous that this is
   operator-provided standing guidance distinct from the core contract, e.g.:

   ```
   ## Operator-provided context

   Standing guidance configured by the human operator for this fleet/stage/issue. Treat it as
   additional instruction that refines — but never overrides — the stage contract above.

   <global text>

   <stage text>

   <issue text>
   ```

   Setting-key constants (`CONTEXT_GLOBAL_SETTING_KEY`, `contextStageKey(stage)`) live alongside the
   existing keys in `src/agent/harness.ts`.

3. **Injection point (system prompt, contract stays last):** extend `SystemPromptFn` to
   `(stage, phase, operatorContext?: string) => string`. Inside `createSystemPromptFn`, when a
   non-empty `operatorContext` is supplied, splice it in as its own section **before** the final
   contract section (for pseudo-stages whose section carries their own contract, insert before that
   section). The runner computes the string and passes it:
   - In `invokePhase`: `global = repo.getSetting(CONTEXT_GLOBAL_SETTING_KEY)`,
     `stage = repo.getSetting(contextStageKey(run.currentState))`, `issue = run.issueContext`;
     `const opCtx = composeOperatorContext({ global, stage, issue })`; pass `opCtx` as the third arg
     to `this.systemPrompt(run.currentState, phase, opCtx)`.
   - Apply the same at the pseudo-stage call sites (`runChat`, `advise`, `resolveConflicts`) so the
     **global** and **per-run** layers reach every agent invocation (per-stage keyed by the
     pseudo-stage name will simply be empty unless an operator sets it). Keep this DRY via a small
     private helper `this.operatorContextFor(run, stage)` on the runner.

   *Alternative considered (for interface_design to confirm):* surface the context as a labeled
   field in the `input` (user input) instead of the system prompt. Rejected as the default because
   standing behavioral guidance belongs with the role in the system prompt, and appending to `input`
   would either change the parsed input schema or risk pushing text after the load-bearing contract.
   The signature-extension keeps prompt files stable **and** keeps the contract last.

4. **API surface (mirror existing settings/per-run patterns):**
   - Extend `Orchestrator.getSettings()` to also return `contextGlobal: string | null` and
     `contextStages: Record<string, string>` (only stages with a set value), surfaced by
     `GET /settings`.
   - `PUT /settings/context/global` `{ context: string | null }` → new
     `Orchestrator.setGlobalContext(context)`.
   - `PUT /settings/context/stage` `{ stage: string, context: string | null }` →
     `Orchestrator.setStageContext(stage, context)`, validating `stage` against the known stage set
     (reject typos with a 400 so dead keys can't accumulate).
   - `POST /runs/:id/context` `{ context: string | null }` → new
     `Orchestrator.setRunContext(id, context)` → `Repository.setRunIssueContext`, returning the
     updated `Run` (exactly like `setModel`/`setEffort`).
   - Body validation follows the existing `PUT /settings/default-model` pattern (string-or-null
     checks, `ApiError(400)` on bad input).

5. **Dashboard UI:**
   - **Layers 1–2 (global settings panel):** add an operator-context editing surface following the
     current settings patterns. Recommended: a compact "Custom context" disclosure/panel reachable
     from the new-run/settings area (a `<textarea>` for the global base, plus a per-stage list — one
     labeled `<textarea>` per known stage). New store state (`ui.contextGlobal`,
     `ui.contextStages`) loaded in `loadSettings`; optimistic actions `setGlobalContext` /
     `setStageContext` with rollback + `banner` on error (mirror `setDefaultHarness`).
   - **Layer 3 (per-issue/run):** add an `issueContext` field to the `Run` type and a labeled
     `<textarea>` in `RunDetail.svelte`'s config rail (quiet, next to the model/effort rail);
     store action `setRunContext(id, text)` → `POST /runs/:id/context` (mirror `setModel`).
   - Factor a small reusable `ContextEditor.svelte` (textarea + Save/Clear) so the three surfaces
     share one component, consistent with how `ModelPicker`/`EffortSelect` are shared.

## Files / areas to change

Backend:
- `src/store/schema.sql` — add `issue_context TEXT` to `runs` (with a comment like the other
  per-run columns; appended last for fresh-vs-migrated parity).
- `src/store/migrations.ts` — new migration `{ version: 15, name: 'add runs.issue_context', apply:
  addColumnIfMissing(...) }`.
- `src/store/repository.ts` — add `issueContext` to `Run` + `RunRow` + row mapping; add
  `setRunIssueContext(id, context|null)` (mirror `setRunModelOverride`).
- `src/agent/harness.ts` — `CONTEXT_GLOBAL_SETTING_KEY` + `contextStageKey(stage)` helper +
  (optionally) the known-stage set for validation.
- `src/agent/operator-context.ts` (new) + `composeOperatorContext`.
- `src/agent/prompts.ts` — extend `SystemPromptFn` signature and splice the operator-context section
  before the contract.
- `src/agent/runner.ts` — update the `SystemPromptFn` type + `defaultSystemPrompt` stub; compute and
  pass operator context at `invokePhase` and the three pseudo-stage sites via a private helper.
- `src/api/orchestrator.ts` — `getSettings` additions + `setGlobalContext` / `setStageContext` /
  `setRunContext`.
- `src/api/server.ts` — the three new routes.

Frontend:
- `dashboard/src/lib/types.ts` — `Settings` gains `contextGlobal` / `contextStages`; `Run` gains
  `issueContext`.
- `dashboard/src/lib/store.svelte.ts` — new `ui` fields + `loadSettings` additions + actions.
- `dashboard/src/lib/ContextEditor.svelte` (new); wire into a global settings surface (near
  `FileRunBar` / a small settings panel) and into `RunDetail.svelte`.

## Risks & edge cases

- **Contract must stay last.** Appending operator text after the composed prompt would bury the
  "final message must be JSON" instruction; hence the signature-extension that inserts before the
  contract. interface_design must confirm placement for the pseudo-stages too.
- **Empty/whitespace layers** — trim and omit so the delimiter never wraps nothing and separators
  don't stack.
- **Stage-key typos** — validate `PUT /settings/context/stage` against the known stage set to avoid
  dead `context_stage:<typo>` rows.
- **Persistence across restarts** — global/per-stage in `settings`, per-run in `runs`; both durable
  (SQLite). Covered by an existing-DB migration test.
- **Applies on re-runs automatically** — read at each dispatch, so back-edge re-runs and
  PR-feedback re-entry (same run row) pick up current context with no extra wiring.
- **Not part of the FSM config hash** — like prompts today, operator context is runtime config; a
  mid-run change takes effect on the next stage dispatch (consistent with model/effort overrides).
- **Token budget** — context is concatenated verbatim (no templating, per scope); large blocks cost
  tokens. Operator's responsibility; no cap in the first cut (note in UI copy if cheap).
- **Clean tree** — no new generated artifacts; `.agent/` scratch is stripped before merge as usual.

## Testing

- **Unit** `operator-context.test.ts` — layer ordering, empty-layer omission, all-empty → `''`,
  delimiter/label presence.
- **Prompts** `prompts.test.ts` — operator context appears as a delimited section and sits **before**
  the output contract; absent/empty context leaves the prompt byte-identical to today (regression
  guard).
- **Repository** `repository.test.ts` — `setRunIssueContext` set/clear round-trips and surfaces on
  the `Run`; `getSetting/setSetting` already covered for the KV keys.
- **Migration** `db.test.ts` — a pre-existing DB gains `runs.issue_context`; fresh schema matches.
- **Orchestrator** `orchestrator.test.ts` — `getSettings` returns the context fields; set/clear
  global, per-stage (incl. unknown-stage 400), per-run.
- **Server** `server.test.ts` — the three routes (happy path + body validation 400s).
- **Runner** `runner.test.ts` — with settings/run context configured, the `system` handed to the
  executor includes the composed block; with none, it doesn't.
- **Dashboard** `store.test.ts` (+ a pure test for the editor if logic warrants) — `loadSettings`
  hydrates context fields; `setGlobalContext`/`setStageContext`/`setRunContext` optimistic update +
  rollback on error.
- Full `npm test` for no regressions; keep versioned prompt files unchanged.

## Scope flags

- `needs_frontend: true` — global settings panel + per-issue field + store/api wiring.
- `needs_backend: true` — schema/migration, repository, context composer, prompt injection, runner,
  API endpoints.
