/**
 * Cursor harness usage-extraction tests (agents-fsm#2 — "Cursor token & cost counts are always 0 / n/a").
 *
 * These pin the new harness-aware usage seam: token/cost extraction moves out of the shared parser and
 * behind each `HarnessProfile.extractUsage`, so a Cursor run records **non-zero** per-stage tokens (real
 * if the CLI reports them, otherwise a documented `chars/4` estimate) while Claude Code stays
 * **byte-for-byte** unchanged. All offline — the extractor is pure and directly testable, which is the
 * acceptance criteria's crux. Grounded in `.agent/interface.md` §1–3, §7.
 *
 * Written by the `tdd` stage: these are expected to be RED until the implementation stage adds
 * `estimateTokensFromChars` + `CURSOR_PROFILE.extractUsage` + `CLAUDE_PROFILE.extractUsage` and makes
 * `parseHarnessOutput` delegate to the profile.
 */

import { describe, expect, it } from 'vitest';

import { CHARS_PER_TOKEN, CURSOR_PROFILE, estimateTokensFromChars } from './cursor-profile';
import { CLAUDE_PROFILE, parseHarnessOutput } from './subprocess-executor';

/** A `UsageContext` for the estimate fallback (only the prompt size is passed in; §1.2). */
function ctx(promptChars: number): { promptChars: number } {
  return { promptChars };
}

/** A terminal `result` event as an untyped record; individual tests set only the fields they exercise. */
function resultEvent(fields: Record<string, unknown> = {}): any {
  return { type: 'result', subtype: 'success', is_error: false, result: '', ...fields };
}

/**
 * A stdout stream shaped like `cursor-agent … --output-format stream-json`, whose terminal `result`
 * event carries NO Anthropic-style `usage`/`total_cost_usd` (the documented Cursor gap). `extra` lets a
 * test add Cursor's own top-level fields (e.g. `duration_ms`).
 */
function cursorStreamJson(resultText: string, extra: Record<string, unknown> = {}): string {
  return [
    { type: 'system', subtype: 'init', apiKeySource: 'CURSOR_API_KEY', model: 'gpt-5' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it…' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: resultText, ...extra },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
}

// --- estimateTokensFromChars (pure helper, §3.1) --------------------------------

describe('estimateTokensFromChars — the fallback token estimate', () => {
  it('exposes CHARS_PER_TOKEN = 4 (the coarse English heuristic)', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  it('is 0 at or below 0 chars (never negative)', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(-1)).toBe(0);
    expect(estimateTokensFromChars(-1000)).toBe(0);
  });

  it('is ceil(chars / 4)', () => {
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(400)).toBe(100);
    expect(estimateTokensFromChars(401)).toBe(101);
  });

  it('is monotonic non-decreasing in chars', () => {
    let prev = estimateTokensFromChars(0);
    for (let chars = 1; chars <= 5000; chars += 137) {
      const now = estimateTokensFromChars(chars);
      expect(now).toBeGreaterThanOrEqual(prev);
      prev = now;
    }
  });
});

// --- CURSOR_PROFILE.extractUsage (§3.2) -----------------------------------------

describe('CURSOR_PROFILE.extractUsage — estimate fallback when the CLI reports no usage', () => {
  it('estimates tokens from promptChars + result length when no real token fields are present', () => {
    const result = 'X'.repeat(40);
    const usage = CURSOR_PROFILE.extractUsage(resultEvent({ result }), ctx(360));
    // 360 prompt chars + 40 result chars = 400 chars → ceil(400/4) = 100 tokens.
    expect(usage.tokens).toBe(estimateTokensFromChars(360 + 40));
    expect(usage.tokens).toBe(100);
  });

  it('yields NON-ZERO tokens for any non-empty prompt (the maxTokens guard stops being a silent no-op)', () => {
    const usage = CURSOR_PROFILE.extractUsage(resultEvent({ result: '' }), ctx(100));
    expect(usage.tokens).toBeGreaterThan(0);
    expect(usage.tokens).toBe(estimateTokensFromChars(100));
  });

  it('is roughly proportional to prompt + result size (a bigger phase estimates more tokens)', () => {
    const small = CURSOR_PROFILE.extractUsage(resultEvent({ result: 'hi' }), ctx(40));
    const big = CURSOR_PROFILE.extractUsage(resultEvent({ result: 'x'.repeat(4000) }), ctx(4000));
    expect(big.tokens).toBeGreaterThan(small.tokens);
  });

  it('does NOT inflate the estimate from non-token numeric fields (e.g. duration_ms)', () => {
    // A large duration must not leak into the token count; the estimate depends only on text length.
    const withDuration = CURSOR_PROFILE.extractUsage(
      resultEvent({ result: 'abcd', duration_ms: 9_999_999, duration_api_ms: 5_000_000 }),
      ctx(0),
    );
    expect(withDuration.tokens).toBe(estimateTokensFromChars('abcd'.length));
  });

  it('omits cost when the event carries no dollar figure (no price table → never fabricate dollars)', () => {
    const usage = CURSOR_PROFILE.extractUsage(resultEvent({ result: 'some output' }), ctx(200));
    expect(usage.cost).toBeUndefined();
  });

  it('returns a valid AgentUsage: finite, non-negative tokens', () => {
    const usage = CURSOR_PROFILE.extractUsage(resultEvent({ result: 'work' }), ctx(80));
    expect(Number.isFinite(usage.tokens)).toBe(true);
    expect(usage.tokens).toBeGreaterThanOrEqual(0);
  });
});

// --- CLAUDE_PROFILE.extractUsage (regression: Anthropic field names, §2.2) ------

describe('CLAUDE_PROFILE.extractUsage — Claude Code accounting is unchanged', () => {
  it('sums the four Anthropic TOKEN_FIELDS', () => {
    const event = resultEvent({
      result: '{}',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
    });
    expect(CLAUDE_PROFILE.extractUsage(event, ctx(0)).tokens).toBe(20);
  });

  it('ignores non-token numeric usage fields (only the known token fields count)', () => {
    const event = resultEvent({
      result: '{}',
      usage: { input_tokens: 10, output_tokens: 5, web_search_requests: 99, duration_ms: 1234 },
    });
    expect(CLAUDE_PROFILE.extractUsage(event, ctx(0)).tokens).toBe(15);
  });

  it('reads a finite total_cost_usd, and omits cost when absent or non-finite', () => {
    const withCost = resultEvent({ result: '{}', usage: { input_tokens: 1 }, total_cost_usd: 0.0123 });
    expect(CLAUDE_PROFILE.extractUsage(withCost, ctx(0)).cost).toBe(0.0123);

    const noCost = resultEvent({ result: '{}', usage: { input_tokens: 1 } });
    expect(CLAUDE_PROFILE.extractUsage(noCost, ctx(0)).cost).toBeUndefined();

    const badCost = resultEvent({ result: '{}', usage: { input_tokens: 1 }, total_cost_usd: Infinity });
    expect(CLAUDE_PROFILE.extractUsage(badCost, ctx(0)).cost).toBeUndefined();
  });

  it('does NOT estimate from ctx — Claude reports its own tokens or reports zero (never the fallback)', () => {
    // No usage object present: Claude sums absent fields to 0 and must NOT fall back to the char estimate,
    // even with a large promptChars. The estimate path is Cursor-only.
    const event = resultEvent({ result: 'a very long result string that would estimate high' });
    expect(CLAUDE_PROFILE.extractUsage(event, ctx(100_000)).tokens).toBe(0);
  });
});

// --- parseHarnessOutput delegates to the profile's extractUsage (§2.1) ----------

describe('parseHarnessOutput — usage extraction is delegated to the harness profile', () => {
  it('Cursor path: with a UsageContext, yields non-zero estimated tokens and no cost', () => {
    const resultText = JSON.stringify({ requestedTransition: 'proceed' });
    const stdout = cursorStreamJson(resultText);

    const parsed = parseHarnessOutput(stdout, CURSOR_PROFILE, ctx(320));

    expect(parsed.output).toEqual({ requestedTransition: 'proceed' });
    expect(parsed.usage.tokens).toBe(estimateTokensFromChars(320 + resultText.length));
    expect(parsed.usage.tokens).toBeGreaterThan(0);
    expect(parsed.usage.cost).toBeUndefined();
  });

  it('Claude path (default profile): still sums Anthropic usage byte-for-byte', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '{"ok":true}',
        usage: { input_tokens: 100, output_tokens: 20 },
        total_cost_usd: 0.005,
      }),
    ].join('\n');

    const parsed = parseHarnessOutput(stdout);

    expect(parsed.output).toEqual({ ok: true });
    expect(parsed.usage.tokens).toBe(120);
    expect(parsed.usage.cost).toBe(0.005);
  });

  it('keeps ctx optional so existing 1-arg / 2-arg call sites are unaffected', () => {
    const stdout = cursorStreamJson(JSON.stringify({ requestedTransition: 'approve' }));

    // No ctx → the estimate defaults to promptChars 0, but the result text alone still yields tokens > 0.
    expect(parseHarnessOutput(stdout, CURSOR_PROFILE).output).toEqual({ requestedTransition: 'approve' });
    // Claude default profile with no ctx behaves exactly as before.
    const claudeStdout = JSON.stringify({ type: 'result', result: '{"v":1}', usage: { input_tokens: 5 } });
    expect(parseHarnessOutput(claudeStdout).usage.tokens).toBe(5);
  });
});
