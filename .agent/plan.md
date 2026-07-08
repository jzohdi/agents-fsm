# Plan — Layer 3: escalation resolution advisor (jzohdi/agents-fsm#4)

## Goal (restated)

Turn resolving a `needs_human` escalation from *write-your-own-guidance* into *pick-and-go*. Add an
**on-demand, read-only advisor** that reads the stuck run's artifacts + escalation reason and returns
a plain-English summary plus 1–3 suggested resolution *options* (resume / revert, with pre-filled
guidance). Surface those options as selectable cards in the dashboard's escalation panel, and add an
optional per-resume `extraRounds` override so an `internal_review_cap` escalation can be given more
review budget for that visit only.

Three sub-deliverables, per the issue:

1. On-demand resolution advisor (read-only agent phase + `POST /runs/:id/advise` + persistence).
2. Option cards in the escalation panel (dashboard).
3. Per-resume `extraRounds` override for `internal_review_cap`.

**Hard constraint: never touch `src/fsm/`.** The advisor is loop/runner/API/dashboard surface only.

## How the code works today (grounding)

- **Read-only agent phases already exist as a pattern.** Two "pseudo-stages" run through the harness
  executor without being FSM states:
  - Run chat — `runChat()` in `src/agent/runner.ts:671`, stage label `CHAT_STAGE = 'chat'`
    (`runner.ts:90`), read-only tool grant `CHAT_READ_TOOLS` (`runner.ts:93`), its own output contract
    in `prompts/phases/chat.md`, composed by `createSystemPromptFn` via the special-case at
    `src/agent/prompts.ts:65`. Telemetry recorded via `repo.recordAgentRun`; usage added with
    `addRunUsage` **without** bumping `agentRuns` (operator-initiated work must not eat the pipeline
    budget — `runner.ts:739`).
  - Conflict resolver — `invokeConflictResolver()` (`runner.ts:766`), stage `RESOLVE_CONFLICTS_STATE`.
  The advisor is a third instance of exactly this shape (read-only, structured output).
- **Prompt composition** (`src/agent/prompts.ts:57`): pseudo-stages get `[base, <phase file>]` joined,
  and carry their *own* output contract inline (so base's envelope-contract instruction is overridden).
  We add a `phases/advise.md` and an `ADVISE_STAGE` special-case, mirroring the `CHAT_STAGE` branch.
- **Orchestrator ↔ runner wiring**: the Orchestrator holds `this.runner: AgentRunner`
  (`src/api/orchestrator.ts:154`). Chat runs through an async pump (`runChatExchange`, `orchestrator.ts:1143`)
  that streams replies; the simpler synchronous pattern is `checkPrFeedback()` (`orchestrator.ts:528`)
  — `async`, awaits, returns the result to the route handler. The advisor is a single read-only
  invocation returning JSON, so it follows the **synchronous** `checkPrFeedback` shape: the route
  awaits `orch.advise(id)` which calls `runner.runAdvisor(run)`, persists, and returns.
- **HTTP routing** (`src/api/server.ts`): on-demand run-scoped POSTs are matched with a regex and
  dispatched to an orchestrator method (see `check-pr-feedback` at `server.ts:301`, `check-reply` at
  `server.ts:308`). Body-carrying actions live in the `actionMatch` switch (`server.ts:224`), e.g.
  `resume` already reads+validates an optional `notes` string (`server.ts:230`).
- **Resume path**: `POST /runs/:id/resume` → `orch.resume(id, notes)` (`orchestrator.ts:389`) →
  `loop.resumeRun(runId, { notes })` (`src/loop/event-loop.ts:225`). `resumeRun` records a
  `{ kind: 'operator_resume', notes }` reason on the resume transition (`event-loop.ts:241`) and sets
  `isReset: true` (fresh round budget). `reentryContext()` (`runner.ts:160`) later classifies that
  transition and injects it as the `reentry` stage-input field.
- **Review cap**: `runPhases()` loops `round < recipe.reviewCap` (`runner.ts:838`) and, on cap-hit with
  blocking issues, escalates `internal_review_cap` with reason `{ kind, cap, notes }` (`runner.ts:862`).
  `recipe.reviewCap` comes from `recipeFor()` in **`src/fsm/config`** — off-limits — so `extraRounds`
  must be applied as a **runner-side override of the effective cap**, not a config change.
- **Persistence conventions**: SQLite is the control-plane source of truth (`src/store/schema.sql`).
  The `run_chat` table (`schema.sql:184`) is the precedent for a per-run operator-facing record;
  migrations are forward-only, appended by name in `src/store/migrations.ts` (see the `run_chat`
  migration at `migrations.ts:168`) **and** mirrored into `schema.sql` with `CREATE TABLE IF NOT EXISTS`
  so a fresh DB matches a migrated one. Note: `artifacts` are explicitly *references, not content*
  (`schema.sql:97` comment), and the advice payload is content — so a **small table** is the right
  home, not an artifact.
- **Run detail assembly**: `getRunDetail()` (`orchestrator.ts:779`) returns `{ run, transitions,
  agentRuns, artifacts, logs, chat }`. The dashboard reads this into `RunDetail` (`store.svelte.ts:463`).
  We add `advice` to this object so a reload keeps the last advisor result.
- **Dashboard escalation panel**: `RunDetail.svelte` — escalation block at line 259; guidance textarea
  bound to `guidance` state (`RunDetail.svelte:61`, `287`); guided resume via `control('resume', guidance)`
  (`RunDetail.svelte:107`, `store.svelte.ts:472`); revert via `revertRun(toState, reason)`
  (`store.svelte.ts:497`). Escalation model/humanizing is pure logic in `dashboard/src/lib/render.ts`
  (`escalationModel`, `escalationDetail`, `TRIGGER_GUIDANCE` at `render.ts:645`), unit-tested in
  `render.test.ts`.

## Approach & architecture

### 1. Advisor agent phase (runner)

- Add `ADVISE_STAGE = 'advise'` constant + `ADVISE_READ_TOOLS` (reuse the read-only grant shape used by
  `CHAT_READ_TOOLS`) in `src/agent/runner.ts`.
- Add `async runAdvisor(run: Run): Promise<AdviceResult>` modeled on `runChat`:
  - `prepareTree(run)`; build input `{ issueRef, repoRef, stage: ADVISE_STAGE, phase: 'produce',
    issue, artifacts, run: { state, status }, escalation: <trigger + reason from the latest escalation
    transition>, pullRequest? }`. Get the escalation trigger/reason the same way `resumeRun` does:
    the latest transition into `fsm.escalationState` (its `trigger` + parsed `reason`). Expose a small
    helper the runner can call, or read via `repo.listTransitions(run.id)` inside the runner.
  - Same model/effort override precedence as `runChat` (`phaseModel(DEFAULT_MODELS.produce, ...)`).
  - Invoke `executor.run({ ... system: this.systemPrompt(ADVISE_STAGE, 'produce'),
    allowedTools: ADVISE_READ_TOOLS, workingDir })`.
  - Record telemetry via `recordAgentRun` (stage `advise`, phase `produce`); add usage via
    `addRunUsage` **without** `agentRuns` (operator-initiated, like chat).
  - Parse the output with a new `parseAdvice()` (Zod-style, mirroring `chatResponseText`/`parseEnvelope`)
    into `{ summary: string, options: AdviceOption[] }` where
    `AdviceOption = { label, rationale, action: 'resume' | 'revert', toState?: string,
    suggestedNotes?: string }`, 1–3 options. On malformed output, favor returning a minimal fallback
    (advisor is advisory, never load-bearing) rather than escalating — but prefer a bounded retry via
    the existing `invokeParsed`-style approach if it fits cleanly; otherwise a single attempt with a
    graceful fallback message, consistent with `chatResponseText`'s "show something" stance.
- Add `phase` CHECK note: `recordAgentRun` requires `phase IN ('produce','self_review','simplify')`
  (`schema.sql:88`) — advisor uses `produce`, so no schema change there (same as chat/resolver).

### 2. Prompt (`src/agent/prompts/phases/advise.md`)

- New file: role = a read-only escalation-resolution advisor. Reads artifacts + escalation reason,
  explains *why the run is stuck* in one paragraph, proposes 1–3 concrete options (first = recommended),
  each mapping to a real control action (resume to retry the escalated-from state, or revert to an
  earlier state) with `suggestedNotes` the operator can accept as-is. Carries its **own** JSON output
  contract `{ "summary": "...", "options": [ { "label", "rationale", "action", "toState?",
  "suggestedNotes" } ] }` (overrides base's envelope contract, like `chat.md`).
- Wire it in `src/agent/prompts.ts`: `const advise = read(dir, join('phases', 'advise.md'))` and a
  special-case `if (stage === ADVISE_STAGE) return [base, advise].join(SECTION_SEPARATOR)` (mirrors the
  `CHAT_STAGE` branch at `prompts.ts:65`).

### 3. Persistence (`run_advice` table)

- Add a `run_advice` table (one row per advisor invocation; the latest is what the panel shows):
  `id, run_id, summary TEXT, options TEXT (JSON), tokens, created_at`. Mirror in `schema.sql` and add a
  forward-only migration in `migrations.ts` (next version/name), both `CREATE TABLE IF NOT EXISTS`.
- Repository methods in `src/store/repository.ts`: `insertAdvice(...)`, `getLatestAdvice(runId)`
  (+ `listAdvice` if useful) with tests in `repository.test.ts`. Return type parses `options` JSON.

### 4. Orchestrator + HTTP route

- `async advise(runId): Promise<AdviceResult>` on the Orchestrator (`src/api/orchestrator.ts`):
  `requireRun` (404); guard status is `needs_human` (throw `ApiError(409, ...)` otherwise — advising a
  non-escalated run is meaningless); `await this.runner.runAdvisor(run)`; persist via `repo.insertAdvice`;
  return the stored advice. Publish a `status`/detail event if needed so connected dashboards refresh
  (follow `checkPrFeedback`'s broadcast pattern), or rely on the dashboard re-fetching detail.
- Route: add `advise` matcher in `src/api/server.ts` next to `check-pr-feedback`/`check-reply`:
  `POST /runs/:id/advise` → `sendJson(res, 200, await orch.advise(id))`. Route tests in
  `src/api/server.test.ts`; orchestrator tests in `orchestrator.test.ts` (against the stub executor).
- Include `advice: repo.getLatestAdvice(runId)` in `getRunDetail()` so a reload keeps the last result.

### 5. Per-resume `extraRounds` override (internal_review_cap)

- `POST /runs/:id/resume` body: accept optional `extraRounds` (positive integer) alongside `notes`
  (`server.ts:230` case `resume`). Validate: integer, `> 0`, small sane bound (e.g. ≤ 10) → else 400.
- Thread it through `orch.resume(id, notes, extraRounds)` → `loop.resumeRun(runId, { notes, extraRounds })`
  (`event-loop.ts:225`). Record it on the resume transition reason:
  `{ kind: 'operator_resume', notes?, extraRounds? }` (event-loop, **not** fsm).
- Runner applies it as an **effective-cap override** in `runPhases` (`runner.ts:838`): read the current
  visit's `extraRounds` from the same latest resume transition `reentryContext` already surfaces (so it
  applies only to the resumed re-run and naturally expires once the run moves forward), and loop to
  `recipe.reviewCap + extraRounds`. `reviewRound.cap` reflects the effective cap so the reviewer/fixer
  see the real budget. No `src/fsm/` change — `recipe.reviewCap` is read-only input, overridden locally.

### 6. Dashboard — option cards

- `dashboard/src/lib/types.ts`: add `AdviceOption` + `Advice` types; `RunDetail.advice?: Advice`.
- `dashboard/src/lib/render.ts`: a pure `adviceCardsModel(advice)` (or inline) that maps stored options
  to card view-models (label, rationale, action badge, target-state label via `humanizeState`,
  recommended flag on the first). Unit tests in `render.test.ts`.
- `dashboard/src/lib/store.svelte.ts`: `requestAdvice()` → `POST /runs/:id/advise`, stores the result
  in the run detail (upsert into the cached detail so it survives reload — server also returns it in
  `getRunDetail`). Extend `control('resume', notes, extraRounds?)` / add an `extraRounds` param plumbed
  into the resume request body.
- `dashboard/src/lib/RunDetail.svelte` (escalation block ~line 285):
  - **"Suggest resolutions"** button → `requestAdvice()` (loading state; on-demand, never automatic).
  - Render `summary` + option cards. Selecting a card **pre-fills**: `guidance = option.suggestedNotes`
    and, for `action: 'resume'`, targets the guided-resume form; for `action: 'revert'`, opens the
    revert form with `revertTo = option.toState` pre-selected and `revertReason = option.suggestedNotes`.
  - The existing free-text guidance textarea stays as the implicit **"Other"** option.
  - For an `internal_review_cap` escalation, add an optional `extraRounds` number input near the resume
    button, passed to `control('resume', guidance, extraRounds)`.

## Files to change

- `src/agent/runner.ts` — `ADVISE_STAGE`, `ADVISE_READ_TOOLS`, `runAdvisor`, `parseAdvice`,
  effective-cap override in `runPhases`.
- `src/agent/prompts.ts` — load + special-case `advise.md`.
- `src/agent/prompts/phases/advise.md` — new prompt + inline output contract.
- `src/store/schema.sql` + `src/store/migrations.ts` — `run_advice` table.
- `src/store/repository.ts` (+ `.test.ts`) — advice insert/get.
- `src/loop/event-loop.ts` — `resumeRun({ notes, extraRounds })` records `extraRounds` in the reason.
- `src/api/orchestrator.ts` (+ `.test.ts`) — `advise()`, `resume()` extraRounds arg, `getRunDetail` adds
  `advice`.
- `src/api/server.ts` (+ `.test.ts`) — `POST /runs/:id/advise`, resume `extraRounds` validation.
- `dashboard/src/lib/types.ts` — `Advice`, `AdviceOption`, `RunDetail.advice`.
- `dashboard/src/lib/render.ts` (+ `.test.ts`) — advice card view-model.
- `dashboard/src/lib/store.svelte.ts` — `requestAdvice`, resume `extraRounds` plumbing.
- `dashboard/src/lib/RunDetail.svelte` — Suggest-resolutions button, cards, extraRounds input.
- `README.md` §9.5 — document the advisor (Layer 3) alongside Layers 1/2.

## Risks & edge cases

- **`src/fsm/` is off-limits.** `extraRounds` must be a runner-side cap override; do **not** change
  `recipeFor`/`reviewCap` in config. Verified: `recipe.reviewCap` is read-only input to `runPhases`.
- **`extraRounds` scope = "that visit only."** Deriving it from the latest resume transition (which
  `reentryContext` already reads) makes it expire automatically once the run advances — no persistent
  field, no stale budget on a later escalation. Guard against it applying to an unrelated later stage.
- **Advisor is advisory, never load-bearing.** Malformed advisor output must not break the escalation
  UX — degrade gracefully (fallback summary / empty options), consistent with `chatResponseText`.
- **Cost/budget.** Advisor usage is charged to run tokens/cost (real spend, cost ceiling must see it)
  but must **not** bump `agentRuns` — same rule as chat. On-demand only (button), never automatic, so
  idle escalations stay free (issue requirement).
- **Status guard.** `advise` only makes sense for `needs_human`; return `409` otherwise (matches the
  ApiError-with-status convention).
- **Persistence choice.** Small table over artifact (advice is content, artifacts are references).
  Migration must be additive + mirrored in `schema.sql` (fresh-DB-vs-migrated-DB drift guard, per the
  migrations.ts doc and the runs.harness incident note).
- **`reasonText` / raw-payload toggle** in the panel must keep working; cards are additive, the raw
  escalation reason stays behind its existing toggle.
- **Working tree cleanliness**: no generated artifacts; the advisor is read-only so it leaves the tree
  untouched (unlike write-mode chat — no commit/push).

## Testing

- `src/store/repository.test.ts` — insert/get advice round-trips JSON options.
- `src/api/orchestrator.test.ts` — `advise()` on a `needs_human` run returns + persists advice (stub
  executor returns canned advice JSON); `409` on a non-escalated run; `resume` with `extraRounds`
  records it on the transition reason.
- `src/api/server.test.ts` — `POST /runs/:id/advise` route (200 + shape; 404 unknown run; 409 wrong
  status); resume `extraRounds` validation (400 on non-int / ≤0 / over-bound).
- `src/agent/runner.test.ts` — `runAdvisor` invokes the executor with read-only tools + advise system
  prompt, records telemetry without bumping `agentRuns`; `runPhases` honors an `extraRounds` cap bump
  for the resumed visit and not afterward; `parseAdvice` accepts valid / rejects malformed.
- `src/agent/prompts` — advise stage composes `[base, advise]` (extend the existing prompt-composition
  test if present).
- `dashboard/src/lib/render.test.ts` — advice card view-model (recommended-first, action badges,
  humanized target state).
- Full gate: `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:dashboard`.
- Manual: `npm run dev:preview`, open run 7 (the seeded `needs_human` run), click **Suggest
  resolutions**, confirm cards render and selecting one pre-fills guidance / revert target; confirm the
  `extraRounds` input appears for an `internal_review_cap` escalation.

## Scope flags

- `needs_frontend: true` — Suggest-resolutions button, option cards, extraRounds input, render.ts model.
- `needs_backend: true` — advisor phase, prompt, persistence, orchestrator method, HTTP route, resume
  extraRounds plumbing.
