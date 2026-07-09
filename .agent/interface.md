# Interface — Per-stage harness override (agents-fsm#12)

The contract the `tdd` and implementation stages build against. Two production files change plus
their tests; everything is additive plumbing on the existing harness registry/recipe design. **No new
executors, no UI, no migration, no store change** (all explicit non-goals).

---

## 1. `StageAgentConfig` — new optional recipe field (`src/fsm/config.ts`)

Add `harness?: string` to the Layer 4 per-stage recipe interface, documented alongside the existing
fields (`phases`, `models`, `reviewCap`, `allowedTools`, `io`).

```ts
export interface StageAgentConfig {
  phases?: AgentPhase[];
  models?: Partial<Record<AgentPhase, string>>;
  reviewCap?: number;
  allowedTools?: string[];
  io?: StageIo;
  /**
   * Optional per-stage harness override. Absent → the run's harness (`runs.harness`), then the
   * shipped default (`DEFAULT_HARNESS`, `claude-code`). Must be a valid `HarnessId`
   * (`claude-code` | `cursor`) — NOT `claude`.
   */
  harness?: string;
}
```

**Invariant:** the declared type is `string`, but its *value* is validated to a known `HarnessId` at
config-load (§2). Left `undefined` when unset — the runner's `??` chain (§4) drives precedence.

---

## 2. `stageAgentSchema` — static validation (`src/fsm/config.ts`)

Add a `harness` key to the strict `stageAgentSchema` Zod object:

```ts
harness: z
  .string()
  .refine(isHarnessId, { message: 'harness must be a valid harness id (e.g. "claude-code", "cursor")' })
  .optional(),
```

- **Import:** `import { isHarnessId } from '../agent/harness';` — a **value** import. This creates no
  import cycle: `harness.ts` has only type-only imports (`import type { StageExecutor }`), so there is
  no path back to `fsm/config`. Mirrors `agent/runner` already importing `recipeFor` from `fsm/config`.
- **Contract:** an invalid id (e.g. `'claude'`) is rejected at config load. `parseAgentsConfig` throws
  `ConfigValidationError`, message prefixed `agents.<stage>.harness: …` (the existing
  `parsed.error.issues.map(...)` path). Matches how a per-run harness is validated at `POST /runs`.
- The object stays `.strict()`; `agentsSchema` and `parseAgentsConfig` are otherwise unchanged.

---

## 3. `recipeFor` — surface the field (`src/fsm/config.ts`)

Add `harness` to both the inline return type and the returned object:

```ts
export function recipeFor(
  stage: string,
  agents: AgentsConfig,
): {
  phases: AgentPhase[];
  models: Partial<Record<AgentPhase, string>>;
  reviewCap: number;
  allowedTools?: string[];
  io: StageIo;
  harness?: string;   // NEW
} {
  const c = agents[stage];
  return {
    phases: c?.phases ?? [...DEFAULT_PHASES],
    models: c?.models ?? {},
    reviewCap: c?.reviewCap ?? DEFAULT_REVIEW_CAP,
    allowedTools: c?.allowedTools,
    io: c?.io ?? DEFAULT_IO,
    harness: c?.harness,   // NEW — undefined when unset; NO default here
  };
}
```

- `harness` is passed through raw (**no** default applied here) so the runner owns precedence.
- `Recipe = ReturnType<typeof recipeFor>` (`runner.ts:1224`) widens automatically — no separate type
  to edit.

---

## 4. `AgentRunner.invokePhase` — resolve the executor per stage (`src/agent/runner.ts`)

Change the single resolution line at `runner.ts:1079`, inside the existing per-phase `try`:

```ts
// before
const executor = this.harnesses.for(run.harness);

// after
const executor = this.harnesses.for(recipe.harness ?? run.harness ?? DEFAULT_HARNESS);
```

- **Import** `DEFAULT_HARNESS` from `./harness` — the module `runner.ts` already imports
  `singleHarness`, `isHarnessResolver`, `HarnessResolver` from.
- `recipe` is already a parameter of `invokePhase` (`runner.ts:1048`); no signature change.
- **Use `??` (nullish coalescing), not `||`** — an empty string must not fall through (the schema
  forbids it anyway, but the operator is a belt-and-braces guard on precedence semantics).
- Resolution **stays inside the existing `try`**, so a valid-but-unregistered id (e.g. `cursor` on a
  daemon that only wired `claude-code`) is caught by the same `catch`: records a failed `agent_run`,
  rethrows, and the loop escalates that one run as `executor_error → needs_human`. Never crashes the
  drain. This exactly matches the PR-1 per-run behavior the issue references.
- Update the adjacent comment (`runner.ts:1076–1078`) to note the per-stage precedence.

**Out of scope — do NOT touch:** `runChat`, `runAdvisor`, `invokeConflictResolver`. Those pseudo-stage
invocations (`chat`, `advise`, `resolve_conflicts`) are not FSM states, have no recipe, and correctly
keep resolving `run.harness`. `validateAgents` already rejects an `agents` key that is not a real
non-terminal state, so a pseudo-stage recipe cannot be configured.

---

## 5. Precedence — the one invariant to uphold

```
recipe.harness (per-stage)  >  run.harness (per-run, pinned at start)  >  DEFAULT_HARNESS ('claude-code')
```

`runs.harness` is `NOT NULL DEFAULT 'claude-code'`, so `run.harness` is always present in practice; the
`?? DEFAULT_HARNESS` tail is a defensive match to the issue's exact expression.

**Behavior-preserving:** when no recipe sets `harness`, `recipe.harness` is `undefined` and resolution
reduces to `this.harnesses.for(run.harness)` — identical to today. No `default-config.json` change (no
shipped stage sets `harness`).

---

## 6. Two distinct guards — both must hold

| Case | Where it fails | Result |
| --- | --- | --- |
| Invalid id (not a `HarnessId`, e.g. `'claude'`) | config load (`isHarnessId` refine, §2) | `ConfigValidationError` — never reaches a run |
| Valid but unregistered id (e.g. `'cursor'` on a subset registry) | runtime (`HarnessRegistry.for` throws, §4) | `executor_error` escalates that one run |

---

## 7. Test contract (for the `tdd` stage)

**`src/fsm/config.test.ts`**
- `parseAgentsConfig` accepts a stage with `harness: 'cursor'`; `recipeFor(stage, agents).harness ===
  'cursor'`.
- A stage without `harness` → `recipeFor(...).harness === undefined`.
- `parseAgentsConfig` **rejects** `harness: 'claude'` with a `ConfigValidationError` (the isHarnessId
  static guard); the message references `agents.<stage>.harness`.

**`src/agent/runner.test.ts`** (mirror the existing per-run dispatch block ~`:667`, which constructs
`AgentsConfig`/registry literals directly and bypasses `parseAgentsConfig`)
- **Per-stage override selects a different executor:** a two-executor `HarnessRegistry` (`claude-code`,
  `cursor` spies), a run whose default harness is `claude-code`, and `agents: { plan: { harness:
  'cursor' } }` → the `plan` stage hits the `cursor` spy; a stage with no recipe `harness` hits the run
  default (`claude-code`).
- **Fallback precedence:** with no recipe `harness`, the stage dispatches to `run.harness`; the recipe
  override wins when both are set.
- **Unknown-id escalation:** `agents: { plan: { harness: 'cursor' } }` against a registry that
  registers only `claude-code` → the stage rejects with `no executor registered for harness "cursor"`,
  a failed `agent_run` is recorded, and the `executor_error` path parks that one run (same assertion
  shape as the existing `ghost` per-run test ~`:695`).

**Full suite** stays green (`npm test`); typecheck/build clean.

---

## 8. Files

- **Edit:** `src/fsm/config.ts` — `StageAgentConfig.harness`, `stageAgentSchema` `harness` validation,
  `recipeFor` return (+ inline return type), `isHarnessId` import.
- **Edit:** `src/agent/runner.ts` — `DEFAULT_HARNESS` import; per-stage resolution in `invokePhase`
  (one line + comment).
- **Edit:** `src/fsm/config.test.ts` — schema/recipe coverage (§7).
- **Edit:** `src/agent/runner.test.ts` — per-stage dispatch + fallback + unknown-id escalation (§7).

## 9. Scope flags

- **needs_backend: true** — `src/fsm/config.ts`, `src/agent/runner.ts`, and their tests.
- **needs_frontend: false** — config-file only; no UI/dashboard surface (explicit non-goal).
