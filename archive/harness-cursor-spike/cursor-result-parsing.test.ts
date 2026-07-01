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
 *   2. Cursor's result event carries NO `usage`/`total_cost_usd`, so token+cost accounting comes back
 *      zero/undefined. (→ the documented GAP: budget + M8 cost-ceiling guards go blind for Cursor.)
 *   3. A Cursor error result still classifies as a HarnessError. (→ error handling is reusable.)
 *
 * This is a throwaway spike kept as living documentation of the API-shape reconnaissance; it is not
 * part of the product. Do not delete — it records the evidence the design plan was built on.
 */

import { describe, expect, it } from 'vitest';

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

  it('DOCUMENTED GAP: Cursor result has no usage/cost → tokens 0, cost undefined', () => {
    const stdout = cursorStreamJson(JSON.stringify({ requestedTransition: 'proceed' }));

    const parsed = parseHarnessOutput(stdout);

    // This is the crux of the "cost accounting is blind" finding: the run-budget guard (maxTokens)
    // and the M8 B3 global cost ceiling both read these, so a Cursor harness needs a fallback
    // estimator or those guards silently no-op. The plan calls this out explicitly.
    expect(parsed.usage.tokens).toBe(0);
    expect(parsed.usage.cost).toBeUndefined();
  });

  it('classifies a Cursor error result as a HarnessError (error handling is reusable)', () => {
    const stdout = cursorStreamJson('the model could not complete the task', { isError: true });

    expect(() => parseHarnessOutput(stdout)).toThrow(HarnessError);
  });
});
