# Interface — Configure custom agent/stage/issue context prompts from the UI (jzohdi/agents-fsm#5)

This pins the types, signatures, module boundaries, data shapes, and invariants for the three-layer
operator-context feature. The `tdd` stage writes failing tests against these contracts; the
implementation stages satisfy them. Reflects `.agent/plan.md`; where the plan left a choice, the
decision is recorded here.

Guiding invariants (hold across every contract below):
- **INV-ORDER** — effective context concatenates layers in order `global → stage → issue`.
- **INV-EMPTY** — a layer that is `null`, `''`, or whitespace-only contributes nothing; no stray
  separators, no empty wrapper. All three empty ⇒ composer returns `''`.
- **INV-CONTRACT-LAST** — the operator-context block is spliced **before** the final output-contract
  section of the composed system prompt, so the load-bearing "final message must be JSON" contract
  stays last.
- **INV-STABLE-PROMPTS** — versioned prompt files under `src/agent/prompts/` are unchanged; when no
  operator context applies, the composed system prompt is byte-identical to today.
- **INV-DURABLE** — global/per-stage persist in `settings`; per-run persists in `runs`; both survive
  daemon restarts. Read fresh at each stage dispatch (like model/effort overrides), so a mid-run
  change takes effect on the next stage and re-runs pick up current values automatically.

---

## 1. Context composer — `src/agent/operator-context.ts` (new)

Pure module, no I/O, unit-tested in isolation.

```ts
export interface OperatorContextLayers {
  /** Layer 1 — global base, from settings key `context_global`. */
  global?: string | null;
  /** Layer 2 — per-stage, from settings key `context_stage:<stage>`. */
  stage?: string | null;
  /** Layer 3 — per-run/per-issue, from `runs.issue_context`. */
  issue?: string | null;
}

/**
 * Assemble the effective operator context. Trims each layer, drops empty ones (INV-EMPTY), joins the
 * survivors in global→stage→issue order (INV-ORDER), and wraps them in a labeled, delimited block.
 * Returns '' when every layer is empty — callers treat '' as "no operator context" and inject nothing.
 */
export function composeOperatorContext(layers: OperatorContextLayers): string;
```

Output shape when at least one layer is non-empty (exact heading text is fixed so `prompts.test.ts`
and `operator-context.test.ts` can assert it; surviving layers separated by a blank line):

```
## Operator-provided context

Standing guidance configured by the human operator for this fleet/stage/issue. Treat it as
additional instruction that refines — but never overrides — the stage contract.

<trimmed global>

<trimmed stage>

<trimmed issue>
```

- The `## Operator-provided context` heading is the stable marker used by the injection point and by
  tests to locate the block. Export it as a constant for reuse:
  `export const OPERATOR_CONTEXT_HEADING = '## Operator-provided context';`.

---

## 2. Setting keys + stage validation — `src/agent/harness.ts`

Alongside `DEFAULT_HARNESS_SETTING_KEY` / `DEFAULT_MODEL_SETTING_KEY` / `DEFAULT_EFFORT_SETTING_KEY`:

```ts
/** Settings key for the global base operator context (Layer 1). */
export const CONTEXT_GLOBAL_SETTING_KEY = 'context_global';

/** Settings key for a per-stage operator context (Layer 2). One row per stage that has context. */
export function contextStageKey(stage: string): string; // => `context_stage:${stage}`

/**
 * The stage types an operator may attach per-stage context to (Layer 2). Used to validate
 * `PUT /settings/context/stage` so typo'd keys can't accumulate dead `context_stage:<typo>` rows.
 * Includes the canonical FSM stages; pseudo-stages (chat/advise/resolve_conflicts) are excluded.
 */
export const CONTEXT_STAGE_TYPES: readonly string[]; // ['triage','plan','plan_review','interface_design','tdd','frontend','backend','code_review']
```

Invariant **INV-STAGES**: `CONTEXT_STAGE_TYPES` must match the canonical stage role files under
`src/agent/prompts/stages/`. Per-stage context keyed by a pseudo-stage name is not offered (those
runs still receive the global + per-run layers).

---

## 3. System-prompt injection — `src/agent/prompts.ts` + `SystemPromptFn` (`src/agent/runner.ts`)

Extend the signature with an optional trailing arg (backward-compatible — omitting it reproduces
today's behavior, satisfying INV-STABLE-PROMPTS):

```ts
// src/agent/runner.ts
export type SystemPromptFn = (stage: string, phase: AgentPhase, operatorContext?: string) => string;
```

`createSystemPromptFn` splices a non-empty `operatorContext` as its own `SECTION_SEPARATOR`-joined
section positioned per INV-CONTRACT-LAST:

- **Real stages** (`base + role [+ phase] + contract`): insert the operator section **immediately
  before** the contract section. Result:
  `[base, role, (phase?), operatorContext, contract].join(SECTION_SEPARATOR)`.
- **`resolve_conflicts`** (`base + resolveConflicts`, no contract): append operator context as the
  last section — this pseudo-stage has no output contract, so "before the contract" degrades to
  "at the end". `[base, resolveConflicts, operatorContext]`.
- **`chat`** and **`advise`** (`base + phase`, where the phase section carries its own contract):
  insert **before** that phase section so the phase's own output contract stays last:
  `[base, operatorContext, chat]` / `[base, operatorContext, advise]`.
- When `operatorContext` is `undefined` / `''`, every branch is byte-identical to today.

Only the empty-vs-nonempty distinction matters; the composer (§1) has already trimmed and labeled the
text, so `prompts.ts` treats it as an opaque section string.

---

## 4. Runner wiring — `src/agent/runner.ts`

Add a private helper that reads the three layers off the repo/run and composes them:

```ts
/** Effective operator context for one invocation: global (settings) + per-stage (settings) + per-run. */
private operatorContextFor(run: Run, stage: string): string {
  return composeOperatorContext({
    global: this.repo.getSetting(CONTEXT_GLOBAL_SETTING_KEY),
    stage: this.repo.getSetting(contextStageKey(stage)),
    issue: run.issueContext,
  });
}
```

Pass its result as the 3rd arg to every `this.systemPrompt(...)` call site, using that call's stage:
- `invokePhase` (`~runner.ts:1087`): `this.systemPrompt(run.currentState, phase, this.operatorContextFor(run, run.currentState))`.
- `runChat` (`~768`): stage `CHAT_STAGE`.
- `advise` (`~866`): stage `ADVISE_STAGE`.
- `resolveConflicts` (`~935`): stage `RESOLVE_CONFLICTS_STATE`.

Update `defaultSystemPrompt` stub to accept (and ignore) the optional 3rd arg so its type still
matches `SystemPromptFn`.

Invariant **INV-EVERY-INVOCATION**: every agent invocation (real stages + all three pseudo-stages)
routes through `operatorContextFor`, so the global and per-run layers reach all of them. Per-stage
context for a pseudo-stage is simply absent (no key set).

---

## 5. Per-run storage — schema / migration / repository

- **`src/store/schema.sql`** — append to `runs`: `issue_context TEXT` (nullable, no default; comment
  it like `model_override` / `effort_override`, appended last for fresh-vs-migrated column parity).
- **`src/store/migrations.ts`** — new migration `{ version: 15, name: 'add runs.issue_context',
  apply: addColumnIfMissing('runs', 'issue_context', 'TEXT') }` (idempotent; use whatever the
  existing `addColumnIfMissing` signature is). Confirm 15 is the next unused version at implementation
  time.
- **`src/store/repository.ts`**:
  - `Run` gains `issueContext: string | null;` (per-run operator context; `null` = none. Doc-comment
    it like `modelOverride`).
  - `RunRow` gains `issue_context: string | null;`.
  - Row → `Run` mapping adds `issueContext: r.issue_context`.
  - New setter mirroring `setRunModelOverride`:
    ```ts
    /** Set (or clear, with null) a run's per-run operator context (dashboard). Read fresh each stage. */
    setRunIssueContext(id: number, context: string | null): void;
    ```
    Normalization rule **INV-CLEAR**: an empty/whitespace-only string is stored as `null` (so "cleared"
    and "blank" are indistinguishable downstream). Apply the same normalization in the orchestrator
    setters (§6) — pick one layer to own it and keep it consistent; the composer tolerates either.

`settings` (KV) needs no schema change — Layers 1–2 reuse `getSetting`/`setSetting` (`null` clears).

---

## 6. Orchestrator — `src/api/orchestrator.ts`

Extend `getSettings()`'s return type and add three setters (mirroring `setDefaultModel` /
`setModel` / `setEffort`):

```ts
getSettings(): {
  defaultHarness: HarnessId;
  harnesses: readonly HarnessId[];
  defaultModel: string | null;
  defaultEffort: string | null;
  // NEW:
  contextGlobal: string | null;                 // settings[context_global], null if unset
  contextStages: Record<string, string>;        // { [stage]: text } — only stages with a non-empty value
};

/** PUT /settings/context/global — persist/clear Layer 1. null (or blank) clears the key. */
setGlobalContext(context: string | null): { contextGlobal: string | null };

/**
 * PUT /settings/context/stage — persist/clear Layer 2 for one stage. Validates `stage` against
 * CONTEXT_STAGE_TYPES (unknown ⇒ ApiError(400), nothing persisted). null/blank clears the key.
 */
setStageContext(stage: string, context: string | null): { stage: string; contextStages: Record<string, string> };

/** POST /runs/:id/context — persist/clear Layer 3 → setRunIssueContext; returns the updated Run (like setModel). */
setRunContext(id: number, context: string | null): Run;
```

- `getSettings().contextStages` is built by reading `contextStageKey(s)` for each `s` in
  `CONTEXT_STAGE_TYPES` and including only the non-empty ones (so the map has no empty values).
- Body-type validation follows the `PUT /settings/default-model` pattern: `context` must be
  `string | null` else `ApiError(400)`; `stage` must be a known stage else `ApiError(400)`.
- `setRunContext` on a missing run id behaves like the existing `setModel`/`setEffort` (same
  not-found handling those use).

---

## 7. API routes — `src/api/server.ts`

Three new routes, delegating to the orchestrator, following the existing settings/per-run route
shape (JSON body parse → validate → delegate → JSON response):

| Method & path                  | Request body                              | Handler / response                              |
|--------------------------------|-------------------------------------------|-------------------------------------------------|
| `PUT /settings/context/global` | `{ context: string \| null }`             | `setGlobalContext` → `{ contextGlobal }`        |
| `PUT /settings/context/stage`  | `{ stage: string, context: string \| null }` | `setStageContext` → `{ stage, contextStages }` |
| `POST /runs/:id/context`       | `{ context: string \| null }`             | `setRunContext` → updated `Run`                 |

- `GET /settings` gains the two new fields automatically via `getSettings()` (no new route).
- Malformed/wrong-type bodies and unknown stage ⇒ `400` (the orchestrator raises `ApiError`; the
  server's existing error middleware renders it).

---

## 8. Dashboard — types / store / components

### `dashboard/src/lib/types.ts`
- `Settings` gains `contextGlobal: string | null;` and `contextStages: Record<string, string>;`.
- `Run` gains `issueContext: string | null;`.

### `dashboard/src/lib/store.svelte.ts`
- `ui` state gains `contextGlobal: string | null` and `contextStages: Record<string, string>`,
  hydrated in `loadSettings` from `GET /settings`.
- New optimistic actions (mirror `setDefaultHarness` / `setModel`: optimistic update → request →
  rollback + `banner` on error):
  - `setGlobalContext(text: string | null)` → `PUT /settings/context/global`.
  - `setStageContext(stage: string, text: string | null)` → `PUT /settings/context/stage`.
  - `setRunContext(id: number, text: string | null)` → `POST /runs/:id/context`; updates that run's
    `issueContext` in store state on success (like `setModel`).

### Components
- New reusable `dashboard/src/lib/ContextEditor.svelte`: a labeled `<textarea>` with **Save** and
  **Clear** actions (Clear sends `null`), consistent with how `ModelPicker` / `EffortSelect` are
  shared. Emits/save-callbacks the edited text (or `null` on clear) to the parent.
- **Layers 1–2 surface** (global settings area near `FileRunBar` / a settings panel): one
  `ContextEditor` for the global base, plus one per stage in `CONTEXT_STAGE_TYPES` for per-stage.
- **Layer 3 surface**: a `ContextEditor` in `RunDetail.svelte`'s config rail (`.af-rig`, next to
  model/effort), bound to the run's `issueContext` via `setRunContext`.

---

## 9. Test contracts (for the `tdd` stage)

- `operator-context.test.ts` — ordering (INV-ORDER), empty-layer omission (INV-EMPTY), all-empty ⇒
  `''`, heading/label present, trimming.
- `prompts.test.ts` — with operator context: appears as a delimited section and sits **before** the
  output contract (INV-CONTRACT-LAST) for real stages and before the phase section for chat/advise;
  without it: composed prompt byte-identical to today (INV-STABLE-PROMPTS).
- `repository.test.ts` — `setRunIssueContext` set/clear round-trips onto `Run.issueContext`;
  blank ⇒ `null` (INV-CLEAR).
- `db.test.ts` — migration 15 adds `runs.issue_context` to a pre-existing DB; fresh schema matches.
- `orchestrator.test.ts` — `getSettings` returns `contextGlobal`/`contextStages`; set/clear global,
  per-stage (incl. unknown-stage ⇒ 400), per-run.
- `server.test.ts` — the three routes (happy path + body/stage validation ⇒ 400).
- `runner.test.ts` — with settings/run context configured, the `system` handed to the executor
  includes the composed block; with none, it does not (INV-EVERY-INVOCATION for at least one real
  stage; ideally a pseudo-stage too).
- `store.test.ts` — `loadSettings` hydrates the context fields;
  `setGlobalContext`/`setStageContext`/`setRunContext` optimistic-update + rollback on error.
- Full `npm test` — no regressions; versioned prompt files unchanged.

---

## 10. Decisions locked (choices the plan flagged for interface_design)

- **Injection = system prompt, not user input.** Standing behavioral guidance belongs with the role;
  appending to `input` would change the parsed input schema or risk text after the contract. Chosen:
  extend `SystemPromptFn` and splice before the contract (INV-CONTRACT-LAST).
- **Pseudo-stage placement** — resolved explicitly per §3 (resolve_conflicts: append at end; chat &
  advise: before their contract-bearing phase section).
- **Per-stage scope = canonical FSM stages only** (`CONTEXT_STAGE_TYPES`); pseudo-stages excluded
  from per-stage but still receive global + per-run.
- **Empty/blank normalized to `null`** at the write boundary (INV-CLEAR) so "clear" and "blank" are
  one state.
- **Not in the FSM config hash** — operator context is runtime config, like model/effort overrides;
  a mid-run change applies at the next stage dispatch. No FSM internals touched.
