/**
 * Cursor CLI harness profile (Layer 5 — the second harness behind the subprocess engine).
 *
 * Cursor ships a headless CLI (`cursor-agent -p … --output-format stream-json`) that, like Claude Code,
 * owns its own tool-use loop and emits a terminal `{ type:"result", is_error, result }` event — the same
 * family {@link parseHarnessOutput} already reads (proven offline by `archive/harness-cursor-spike/`). So
 * Cursor slots in as a {@link HarnessProfile}: the generic {@link SubprocessStageExecutor} (spawn, stream,
 * timeout, rate-limit retry, result parse) is unchanged; only these harness-specific bits differ.
 *
 * Three deliberate departures from Claude Code, each traceable to a documented Cursor gap (plan §4):
 *  - **No `--append-system-prompt`.** Cursor has no system-prompt flag, so the per-phase system prompt is
 *    folded into the single prompt string.
 *  - **No per-tool `--allowedTools`.** Cursor has no per-tool allow-list; `-p` grants write/shell and
 *    `--force` auto-approves so a headless run can't stall on a prompt. Review-stage read-only scoping is
 *    therefore not enforced by a flag under Cursor (accepted; plan §8.2).
 *  - **Auth is non-fatal.** An unauthenticated Cursor escalates only its own runs (needs_human), never the
 *    whole drain — so a mixed fleet keeps its Claude runs flowing (plan §8.1).
 *
 * Model ids and the exact live-activity event shapes should be confirmed against a real `cursor-agent`
 * (`cursor-agent --list-models`; `archive/harness-cursor-spike/cursor-live-probe.test.ts`) before relying
 * on them in production; the reused `summarizeEvent` is provisional (Cursor's stream-json is the same
 * family, and unknown events degrade to no activity — observability only, never affecting results).
 */

import type { AgentUsage } from './executor';
import {
  isRateLimit,
  summarizeEvent,
  userPrompt,
  type HarnessProfile,
  type ResultEvent,
  type UsageContext,
} from './subprocess-executor';

/** Operator instructions printed/logged when the spawned `cursor-agent` CLI is not authenticated. */
export const CURSOR_AUTH_REMEDY = [
  'The `cursor-agent` CLI the orchestrator spawns is not authenticated. Authenticate it, then re-run:',
  '',
  '  Fix:   cursor-agent login       (persists a login to disk)',
  '         — or —  export CURSOR_API_KEY=...',
  '  Test:  cursor-agent -p \'reply with {"ok":true}\' --output-format stream-json --force',
  '         → it should print a real result, not an authentication error.',
].join('\n');

/**
 * Logical → concrete Cursor model map (`--model` tags). The recipe uses logical names (`frontier`/`cheap`),
 * so this must map every one it emits or the logical name is passed to Cursor verbatim and rejected. Both
 * targets must stay listed in the catalog ({@link ./cursor-models.json}) — a drift guard enforces it.
 * Confirm these ids against `cursor-agent --list-models` before a real run.
 */
export const CURSOR_MODEL_MAP: Record<string, string> = {
  frontier: 'claude-4.5-sonnet',
  cheap: 'gpt-5-mini',
};

/** Recognize Cursor's "not authenticated" wording (login required, missing/invalid key, unauthorized). */
export function isCursorAuthFailure(text: string): boolean {
  return /not logged in|logged out|unauthor(?:ized|ised)|not authenticated|invalid api key|cursor_api_key|please (?:run )?login/i.test(text);
}

/**
 * Rough token estimate from a character count: `ceil(chars / CHARS_PER_TOKEN)`. `CHARS_PER_TOKEN = 4`
 * is the standard coarse English heuristic. This is only a **fallback** used when `cursor-agent` reports
 * no real token fields — a documented approximation (plan §8.2/§9, agents-fsm#2), never a claim of an
 * exact count. Never negative; `chars <= 0` → 0; monotonic non-decreasing in `chars`. Pure + exported so
 * it is directly unit-testable (the acceptance criteria's crux).
 */
export const CHARS_PER_TOKEN = 4;
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Cursor's own token fields, if a real `cursor-agent` reports them. Named **explicitly** (mirroring how
 * `sumTokens` names Claude's Anthropic fields) rather than "sum every numeric field", so a non-token
 * numeric like `duration_ms` / `duration_api_ms` can never silently inflate the count. The exact names
 * (and whether they sit top-level or nested under a `usage` object) are provisional until confirmed
 * against a live `cursor-agent` stream-json — see TODO(probe) in {@link CURSOR_PROFILE.extractUsage}.
 */
const CURSOR_TOKEN_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;

/** Cursor result fields that (if a real CLI reports one) carry a dollar cost. Provisional; see TODO(probe). */
const CURSOR_COST_FIELDS = ['total_cost_usd', 'cost_usd', 'request_cost_usd'] as const;

/** Sum the named numeric token fields off a candidate `usage`-like record; ignores absent/non-numeric. */
function sumCursorTokens(source: Record<string, unknown> | undefined): number {
  if (!source) return 0;
  let total = 0;
  for (const field of CURSOR_TOKEN_FIELDS) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/** First finite dollar figure among the named cost fields on a candidate record, or undefined. */
function findCursorCost(source: Record<string, unknown> | undefined): number | undefined {
  if (!source) return undefined;
  for (const field of CURSOR_COST_FIELDS) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Extract Cursor usage from its terminal `result` event — a **ladder** so it is correct-or-approximate
 * regardless of what a live `cursor-agent` emits (robust to a version bump):
 *
 *  - **Tokens.** If the result carries real Cursor token fields (top-level or nested under `usage`),
 *    sum them via the explicit {@link CURSOR_TOKEN_FIELDS} list. Otherwise **estimate** from
 *    `promptChars + result length` via {@link estimateTokensFromChars} — a documented `chars/4`
 *    approximation so the `maxTokens` budget guard stops being a silent no-op for Cursor.
 *  - **Cost.** Use a real finite dollar figure if the CLI reports one; otherwise **omit** `cost`. We do
 *    NOT synthesize dollars from the catalog's 1–4 UI tier (`cursor-models.json` `cost` is a relative
 *    tier, not $/token) — there is no honest price table (plan §8.2/§9, agents-fsm#2).
 *
 * SHIPPED BRANCH: **C (estimate-only)** — the live probe (`RUN_REAL_CURSOR=1 npx vitest run
 * archive/harness-cursor-spike/cursor-live-probe.test.ts`) is a real, paid, authenticated model call
 * that could not run in this sandbox, so the real-field names/location above are provisional.
 * TODO(probe): confirm `CURSOR_TOKEN_FIELDS` / `CURSOR_COST_FIELDS` (and nesting) against a real
 * `cursor-agent` result event; if it reports a real dollar cost, drop `'cursor'` from
 * `COST_BLIND_HARNESSES` in `dashboard/src/lib/render.ts` to match. The ladder already *prefers* real
 * fields, so pinning the names is the only follow-up — the estimate fallback is the safe default today.
 *
 * Pure (no I/O, no clock); directly testable via `CURSOR_PROFILE.extractUsage(event, ctx)` and
 * `parseHarnessOutput(stdout, CURSOR_PROFILE, ctx)`.
 */
function extractCursorUsage(event: ResultEvent, ctx: UsageContext): AgentUsage {
  const nested = typeof event.usage === 'object' && event.usage !== null ? (event.usage as Record<string, unknown>) : undefined;
  // Prefer real token fields (top-level or nested `usage`); fall back to the char estimate.
  const realTokens = sumCursorTokens(event as unknown as Record<string, unknown>) + sumCursorTokens(nested);
  const resultChars = typeof event.result === 'string' ? event.result.length : 0;
  const tokens = realTokens > 0 ? realTokens : estimateTokensFromChars(ctx.promptChars + resultChars);

  const usage: AgentUsage = { tokens };
  const cost = findCursorCost(event as unknown as Record<string, unknown>) ?? findCursorCost(nested);
  if (typeof cost === 'number' && Number.isFinite(cost)) usage.cost = cost;
  return usage;
}

/** The Cursor CLI profile — a second selectable harness alongside {@link CLAUDE_PROFILE}. */
export const CURSOR_PROFILE: HarnessProfile = {
  command: 'cursor-agent',
  modelMap: CURSOR_MODEL_MAP,
  buildArgs(req, model) {
    // Cursor has no --append-system-prompt: fold the system prompt into the single prompt string. No
    // --allowedTools (Cursor has none); -p grants write/shell and --force auto-approves so a headless
    // run can't stall on a permission prompt. `req.effort` is intentionally ignored: cursor-agent has no
    // reasoning-effort flag, and its model-suffix scheme is documented but ignored by the CLI today
    // (README §9.8) — so Cursor models advertise no efforts and this never receives one.
    const prompt = `${req.system}\n\n${userPrompt(req.input)}`;
    return ['-p', prompt, '--output-format', 'stream-json', '--force', '--model', model];
  },
  summarize: summarizeEvent, // provisional — Cursor's stream-json is the same family; refine via the live probe
  isAuthFailure: isCursorAuthFailure,
  isRateLimit, // 429/529/"rate limit"/"overloaded" wording is provider-agnostic enough to reuse
  extractUsage: extractCursorUsage,
  authRemedy: CURSOR_AUTH_REMEDY,
  authFatal: false, // a Cursor auth failure escalates only its own runs (plan §8.1), never the whole drain
};
