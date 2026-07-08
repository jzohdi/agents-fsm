# Interface — Layer 3: escalation resolution advisor (jzohdi/agents-fsm#4)

This pins the types, signatures, module boundaries, and invariants the TDD stage writes tests against
and the implementation satisfies. It follows the grounding in `.agent/plan.md`. **Hard constraint:
never touch `src/fsm/`.** Every contract below lives in runner / prompts / store / loop / api /
dashboard surface only.

Three deliverables, each with its own contract section:

1. On-demand advisor (agent phase + persistence + `POST /runs/:id/advise` + `getRunDetail.advice`).
2. Option cards in the dashboard escalation panel (types + pure render model + `RunDetail.svelte`).
3. Per-resume `extraRounds` override for `internal_review_cap` (resume body → event-loop reason →
   runner effective-cap override).

---

## 1. Advisor core types (`src/agent/runner.ts`)

The advisor's structured result. Exported from `runner.ts` (co-located with `ChatResult`,
`ReentryContext`), re-used by the store, orchestrator, and dashboard-facing shape.

```ts
/** One suggested resolution the advisor proposes for a stuck (needs_human) run. */
export interface AdviceOption {
  /** Short imperative label for the card, e.g. "Accept the reviewer's findings and retry". */
  label: string;
  /** Why this option resolves the escalation — one or two sentences. */
  rationale: string;
  /** The control action this card maps to. `resume` retries the escalated-from state;
   *  `revert` sends the run back to an earlier state. */
  action: 'resume' | 'revert';
  /** For `revert`, the target state to revert to. Ignored/omitted for `resume`
   *  (resume always returns to the escalated-from state, which the loop derives itself). */
  toState?: string;
  /** Operator guidance pre-filled into the guidance box when this card is selected. */
  suggestedNotes?: string;
}

/** What one advisor invocation produced: a plain-English summary + 1–3 options (first = recommended). */
export interface AdviceResult {
  summary: string;
  options: AdviceOption[];
}
```

### Stage constant + tool grant

```ts
/** The pseudo-stage label an advisor invocation runs under (operator-initiated, read-only — like
 *  {@link CHAT_STAGE} it is NOT an FSM state; it is the `agent_runs.stage` label + prompt key). */
export const ADVISE_STAGE = 'advise';

/** Tools the advisor is granted: inspect-only, identical shape to {@link CHAT_READ_TOOLS} — the
 *  advisor reads artifacts + the tree and proposes; it never mutates. (Cursor ignores allow-lists;
 *  the read-only rule is carried by the advise prompt for those runs.) */
export const ADVISE_READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
```

### `runAdvisor` (method on `AgentRunner`)

```ts
/**
 * One read-only advisor invocation over a needs_human run: reads the run's artifacts + escalation
 * trigger/reason and returns a summary + 1–3 resolution options. Models exactly on `runChat`
 * (read mode): prepareTree, same model/effort override precedence, record telemetry via
 * recordAgentRun (stage `advise`, phase `produce`), add usage via addRunUsage WITHOUT bumping
 * agentRuns (operator-initiated, must not eat the pipeline budget). Read-only: leaves the tree
 * untouched (no commit/push). Throws on executor failure (records the failed invocation first,
 * like runChat).
 */
async runAdvisor(run: Run): Promise<AdviceResult & { tokens: number }>
```

Invariants:
- **Escalation context in the input.** The input object mirrors `runChat`'s shape but with
  `stage: ADVISE_STAGE` and an added `escalation: { trigger, reason }` field. The trigger + reason
  come from the **latest transition into the run's current (escalation) state**, located structurally
  the same way `resumeRun`/`escalationModel` do — `[...repo.listTransitions(run.id)].reverse().find(t => t.toState === run.currentState)` — so **no `src/fsm/` import is needed**. Include `pullRequest`
  when `run.prNumber !== null` (same as `runChat`).
- **Usage accounting.** `addRunUsage(run.id, { tokens, cost })` — deliberately no `agentRuns: 1`
  (matches chat; on-demand operator work stays off the pipeline budget). Cost still counts toward the
  global ceiling.
- **Telemetry phase is `produce`.** `recordAgentRun` requires `phase IN ('produce','self_review',
  'simplify')`; advisor uses `produce` — no schema change (same as chat/resolver).
- **Advisory, never load-bearing.** Malformed output must degrade gracefully, not throw/escalate
  (see `parseAdvice`).

### `parseAdvice` (pure exported parser)

```ts
/** Parse an advisor invocation's raw output into an {@link AdviceResult}. Zod-backed, mirroring
 *  parseEnvelope. Accepts `{ summary: string, options: AdviceOption[] }` with 1–3 options, each
 *  option `{ label, rationale, action: 'resume'|'revert', toState?, suggestedNotes? }`.
 *  On malformed output returns a graceful fallback (advisor is advisory) rather than {ok:false}. */
export function parseAdvice(raw: unknown): AdviceResult
```

Invariants:
- **1–3 options**, first is treated as recommended by the dashboard (no separate flag stored).
- **Graceful fallback shape** on malformed/empty output: return a minimal
  `{ summary: <fallback text>, options: [] }` so the escalation UX never breaks. (Consistent with
  `chatResponseText`'s "show something" stance — the advisor's failure must not block resolving the
  escalation, since the free-text box remains the "Other" path.) Contrast with `parseEnvelope`, which
  returns `Parsed<T>` and lets the caller escalate — the advisor deliberately does **not** escalate.
- `action` must be one of `resume` | `revert`; `toState`/`suggestedNotes` optional strings.

---

## 2. Prompt (`src/agent/prompts/phases/advise.md` + `src/agent/prompts.ts`)

- **New file `phases/advise.md`**: role = read-only escalation-resolution advisor. Reads artifacts +
  the escalation reason, explains in one paragraph *why the run is stuck*, proposes 1–3 concrete
  options (first = recommended), each mapping to a real control action (`resume` to retry the
  escalated-from state, or `revert` to an earlier state) with `suggestedNotes` the operator can accept
  as-is. Carries its **own** JSON output contract inline (overrides base's envelope contract, exactly
  like `chat.md`):

  ```json
  {
    "summary": "…",
    "options": [
      { "label": "…", "rationale": "…", "action": "resume" | "revert", "toState": "…?", "suggestedNotes": "…" }
    ]
  }
  ```

- **Wiring in `prompts.ts`** (`createSystemPromptFn`): load `const advise = read(dir, join('phases',
  'advise.md'))` and add a special-case branch mirroring the `CHAT_STAGE` one at `prompts.ts:65`:

  ```ts
  if (stage === ADVISE_STAGE) return [base, advise].join(SECTION_SEPARATOR);
  ```

  Import `ADVISE_STAGE` from `./runner` alongside `CHAT_STAGE`. No shared output-contract file is
  appended (the advise section carries its own contract).

---

## 3. Persistence (`run_advice` table)

### Schema (`src/store/schema.sql` + forward-only migration in `src/store/migrations.ts`)

One row per advisor invocation; the latest is what the panel shows. Small table (advice is *content*;
artifacts are *references*, so an artifact is the wrong home).

```sql
CREATE TABLE IF NOT EXISTS run_advice (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  summary    TEXT    NOT NULL,
  options    TEXT    NOT NULL,                       -- JSON-encoded AdviceOption[]
  tokens     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_run_advice_run ON run_advice(run_id, id);
```

Invariants:
- Migration is **forward-only, appended by name** in `migrations.ts` (next version after 13 = `14`,
  name e.g. `create run_advice`), `CREATE TABLE IF NOT EXISTS` so a fresh DB (baseline schema.sql) and
  a migrated DB converge. **Mirror the identical DDL in `schema.sql`** (fresh-vs-migrated drift guard).
- `options` stored as `JSON.stringify(options)`, parsed back on read.

### Domain type + repository methods (`src/store/repository.ts` + `.test.ts`)

```ts
/** A persisted advisor result for a run (the escalation-resolution advisor, Layer 3). */
export interface Advice {
  id: number;
  runId: number;
  summary: string;
  options: AdviceOption[];   // parsed from the stored JSON
  tokens: number;
  createdAt: string;
}
```

`AdviceOption` is imported from `../agent/runner` (single source of truth; the repository already
imports agent/runner types is not required — if a cross-layer import is undesirable, re-declare a
structurally-identical `AdviceOption` local to the store, matching the runner's shape exactly). Prefer
importing to avoid drift.

```ts
/** Insert one advisor result; returns the stored row (options round-tripped through JSON). */
insertAdvice(input: { runId: number; summary: string; options: AdviceOption[]; tokens: number }): Advice

/** The most recent advisor result for a run, or undefined if none. Powers getRunDetail.advice so a
 *  page reload keeps the last advice. */
getLatestAdvice(runId: number): Advice | undefined
```

Follow the `createChatExchange`/`getChatExchange`/`mapChat` pattern: an internal `AdviceRow` +
`mapAdvice(row)` that `JSON.parse`s `options`. `getLatestAdvice` selects
`ORDER BY id DESC LIMIT 1`.

Tests (`repository.test.ts`): insert → `getLatestAdvice` round-trips `options` JSON; multiple inserts
→ latest wins; `getLatestAdvice` on a run with none → `undefined`.

---

## 4. Orchestrator + HTTP route

### `advise` (method on `Orchestrator`, `src/api/orchestrator.ts` + `.test.ts`)

```ts
/**
 * On-demand escalation-resolution advisor (the dashboard's "Suggest resolutions" button). Runs the
 * read-only advisor over a needs_human run, persists the result, and returns it. 404 unknown run;
 * 409 if the run is not `needs_human` (advising a non-escalated run is meaningless). Synchronous
 * request/response shape like {@link checkPrFeedback} (async, awaits the runner, returns the stored
 * advice). Publishes a `status` event so connected dashboards refresh their detail.
 */
async advise(runId: number): Promise<Advice>
```

Invariants:
- `requireRun(runId)` → 404 (ApiError) on unknown.
- Status guard: `run.status !== 'needs_human'` → `throw new ApiError(409, …)`.
- **Tokens plumbing (single decision):** `runAdvisor` returns `Promise<AdviceResult & { tokens:
  number }>` — the invocation's token usage rides alongside the parsed advice. `parseAdvice` stays
  `AdviceResult` (parse doesn't know tokens). `advise()` calls
  `repo.insertAdvice({ runId, summary: r.summary, options: r.options, tokens: r.tokens })`.
- Returns the persisted `Advice` (so the caller gets the row with `id`/`createdAt`).

### `getRunDetail` gains `advice`

`RunDetail` interface (`orchestrator.ts:69`) gains:

```ts
/** The latest escalation-resolution advice for this run, or undefined if none requested yet. */
advice?: Advice;
```

`getRunDetail` returns `advice: this.repo.getLatestAdvice(runId)` alongside `chat`.

### `resume` gains `extraRounds` (see §6)

`resume(runId: number, notes?: string, extraRounds?: number): Run` — only the `needs_human` branch
threads `extraRounds` into `loop.resumeRun`.

### HTTP route (`src/api/server.ts` + `.test.ts`)

- New matcher next to `check-pr-feedback`/`check-reply`:

  ```ts
  const adviseMatch = /^\/runs\/(\d+)\/advise$/.exec(path);
  if (adviseMatch && method === 'POST') {
    return sendJson(res, 200, await orch.advise(Number(adviseMatch[1])));
  }
  ```

- **`POST /runs/:id/advise`** → `200` + the `Advice` object; `404` unknown run; `409` non-`needs_human`
  run.
- Route tests: 200 + shape on a seeded needs_human run (stub executor returns canned advice JSON);
  404 unknown; 409 wrong status.

---

## 5. Advisor invocation input shape (contract the prompt reads)

The object passed as the advisor's stage input (analogous to base.md's documented stage-input fields):

```jsonc
{
  "issueRef": "owner/name#N",
  "repoRef": "owner/name",
  "stage": "advise",
  "phase": "produce",
  "issue": { "number": N, "title": "…", "body": "…" },
  "base": "main",
  "artifacts": [ /* the run's artifact refs, as listArtifacts returns */ ],
  "run": { "state": "<escalation state>", "status": "needs_human" },
  "escalation": {
    "trigger": "internal_review_cap",         // the escalation trigger label
    "reason": { /* the structured escalation reason payload */ }
  },
  "pullRequest": { "number": N, "branch": "…" }   // only when run.prNumber !== null
}
```

---

## 6. Per-resume `extraRounds` override (internal_review_cap)

### HTTP (`src/api/server.ts`, `resume` case)

Extend the `resume` case to also read/validate `extraRounds`:

```ts
case 'resume': {
  const body = await readJson(req);
  const raw = body.notes;
  if (raw !== undefined && typeof raw !== 'string') {
    return sendError(res, new ApiError(400, '"notes" must be a string when provided'));
  }
  const extra = body.extraRounds;
  if (extra !== undefined && (typeof extra !== 'number' || !Number.isInteger(extra) || extra <= 0 || extra > 10)) {
    return sendError(res, new ApiError(400, '"extraRounds" must be an integer between 1 and 10 when provided'));
  }
  return sendJson(res, 200, orch.resume(id, raw, extra));
}
```

Invariants: `extraRounds` optional; when present must be an **integer, `> 0`, `<= 10`** → else `400`.

### Orchestrator → loop

- `Orchestrator.resume(runId, notes?, extraRounds?)` threads `extraRounds` into the `needs_human`
  branch only: `this.loop.resumeRun(runId, { notes, extraRounds })`. Paused/stopped branches ignore it
  (they re-run a stage that already has its context).
- `EventLoop.resumeRun(runId, options)` signature widens:

  ```ts
  resumeRun(runId: number, options: { notes?: string; extraRounds?: number } = {}): Run
  ```

  Records it on the resume transition reason. **Reason shape:**
  `{ kind: 'operator_resume', notes?, extraRounds? }` — include `notes` and/or `extraRounds` only when
  present. So a resume with just extraRounds still records a reason (currently a notes-less resume
  records no reason — widen the guard to `notes || extraRounds`). **This is loop code, NOT
  `src/fsm/`.**

### Runner effective-cap override (`src/agent/runner.ts`, `runPhases`)

- Derive the current visit's `extraRounds` from the **same latest resume transition** the runner
  already inspects for re-entry context — i.e. from the reason of the latest transition into
  `run.currentState` when its trigger is `RESUME_TRIGGER` (an `operator_resume` reason may now carry
  `extraRounds`). A small pure helper mirroring `operatorResumeNotes`:

  ```ts
  /** The per-visit review-cap bump an operator attached to the resume that re-entered this stage
   *  (0 when none). Parsed from the latest resume transition's `{ kind:'operator_resume', extraRounds }`
   *  reason — so it applies only to the resumed re-run and expires once the run advances. */
  export function operatorResumeExtraRounds(reason: unknown): number
  ```

- In `runPhases`, compute an **effective cap**:
  `const effectiveCap = recipe.reviewCap + extraRounds;` and loop `round < effectiveCap`. The
  `reviewRound.cap` field passed to self_review/simplify reflects `effectiveCap` (reviewer/fixer see
  the real budget), and the `internal_review_cap` escalation reason on a re-hit reports `cap:
  effectiveCap`.
- **`recipe.reviewCap` stays read-only input — no `src/fsm/config` change.** `runPhases` needs the
  run's transitions (or the already-derived value) to read `extraRounds`; thread the value in the same
  way `reentryContext` is threaded (the runner already loads the transitions for a stage dispatch).

Invariants:
- **Scope = "that visit only."** Because `extraRounds` is read from the latest resume transition, it
  naturally expires once the run moves forward (a later escalation → a fresh resume without it → back
  to `recipe.reviewCap`). Must not leak into an unrelated later stage.
- `extraRounds` defaults to `0` when absent → behavior identical to today.

---

## 7. Dashboard contracts

### Types (`dashboard/src/lib/types.ts`)

Mirror the backend (structurally identical to `runner.ts` / store):

```ts
export interface AdviceOption {
  label: string;
  rationale: string;
  action: 'resume' | 'revert';
  toState?: string;
  suggestedNotes?: string;
}

export interface Advice {
  id: number;
  runId: number;
  summary: string;
  options: AdviceOption[];
  tokens: number;
  createdAt: string;
}
```

`RunDetail` (`types.ts:126`) gains: `advice?: Advice;` (optional — absent on an older daemon).

### Pure render model (`dashboard/src/lib/render.ts` + `.test.ts`)

```ts
/** A card view-model for one advisor option (pure; unit-tested in render.test.ts). */
export interface AdviceCard {
  label: string;
  rationale: string;
  /** 'resume' | 'revert' — drives the action badge. */
  action: 'resume' | 'revert';
  /** Present for revert cards: the humanized target-state label (via humanizeState). */
  toStateLabel?: string;
  /** Raw target state (for pre-selecting the revert form). */
  toState?: string;
  /** Notes to pre-fill into the guidance box when the card is selected. */
  suggestedNotes: string;
  /** True for the first option (the recommended one). */
  recommended: boolean;
}

/** Map a persisted Advice to card view-models (recommended = first; humanized revert targets).
 *  Returns [] when advice is absent/empty. */
export function adviceCards(advice: Advice | undefined): AdviceCard[]
```

Invariants (tested in `render.test.ts`):
- First option → `recommended: true`, rest `false`.
- `revert` options → `toStateLabel = humanizeState(toState)` when `toState` is set.
- `suggestedNotes` defaults to `''` when the option omits it.
- Empty/undefined advice → `[]`.

### Store (`dashboard/src/lib/store.svelte.ts`)

- `requestAdvice(runId)` → `POST /runs/:id/advise`; on success upsert the returned `Advice` into the
  cached run detail (`detail.advice = advice`) so it survives without an immediate re-fetch (server
  also returns it in `getRunDetail`).
- `control('resume', notes, extraRounds?)` — extend the resume control to pass `extraRounds` in the
  POST body (`{ notes, extraRounds }`), omitting `extraRounds` when undefined.

### Escalation panel (`dashboard/src/lib/RunDetail.svelte`, escalation block ~line 285)

- **"Suggest resolutions"** button → `requestAdvice()` with a loading state; on-demand, never
  automatic (issue requirement — idle escalations stay free).
- Render `advice.summary` + the `adviceCards(...)` as selectable cards. Selecting a card **pre-fills**:
  - `action: 'resume'` → set `guidance = card.suggestedNotes`, target the guided-resume form.
  - `action: 'revert'` → open the revert form with `revertTo = card.toState` pre-selected and
    `revertReason = card.suggestedNotes`.
- The existing free-text guidance textarea remains the implicit **"Other"** option (unchanged).
- The raw escalation-reason toggle (`escalationDetail` / raw JSON) keeps working — cards are additive.
- For an `internal_review_cap` escalation, show an optional `extraRounds` number input near the resume
  button, passed as `control('resume', guidance, extraRounds)`.

---

## 8. Invariants summary (what the implementation must uphold)

- **Never touch `src/fsm/`.** `extraRounds` is a runner-side effective-cap override; the advisor is a
  pseudo-stage, not an FSM state.
- **Advisor usage is charged to run tokens/cost but NOT `agentRuns`** (like chat) — on-demand only,
  never automatic.
- **Advisor is advisory, never load-bearing** — malformed output degrades to a fallback summary +
  empty options; the free-text guidance box is always available.
- **`advise` requires `needs_human`** → 409 otherwise.
- **Persistence: small table, JSON options, forward-only migration mirrored in `schema.sql`.**
- **`extraRounds` scope is the resumed visit only** — derived from the latest resume transition,
  expires when the run advances; validated `1..10`.
- **Working tree stays clean** — the advisor is read-only (no commit/push), leaves no generated files.

## 9. Test surface (the TDD stage targets these)

- `src/agent/envelope`-style: `parseAdvice` accepts valid / falls back on malformed (1–3 options,
  action enum, graceful empty).
- `src/agent/runner.test.ts`: `runAdvisor` invokes executor with `ADVISE_READ_TOOLS` + advise system
  prompt, records telemetry without bumping `agentRuns`; `runPhases` honors an `extraRounds` cap bump
  for the resumed visit and reverts to `recipe.reviewCap` afterward; `operatorResumeExtraRounds` parse.
- prompts composition: `advise` stage composes `[base, advise]`.
- `src/store/repository.test.ts`: `insertAdvice`/`getLatestAdvice` round-trip.
- `src/loop/event-loop` (via orchestrator or unit): `resumeRun` records `extraRounds` in the reason.
- `src/api/orchestrator.test.ts`: `advise()` persists + returns on needs_human; 409 otherwise; `resume`
  with `extraRounds` threads through; `getRunDetail.advice` populated.
- `src/api/server.test.ts`: `POST /runs/:id/advise` (200/404/409); resume `extraRounds` validation
  (400 on non-int / ≤0 / >10).
- `dashboard/src/lib/render.test.ts`: `adviceCards` view-model (recommended-first, humanized revert
  target, empty → []).
- Full gate: `npm test`, `npm run typecheck`, `npm run lint`, `npm run check:dashboard`.
