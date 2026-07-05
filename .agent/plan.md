# Plan — Cursor harness token & cost counts are always 0 / n/a (agents-fsm#2)

## Goal (restated)

Cursor-harness runs never accumulate usage: every stage records `0` tokens, so per-stage and total
cost render as `n/a`. This silently no-ops the run-budget guard (`maxTokens`) and the M8 B3 global
cost ceiling for Cursor runs, and hides real spend on the dashboard.

Fix it by making usage extraction **harness-aware** instead of hard-coding Anthropic field names in
the shared parser, so Cursor records non-zero per-stage token usage (real if the CLI reports it,
otherwise a documented estimate) that accumulates across stages — while keeping Claude Code's
token/cost accounting **byte-for-byte unchanged**. Keep the harness side and the dashboard render
side in agreement about whether Cursor shows dollars or a documented `n/a`.

## How it works today (grounding)

- `src/agent/subprocess-executor.ts` → `parseHarnessOutput(stdout, profile)` scans the harness's
  newline-delimited stream-json for the terminal `type:"result"` event and builds
  `AgentRunResult.usage`:
  - `usage.tokens = sumTokens(event.usage)` — `sumTokens` sums only the four Anthropic
    `TOKEN_FIELDS` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
    `cache_read_input_tokens`) off `event.usage`.
  - `usage.cost = event.total_cost_usd` when finite.
  - `ResultEvent` is typed to exactly the Claude-Code shape (`usage`, `total_cost_usd`).
  These field names are **Claude-Code-specific**, so anything Cursor reports under different names
  (or a different event) is ignored → `tokens: 0`, `cost: undefined`.
- The extraction is **not** delegated to the `HarnessProfile` (unlike `buildArgs` / `summarize` /
  `isAuthFailure` / `isRateLimit` / `authRemedy` / `authFatal`) — it is the one remaining
  harness-specific concern still hard-coded in the shared parser.
- `src/agent/cursor-profile.ts` → `CURSOR_PROFILE` has no usage extractor.
- `src/agent/runner.ts` reads `result.usage.tokens` / `result.usage.cost` and calls
  `repo.addRunUsage(run.id, { tokens, cost, agentRuns: 1 })` (~lines 596/600 and 738/742), which
  accumulates `runs.tokens_used` / `runs.cost_used`. The budget guard (`maxTokens`) reads the
  accumulated tokens; the M8 B3 cost ceiling reads the accumulated cost. So: **non-zero
  `usage.tokens` re-arms the token guard; a present `usage.cost` re-arms the cost ceiling.**
- `dashboard/src/lib/render.ts`:
  - `COST_BLIND_HARNESSES = new Set(['cursor'])`; `tracksCost(harness)` = `!COST_BLIND_HARNESSES.has`.
  - `fmtRunCost(harness, costUsed, digits)` returns `$…` when `tracksCost`, else `'n/a'`.
  - Aggregations (`summarizeRuns`, per-repo rows) only add `costUsed` into totals `if
    (tracksCost(r.harness))`. **Tokens are shown/summed unconditionally** (`r.tokensUsed ?? 0`) — they
    are *not* gated by `COST_BLIND_HARNESSES`. So recording real/estimated tokens makes the token
    columns non-zero with **no** render change; only the *dollar* display is gated.
- The archived spike `archive/harness-cursor-spike/cursor-result-parsing.test.ts` asserts the current
  gap (`tokens === 0`, `cost === undefined`) against a **documented** (not live) Cursor stream-json
  sample whose `result` event carries no `usage`/`total_cost_usd`. `plans/harness-abstraction.md`
  §8.2/§9 lists "Cursor cost estimation" as a deliberate deferral.

### Central unknown — must be resolved by a live probe first

The correct extractor body depends on **what a real `cursor-agent` actually emits**, which the
codebase has only ever assumed from docs. `cursor-agent` **is installed** on this machine
(`~/.local/bin/cursor-agent`, version 2026.07.01), and
`archive/harness-cursor-spike/cursor-live-probe.test.ts` already exists to dump real events — but it
is gated behind `RUN_REAL_CURSOR=1` (a real, paid, authenticated model call) and the sandbox blocks
spawning it during planning. **The implementation stage must run the probe before finalizing the
Cursor extractor** (see Step 1). The architecture below is identical either way; only the extractor's
field list / fallback path changes.

Note: the repo has **no real per-token price table**. The model catalogs' `cost` field
(`src/agent/harness-models.ts`, `cursor-models.json`) is a **relative 1–4 UI tier** (rendered as
dollar signs), *not* USD-per-token. So an honest *dollar* figure is only possible if the CLI itself
reports one; we will **not** fabricate dollars from a tier.

## Approach

Add a per-profile **usage extractor** to `HarnessProfile` (alongside `summarize`/`isAuthFailure`),
and have `parseHarnessOutput` delegate to it. Claude's extractor is the current logic verbatim;
Cursor's parses real usage when present and otherwise records a clearly-approximate token estimate.
Keep the two cost-blindness sides (harness accounting ↔ dashboard render) consistent with whatever
the probe shows Cursor can actually report. No FSM/store-schema changes.

### Step 1 — Probe the real `cursor-agent` (investigation; drives the decision)

Run the existing live probe on this machine and capture the real terminal `result` (and `assistant`)
event shape:

```
RUN_REAL_CURSOR=1 npx vitest run archive/harness-cursor-spike/cursor-live-probe.test.ts
```

Inspect the dumped raw stdout for any usage/token/cost fields on the `result` event (and assistant
events) — e.g. `usage`, `tokens`, `input_tokens`/`output_tokens`, `total_tokens`, `token_count`,
`cost`, `total_cost_usd`, `request_cost`, `usdCost`, plus the already-present `duration_ms` /
`duration_api_ms`. Record the finding (paste the real event into the new test as the fixture, and
note it in a code comment). Then pick the branch below. If the probe cannot be run (unauthenticated
/ offline), proceed with the **estimate** branch as the safe default and leave a `// TODO(probe)`
noting the field list is provisional.

**Decision fork (record which one shipped, in code comments + the PR description):**

- **A. Cursor reports usage (tokens and/or cost).** Parse the real fields into `usage.tokens`
  (and `usage.cost` if a real dollar figure is present). Best outcome.
- **B. Cursor reports tokens but no dollar cost.** Record real tokens; leave `usage.cost` undefined
  (no price table to convert honestly — documented). Token guard re-armed; dollars stay `n/a`.
- **C. Cursor reports nothing usable.** Estimate tokens from prompt + result **text length**
  (documented approximation); `usage.cost` undefined. Token guard becomes roughly proportional
  instead of a silent no-op; dollars stay `n/a`.

**Recommended default if the probe is inconclusive:** implement one code path that *prefers* real
fields (A/B) and *falls back* to the estimate (C) — correct-or-approximate regardless, and robust to
a `cursor-agent` version bump.

### Step 2 — Add a harness-aware usage extractor seam (`subprocess-executor.ts`)

1. **Widen `ResultEvent`** from the Claude-only shape to a generic parsed result: keep the fields the
   *parser itself* needs (`type: 'result'`, `is_error?`, `result?`) and add an index signature
   (`[key: string]: unknown`) so a profile's extractor can read harness-specific fields
   (`usage`, `total_cost_usd`, `duration_ms`, Cursor's own names) without the shared type naming them.

2. **Add `extractUsage` to `HarnessProfile`:**
   ```ts
   /** Extract token usage (+ dollar cost, if this harness reports one) from its terminal result
    *  event. Harness-specific: Claude reads Anthropic field names; Cursor reads its own or estimates. */
   extractUsage(event: ResultEvent, ctx: UsageContext): AgentUsage;
   ```
   with a small context for the estimate fallback:
   ```ts
   /** Inputs a profile may use to *estimate* usage when the harness reports none. */
   export interface UsageContext {
     /** Character length of the prompt sent this phase (system + input); the estimate's main input. */
     promptChars: number;
   }
   ```
   (`resultChars` is derivable from `event.result`, so it need not be in the context.)

3. **`parseHarnessOutput(stdout, profile, ctx?)`** delegates:
   ```ts
   const usage = profile.extractUsage(event, ctx ?? { promptChars: 0 });
   return { output: parseResultText(event.result ?? ''), usage };
   ```
   `ctx` is an **optional third parameter** so every existing call site — `parseHarnessOutput(stdout)`
   and `parseHarnessOutput(stdout, profile)` in tests and the spike — keeps compiling unchanged.

4. **`SubprocessStageExecutor.attempt`** builds the context from the request it already holds and
   passes it through:
   ```ts
   const promptChars = req.system.length + userPrompt(req.input).length;
   return parseHarnessOutput(result.stdout, this.profile, { promptChars });
   ```

5. **`CLAUDE_PROFILE.extractUsage`** = today's logic verbatim, so Claude output is byte-for-byte
   identical: `{ tokens: sumTokens(event.usage), ...(finite total_cost_usd ? { cost } : {}) }`.
   Keep `sumTokens` and `TOKEN_FIELDS` (still exported for their existing unit tests) — Claude's
   extractor calls them. The Anthropic field names leave the shared parser and live behind the Claude
   profile, which is their only meaning.

### Step 3 — Cursor usage extractor (`cursor-profile.ts`)

Add `CURSOR_PROFILE.extractUsage` implementing the fallback ladder (exact real-field names pinned by
the Step-1 probe):

- **Tokens:** if Cursor's result carries real token fields, sum them via a small **explicit**
  Cursor-specific field list (mirroring how `sumTokens` names Claude's — never "sum every numeric
  field", so a `duration_ms` can't inflate the count). Otherwise **estimate**:
  `tokens = ceil((promptChars + (event.result ?? '').length) / CHARS_PER_TOKEN)` with
  `CHARS_PER_TOKEN = 4` (the standard rough English heuristic). Factor the estimate into a tiny pure
  exported helper (`estimateTokensFromChars`) so it is directly unit-testable.
- **Cost:** if Cursor reports a real finite dollar figure, use it. Otherwise leave `usage.cost`
  undefined — **do not** synthesize dollars from the 1–4 tier (documented).
- Document the estimate as approximate in a code comment referencing plan §8.2/§9 and this issue.

Keep the extractor **pure and exported-testable** (it is the crux the acceptance criteria call out).

**Labeling the estimate as approximate:** `AgentUsage` today is `{ tokens; cost? }` with no
"estimated" flag, and adding one would ripple through the store column and both dashboard render
paths. **Recommendation:** do not add a schema flag. Since dollars stay `n/a` for the estimate
branches (B/C), nothing misleading is surfaced; note "approximate token estimate" in the
`COST_BLIND_HARNESSES` doc comment / harness-badge tooltip rather than per-number. Only if branch A
yields a *real* dollar figure do we show dollars (real, not estimated), so no "~" is ever needed. (If
a reviewer insists on an estimated *dollar* figure, that requires a real price table — out of scope;
call it out rather than fabricate one.)

### Step 4 — Keep the render side in sync (`dashboard/src/lib/render.ts`)

Match the render side to the probe outcome so harness accounting and dashboard agree:

- **If Cursor now yields a real dollar cost (branch A with cost):** remove `'cursor'` from
  `COST_BLIND_HARNESSES` (leaving it empty, or removing the mechanism if nothing else is blind) so
  `fmtRunCost` shows real dollars and aggregations include Cursor spend. Update the doc comment.
- **If cost stays `n/a` (branches B/C — the likely case given no price table):** keep `'cursor'` in
  `COST_BLIND_HARNESSES`, but **rewrite its doc comment** so the two sides no longer contradict
  shipped behavior: Cursor now records real/estimated **tokens** (shown, non-zero) but not a **dollar
  cost** (no per-token price to convert honestly), so the dollar figure stays a deliberate,
  documented `n/a`. Tokens need no render change (already ungated).

Whichever branch ships, the harness extractor and the render classification must state the **same**
thing about Cursor's cost visibility — assert it in tests.

### Step 5 — Tests & spike reconciliation

- **New Cursor usage parsing tests** (extend `src/agent/cursor-profile.test.ts`, or a focused new
  file): drive `CURSOR_PROFILE.extractUsage` / `parseHarnessOutput(stdout, CURSOR_PROFILE, ctx)`
  against a **realistic `cursor-agent` stream-json sample** (from the Step-1 probe). Cover: real-usage
  parsing (if the probe found fields), the estimate fallback (non-zero, roughly proportional to
  prompt+result length), and the cost outcome (real dollars, or `undefined`/n/a per the decision).
  The parser is pure → directly testable, as the acceptance criteria require.
- **Claude regression:** existing `subprocess-executor.test.ts` + `executor-contract.test.ts` prove
  the extractor refactor is behavior-preserving (byte-for-byte Claude usage). Add an explicit
  assertion that `CLAUDE_PROFILE.extractUsage` still sums `TOKEN_FIELDS` and reads `total_cost_usd`.
- **Reconcile the archive spike** so it no longer contradicts shipped behavior: the
  `cursor-result-parsing.test.ts` case asserting `tokens === 0` / `cost === undefined` is now false
  for the real/estimate path. Update that spike's "DOCUMENTED GAP" case to describe the fix (preferred
  — keep it as living documentation) rather than delete it (the file header says "do not delete").
- **Dashboard render tests** (`dashboard/src/lib/render.test.ts`): if branch A, add coverage that a
  `cursor` run now shows a real dollar `costLabel` (not `n/a`) and is summed; if branch B/C, keep the
  `n/a` coverage and assert tokens are still surfaced.
- Full suite (`npm test`) + typecheck stays green.

## Files to change

| Area | File | Change |
| --- | --- | --- |
| Executor seam | `src/agent/subprocess-executor.ts` | Widen `ResultEvent`; add `extractUsage` + `UsageContext` to `HarnessProfile`; `parseHarnessOutput` delegates (+ optional `ctx`); `attempt` passes `promptChars`; `CLAUDE_PROFILE.extractUsage` = current logic; keep `sumTokens`/`TOKEN_FIELDS`. |
| Cursor profile | `src/agent/cursor-profile.ts` | Add `CURSOR_PROFILE.extractUsage` (real fields → estimate fallback) + `estimateTokensFromChars` helper. |
| Dashboard render | `dashboard/src/lib/render.ts` | Reconcile `COST_BLIND_HARNESSES` / its doc comment with the decision (drop `cursor` if real dollars; else document tokens-tracked / cost-n/a). |
| Tests | `src/agent/cursor-profile.test.ts` (or new), `src/agent/subprocess-executor.test.ts`, `dashboard/src/lib/render.test.ts` | New Cursor usage tests + Claude regression + render coverage. |
| Spike | `archive/harness-cursor-spike/cursor-result-parsing.test.ts` | Update the "DOCUMENTED GAP" case so it no longer contradicts shipped behavior. |
| Probe (investigation) | `archive/harness-cursor-spike/cursor-live-probe.test.ts` | Run under `RUN_REAL_CURSOR=1` to capture the real event shape; paste fixture into the new test (do not commit raw transcripts). |
| Docs (optional) | `plans/harness-abstraction.md` §8.2/§9 | Note the §9 "Cursor cost estimation" deferral is now (partly) addressed. |

## Risks & edge cases

- **Unknown real Cursor field names.** The whole fork hinges on the probe. Mitigation: the extractor
  *prefers* real fields and *falls back* to the estimate, so it is correct-or-approximate regardless,
  and robust to a `cursor-agent` version bump. Pin the fixture from a real probe run.
- **Claude regression.** The refactor moves Anthropic field names behind `CLAUDE_PROFILE` but must
  not change output. Mitigation: reuse `sumTokens`/`TOKEN_FIELDS` unchanged; the existing executor +
  contract suites are the guard; add an explicit Claude-usage assertion.
- **Estimate accuracy / honesty.** `chars/4` is coarse and English-biased. Mitigation: it is only a
  fallback, clearly labeled approximate, and only *tokens* (not fabricated dollars) are surfaced — so
  the token guard stops being a silent no-op without pretending to be exact.
- **No price table for dollars.** The catalog `cost` is a 1–4 tier, not $/token. Mitigation: only
  show dollars when the CLI reports a real figure; otherwise a documented `n/a` (explicitly permitted
  by the acceptance criteria).
- **Harness/render drift.** The two sides could disagree about cost visibility. Mitigation: Step 4
  ties the render classification to the same decision the extractor implements, asserted in tests.
- **Clean tree.** The live probe must not leave artifacts or dependency churn; only intended source +
  test changes are committed. Do not commit real probe transcripts beyond the pasted test fixture.

## How the result is tested

- Unit: pure `CURSOR_PROFILE.extractUsage` / `estimateTokensFromChars` against a realistic
  stream-json sample → non-zero tokens (real or estimated), correct cost outcome.
- Regression: Claude usage byte-for-byte via existing executor + contract suites.
- Integration signal: a Cursor run's per-stage `usage.tokens` accumulates into `runs.tokens_used`
  (via `addRunUsage`), re-arming the `maxTokens` guard; the cost ceiling re-arms iff real dollars are
  reported.
- Dashboard: `render.test.ts` covers the chosen cost display (real `$…` or documented `n/a`).
- Full `npm test` + typecheck green; archive spike updated to agree with shipped behavior.

## Scope flags

- `needs_backend: true` — the extractor seam, Cursor profile extractor, and their unit tests
  (`src/agent/**`) are the core of the change.
- `needs_frontend: true` — `dashboard/src/lib/render.ts` (+ `render.test.ts`) must be reconciled so
  the dashboard's cost display agrees with the new harness accounting.
