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

import { isRateLimit, summarizeEvent, userPrompt, type HarnessProfile } from './subprocess-executor';

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
 * so this must map every one it emits or the logical name is passed to Cursor verbatim and rejected.
 * Confirm these ids against `cursor-agent --list-models` before a real run.
 */
export const CURSOR_MODEL_MAP: Record<string, string> = {
  frontier: 'sonnet-4.5',
  cheap: 'gpt-5',
};

/** Recognize Cursor's "not authenticated" wording (login required, missing/invalid key, unauthorized). */
export function isCursorAuthFailure(text: string): boolean {
  return /not logged in|logged out|unauthor(?:ized|ised)|not authenticated|invalid api key|cursor_api_key|please (?:run )?login/i.test(text);
}

/** The Cursor CLI profile — a second selectable harness alongside {@link CLAUDE_PROFILE}. */
export const CURSOR_PROFILE: HarnessProfile = {
  command: 'cursor-agent',
  modelMap: CURSOR_MODEL_MAP,
  buildArgs(req, model) {
    // Cursor has no --append-system-prompt: fold the system prompt into the single prompt string. No
    // --allowedTools (Cursor has none); -p grants write/shell and --force auto-approves so a headless
    // run can't stall on a permission prompt.
    const prompt = `${req.system}\n\n${userPrompt(req.input)}`;
    return ['-p', prompt, '--output-format', 'stream-json', '--force', '--model', model];
  },
  summarize: summarizeEvent, // provisional — Cursor's stream-json is the same family; refine via the live probe
  isAuthFailure: isCursorAuthFailure,
  isRateLimit, // 429/529/"rate limit"/"overloaded" wording is provider-agnostic enough to reuse
  authRemedy: CURSOR_AUTH_REMEDY,
  authFatal: false, // a Cursor auth failure escalates only its own runs (plan §8.1), never the whole drain
};
