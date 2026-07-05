# Interface — Harness-aware usage extraction (agents-fsm#2)

Design contract the `tdd` and implementation stages build against. It pins the seam that moves token/cost
extraction out of the shared parser and behind each `HarnessProfile`, so Cursor records non-zero usage
while Claude Code stays **byte-for-byte** unchanged. Grounded in `.agent/plan.md`; this file is the precise
shape, not a re-derivation.

The extractor is **pure and directly testable** (the acceptance criteria's crux). No FSM, store-schema, or
`AgentUsage` shape changes.

---

## 1. New / changed types (`src/agent/subprocess-executor.ts`)

### 1.1 `ResultEvent` — widened from Claude-only to generic

Today `ResultEvent` (currently a non-exported `interface` at ~line 457) names Claude's `usage` /
`total_cost_usd` fields directly. Widen it to the fields the **shared parser** itself needs, plus an index
signature so a profile's extractor can read harness-specific fields without the shared type naming them:

```ts
/** The terminal `type:"result"` event, harness-agnostic. The shared parser reads only `type`/`is_error`/
 *  `result`; per-harness usage/cost fields (Anthropic's `usage`/`total_cost_usd`, Cursor's own names,
 *  `duration_ms`, …) are read by each profile's `extractUsage` via the index signature. */
export interface ResultEvent {
  type: 'result';
  subtype?: string;
  is_error?: boolean;
  result?: string;
  /** Harness-specific fields the shared type does not name; a profile's `extractUsage` reads them. */
  [key: string]: unknown;
}
```

- MUST keep `type: 'result'`, `is_error?`, `result?` so `isResultEvent`, the `is_error` error path, and
  `parseResultText(event.result ?? '')` are unchanged.
- Dropping the named `usage?` / `total_cost_usd?` fields is fine — Claude's extractor now reads them off the
  index signature (they arrive as `unknown`, so it narrows before use).
- **Export it** (the profiles' `extractUsage` signature references it). It is currently module-local.

### 1.2 `UsageContext` — inputs for the estimate fallback

```ts
/** Inputs a profile MAY use to *estimate* usage when its harness reports none. Only the prompt size is
 *  passed in; the result text is derivable from `event.result`, so it is not duplicated here. */
export interface UsageContext {
  /** Character length of the prompt sent this phase (system prompt + JSON-encoded input). */
  promptChars: number;
}
```

Export it (profiles and call sites reference it).

### 1.3 `HarnessProfile.extractUsage` — the new seam method

Add one method to the existing `HarnessProfile` interface (alongside `buildArgs` / `summarize` /
`isAuthFailure` / `isRateLimit`):

```ts
/** Extract token usage (and a dollar cost, iff this harness reports one) from its terminal result
 *  event. Harness-specific: Claude reads Anthropic field names; Cursor reads its own fields or, when the
 *  CLI reports none, estimates tokens from `ctx` (documented approximate). MUST return a finite,
 *  non-negative `tokens`; MUST omit `cost` (leave undefined) rather than fabricate one. */
extractUsage(event: ResultEvent, ctx: UsageContext): AgentUsage;
```

Adding this to `HarnessProfile` means **every** profile object literal (`CLAUDE_PROFILE`, `CURSOR_PROFILE`,
and any test fixture profile) must supply it — a compile error otherwise, which is the desired guard.

`AgentUsage` (`{ tokens: number; cost?: number }` from `./executor`) is unchanged. **No `estimated` flag is
added** — it would ripple through the store column and both render paths for no user-visible gain (dollars
stay `n/a` for the estimate branch, so nothing misleading is surfaced; see §4).

---

## 2. Parser delegation (`src/agent/subprocess-executor.ts`)

### 2.1 `parseHarnessOutput` — delegate, with an optional `ctx`

```ts
export function parseHarnessOutput(
  stdout: string,
  profile: HarnessProfile = CLAUDE_PROFILE,
  ctx: UsageContext = { promptChars: 0 },
): AgentRunResult;
```

Body change — replace only the inline usage block (current lines ~480–483) with:

```ts
const usage = profile.extractUsage(event, ctx);
return { output: parseResultText(event.result ?? ''), usage };
```

Invariants:
- `ctx` is a **third optional parameter** with a default, so every existing call site —
  `parseHarnessOutput(stdout)` and `parseHarnessOutput(stdout, profile)` in tests and the archive spike —
  keeps compiling and behaving unchanged.
- The no-result-event throw (`'harness produced no result event'`) and the `is_error` →
  `classifyFailure(...)` path are untouched and run **before** `extractUsage` (an error result never reaches
  the extractor).
- `sumTokens` / `TOKEN_FIELDS` stay module-local (still used by `CLAUDE_PROFILE.extractUsage` and their
  existing unit tests). They are NOT deleted, NOT moved, NOT re-exported.

### 2.2 `CLAUDE_PROFILE.extractUsage` — today's logic, verbatim

```ts
extractUsage(event) {
  const usage: AgentUsage = { tokens: sumTokens(event.usage as Record<string, unknown> | undefined) };
  const cost = event.total_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost)) usage.cost = cost;
  return usage;
},
```

- MUST produce the **exact same** `AgentUsage` the current inline block produces for any Claude stream-json:
  `tokens = sum of the four TOKEN_FIELDS`, `cost = total_cost_usd` when finite, else `cost` omitted. This is
  the regression contract — asserted by the existing executor + contract suites and an added explicit test.
- Claude does not read `ctx`.
- Import `AgentUsage` from `./executor` if not already imported into this file.

### 2.3 `SubprocessStageExecutor.attempt` — build and pass `ctx`

`attempt(req, options)` (line ~339; it already holds `req`) computes the prompt size and threads it through
the success-path return (line ~345):

```ts
const promptChars = req.system.length + userPrompt(req.input).length;
return parseHarnessOutput(result.stdout, this.profile, { promptChars });
```

- `userPrompt` is already defined/exported in this file. `promptChars` mirrors the two pieces Claude joins
  via `--append-system-prompt` and Cursor folds into one prompt string — so the estimate tracks what was
  actually sent, for either harness.
- The error path (non-zero exit → `classifyFailure`) is unchanged.

---

## 3. Cursor usage extractor (`src/agent/cursor-profile.ts`)

Add `CURSOR_PROFILE.extractUsage` plus one exported pure helper. **A live `cursor-agent` probe (plan Step 1,
`RUN_REAL_CURSOR=1 npx vitest run archive/harness-cursor-spike/cursor-live-probe.test.ts`) MUST run first**
to pin the real field names; the fixture pasted into the new test comes from that probe. The extractor is a
**ladder** so it is correct-or-approximate regardless of what the probe finds (robust to a `cursor-agent`
version bump). If the probe cannot run (unauth/offline), ship the estimate branch as the safe default and
leave a `// TODO(probe)`.

### 3.1 `estimateTokensFromChars` — exported pure helper

```ts
/** Rough token estimate from a character count: `ceil(chars / CHARS_PER_TOKEN)`. `CHARS_PER_TOKEN = 4` is
 *  the standard coarse English heuristic. Only a *fallback* when Cursor reports no real token fields;
 *  documented approximate (plan §8.2/§9, agents-fsm#2). Never negative; `chars <= 0` → 0. */
export const CHARS_PER_TOKEN = 4;
export function estimateTokensFromChars(chars: number): number;
```

Contract: `estimateTokensFromChars(0) === 0`; negative input → `0`; otherwise `Math.ceil(chars / 4)`;
monotonic non-decreasing in `chars`.

### 3.2 `CURSOR_PROFILE.extractUsage(event, ctx): AgentUsage`

TOKENS ladder:
1. **Real fields.** If Cursor's result carries real token fields, sum them via a small **explicit**
   Cursor-specific field list (a `CURSOR_TOKEN_FIELDS`-style const mirroring how `sumTokens` names Claude's —
   never "sum every numeric field", so `duration_ms` / `duration_api_ms` can't inflate the count). Exact
   names and location (top-level vs a nested `usage` object) are pinned by the probe; if none found live,
   leave a `// TODO(probe)` marking the list provisional.
2. **Estimate fallback.** Otherwise:
   `tokens = estimateTokensFromChars(ctx.promptChars + (typeof event.result === 'string' ? event.result.length : 0))`.

COST:
- If Cursor reports a **real finite dollar** figure (field name pinned by the probe), set `usage.cost` to it.
- Otherwise **omit `cost`** (leave undefined). Do NOT synthesize dollars from the catalog's 1–4 UI tier
  (`cursor-models.json` `cost` is a relative tier, not $/token) — there is no honest price table.

Invariants:
- Returns a valid `AgentUsage`: finite non-negative `tokens`; `cost` either a finite number or absent.
- The estimate MUST be **non-zero for any non-empty prompt/result** and **roughly proportional** to
  `promptChars + resultChars`, so the `maxTokens` guard stops being a silent no-op.
- Pure (no I/O, no clock). Testable via both `CURSOR_PROFILE.extractUsage(event, ctx)` directly and
  `parseHarnessOutput(stdout, CURSOR_PROFILE, ctx)`.
- A code comment MUST label the estimate approximate, cite plan §8.2/§9 + agents-fsm#2, and record which
  decision-fork branch shipped (A real usage · B tokens-only · C estimate-only).

---

## 4. Render-side reconciliation (`dashboard/src/lib/render.ts`)

The harness side and the render side MUST agree about Cursor's cost visibility. Pick per the probe outcome
and assert the chosen branch in tests:

- **Branch A (probe finds a real Cursor dollar cost):** remove `'cursor'` from `COST_BLIND_HARNESSES` (it
  becomes empty) so `fmtRunCost` shows real dollars and `fleetStatsModel` / `repoLedgerModel` include Cursor
  spend. Update the doc comment.
- **Branch B/C (no real dollar cost — the likely case, no price table):** keep `'cursor'` in
  `COST_BLIND_HARNESSES`, but **rewrite its doc comment** so it no longer contradicts shipped behavior:
  Cursor now records real/estimated **tokens** (shown, non-zero, already ungated) but not a **dollar cost**
  (no per-token price to convert honestly), so the dollar figure stays a deliberate, documented `n/a`.

Do NOT change `tracksCost` / `fmtRunCost` signatures or the token columns — tokens are already summed
unconditionally (`r.tokensUsed ?? 0` in `telemetryModel` / `fleetStatsModel` / `repoLedgerModel` / rows), so
real/estimated tokens surface with **no** render code change; only the `COST_BLIND_HARNESSES` membership +
doc comment moves (branch A) or stays (branch B/C).

---

## 5. Data-flow invariants (end to end)

- `parseHarnessOutput` → `AgentRunResult.usage` → `runner.ts` reads `usage.tokens` / `usage.cost` and calls
  `repo.addRunUsage(run.id, { tokens, cost, agentRuns: 1 })` (unchanged). Non-zero `tokens` re-arms the
  `maxTokens` budget guard; a present `cost` re-arms the M8 B3 cost ceiling. This wiring is NOT modified — the
  fix is entirely upstream in what `usage` contains.
- Claude path: identical `AgentUsage` bytes as before (regression contract, §2.2).
- Cursor path: `tokens > 0` for any real invocation (real or estimated); `cost` present iff the CLI reported
  a real dollar figure.

---

## 6. Spike reconciliation (`archive/harness-cursor-spike/cursor-result-parsing.test.ts`)

The `DOCUMENTED GAP` case (currently asserting `parsed.usage.tokens === 0` / `parsed.usage.cost === undefined`)
is now false for the Cursor path. Update that case (do NOT delete — the file header says so) to describe the
shipped fix: with a `UsageContext`, `parseHarnessOutput(stdout, CURSOR_PROFILE, { promptChars })` yields
non-zero estimated tokens (and `cost` undefined for branch B/C). Keep it as living documentation that agrees
with shipped behavior. The other three spike cases (envelope parse, chatty/fenced recovery, error→HarnessError)
still call `parseHarnessOutput(stdout)` (Claude default) and remain valid unchanged.

---

## 7. Test surface the `tdd` stage writes against

- `estimateTokensFromChars(chars)` — pure: `0` at/below 0; `ceil(chars/4)`; monotonic.
- `CURSOR_PROFILE.extractUsage(event, ctx)` — real-field parse (if the probe found fields) → those tokens;
  a no-token-field event → non-zero estimate proportional to `promptChars + result.length`; the `cost`
  outcome per the shipped branch.
- `CLAUDE_PROFILE.extractUsage(event, ctx)` — sums the four `TOKEN_FIELDS`; reads finite `total_cost_usd`;
  omits `cost` when it is absent/non-finite (explicit Claude-regression assertion).
- `parseHarnessOutput(stdout, CURSOR_PROFILE, ctx)` against a realistic probe-derived stream-json sample →
  non-zero tokens; correct cost outcome.
- Render (`dashboard/src/lib/render.test.ts`): branch A → a `cursor` run shows a real `$` `costLabel` and is
  summed into `fleetStatsModel`/`repoLedgerModel`; branch B/C → `n/a` retained and tokens still surfaced
  non-zero.
- Existing executor + contract suites (`subprocess-executor.test.ts`, `executor-contract.test.ts`) stay green
  (Claude byte-for-byte). Full `npm test` + typecheck/lint green; working tree clean (no probe transcripts
  beyond the pasted fixture, no `dist`, no lockfile churn).
