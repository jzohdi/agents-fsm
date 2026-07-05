/**
 * ARCHIVE SPIKE — multi-harness / Cursor support (see ./README.md and plans/harness-abstraction.md).
 *
 * Purpose: prove which parts of the *existing* Claude Code subprocess executor can be reused verbatim
 * for a Cursor harness, and pin down exactly where the two diverge — WITHOUT `cursor-agent` installed.
 *
 * These tests feed the executor's pure `parseHarnessOutput` a stdout stream shaped like Cursor's
 * documented `--output-format stream-json` output (https://cursor.com/docs/cli/reference/output-format)
 * and assert:
 *   1. The terminal `type:"result"` event parsing is harness-agnostic — Cursor's result event flows
 *      through the same parser and yields the same structured envelope. (→ the parser is REUSABLE.)
 *   2. Cursor's result event carries NO `usage`/`total_cost_usd`. This was the documented GAP (budget +
 *      M8 cost-ceiling guards went blind for Cursor); it is now CLOSED (agents-fsm#2) by the harness-aware
 *      `CURSOR_PROFILE.extractUsage`, which estimates tokens from prompt+result length when the CLI reports
 *      none (cost stays undefined — no price table). The case below is updated to assert the shipped fix.
 *   3. A Cursor error result still classifies as a HarnessError. (→ error handling is reusable.)
 *
 * This is a throwaway spike kept as living documentation of the API-shape reconnaissance; it is not
 * part of the product. Do not delete — it records the evidence the design plan was built on.
 */

import { describe, expect, it } from 'vitest';

import { CURSOR_PROFILE, estimateTokensFromChars } from '../../src/agent/cursor-profile';
import { HarnessError, parseHarnessOutput } from '../../src/agent/subprocess-executor';

/**
 * A stdout stream shaped like `cursor-agent -p '<prompt>' --output-format stream-json`, per Cursor's
 * public docs. Note the event families mirror Claude Code's (system → assistant → result), and the
 * terminal event is `{ type:"result", subtype:"success", is_error, result, ... }` — but WITHOUT the
 * `usage` object or `total_cost_usd` field Claude Code includes.
 */
function cursorStreamJson(resultText: string, opts: { isError?: boolean } = {}): string {
  const lines = [
    { type: 'system', subtype: 'init', apiKeySource: 'CURSOR_API_KEY', cwd: '/repo', model: 'gpt-5', permissionMode: 'default' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it…' }] } },
    {
      type: 'result',
      subtype: opts.isError ? 'error' : 'success',
      duration_ms: 1234,
      duration_api_ms: 1000,
      is_error: opts.isError ?? false,
      result: resultText,
      session_id: '00000000-0000-0000-0000-000000000000',
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('Cursor harness — reuse of the existing stream-json result parser', () => {
  it('parses Cursor\'s result event into the same structured envelope (parser is harness-agnostic)', () => {
    // The agent is prompted to end with the JSON envelope; Cursor returns it as the `result` text.
    const envelope = { requestedTransition: 'proceed', flags: { needs_backend: true } };
    const stdout = cursorStreamJson(JSON.stringify(envelope));

    const parsed = parseHarnessOutput(stdout);

    expect(parsed.output).toEqual(envelope);
  });

  it('recovers the envelope even when Cursor wraps it in prose + a markdown fence', () => {
    // Cursor (like any model) may pad the final message. parseResultText already tolerates this.
    const envelope = { requestedTransition: 'approve' };
    const chatty = `Here is my decision:\n\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`\n`;
    const stdout = cursorStreamJson(chatty);

    expect(parseHarnessOutput(stdout).output).toEqual(envelope);
  });

  it('FIXED (agents-fsm#2): Cursor result has no usage → estimated non-zero tokens, cost undefined', () => {
    // This was the "cost accounting is blind" gap: the run-budget guard (maxTokens) and the M8 B3
    // global cost ceiling both read `usage`, and Cursor's result carries no Anthropic-style usage, so
    // both silently no-op'd. It is now closed by the harness-aware `CURSOR_PROFILE.extractUsage`: given
    // a `UsageContext`, the estimate fallback records tokens ~ (promptChars + result length) / 4, so the
    // token guard stops being a no-op. Cost stays undefined (no per-token price table to convert honestly
    // — a documented decision; dollars remain n/a for Cursor on the dashboard).
    const resultText = JSON.stringify({ requestedTransition: 'proceed' });
    const stdout = cursorStreamJson(resultText);
    const promptChars = 500;

    const parsed = parseHarnessOutput(stdout, CURSOR_PROFILE, { promptChars });

    expect(parsed.usage.tokens).toBe(estimateTokensFromChars(promptChars + resultText.length));
    expect(parsed.usage.tokens).toBeGreaterThan(0);
    expect(parsed.usage.cost).toBeUndefined();
  });

  it('classifies a Cursor error result as a HarnessError (error handling is reusable)', () => {
    const stdout = cursorStreamJson('the model could not complete the task', { isError: true });

    expect(() => parseHarnessOutput(stdout)).toThrow(HarnessError);
  });
});
