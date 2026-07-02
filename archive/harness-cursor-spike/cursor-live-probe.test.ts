/**
 * ARCHIVE SPIKE — live Cursor CLI probe (see ./README.md).
 *
 * Unlike cursor-result-parsing.test.ts (which runs offline against Cursor's *documented* shapes), this
 * spawns the real `cursor-agent` and dumps the actual `--output-format stream-json` events, so we can
 * confirm the event families and the terminal `result` shape against a live binary. It runs only under
 * `RUN_REAL_CURSOR=1` (the `RUN_REAL_HARNESS`/`RUN_REAL_GITHUB` convention) *and* with `cursor-agent`
 * on PATH — it originally auto-ran whenever the binary was present, which silently made the default
 * `npm test` spend a live, authenticated model call once the multi-harness work installed Cursor here.
 * The default suite must stay hermetic (README §3.3 "Built for fakes"): zero network, zero cost.
 *
 * It intentionally makes a real, minimal call ("reply with {\"ok\":true}") — cheap, read-only, no repo
 * mutation — and prints every event's `type` plus the parsed terminal result. Keep the output in the
 * PR/commit as the evidence for the plan's "Cursor stream-json matches Claude Code's families" claim.
 */

import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { parseHarnessOutput } from '../../src/agent/subprocess-executor';

function cursorOnPath(): boolean {
  const which = spawnSync('which', ['cursor-agent'], { encoding: 'utf8' });
  return which.status === 0 && which.stdout.trim() !== '';
}

// Flag first so the default suite never even spawns `which`; binary presence is the secondary check.
const ENABLED = process.env.RUN_REAL_CURSOR === '1' && cursorOnPath();

describe('Cursor harness — live CLI probe', () => {
  it.skipIf(!ENABLED)(
    'emits stream-json events with a terminal result our parser can read',
    () => {
      const args = [
        '-p',
        'reply with the exact JSON {"ok":true} and nothing else',
        '--output-format',
        'stream-json',
        '--force', // print mode grants write/shell; --force auto-approves so it can't stall on a prompt
      ];
      const proc = spawnSync('cursor-agent', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });

      // Dump the raw event types so the archive records the real families (system/assistant/tool*/result).
      const types = proc.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return (JSON.parse(l) as { type?: string }).type ?? '(no type)';
          } catch {
            return '(non-json)';
          }
        });
      console.log('[cursor-live-probe] event types:', types.join(', '));
      console.log('[cursor-live-probe] raw stdout:\n' + proc.stdout);

      // The existing (Claude Code) parser should read Cursor's terminal result event unchanged.
      const parsed = parseHarnessOutput(proc.stdout);
      console.log('[cursor-live-probe] parsed:', JSON.stringify(parsed));

      expect(types).toContain('result');
      expect(parsed.output).toEqual({ ok: true });
    },
    130_000,
  );

  it('documents how to run this probe when it is disabled', () => {
    if (!ENABLED) {
      console.log('[cursor-live-probe] SKIPPED — install + auth the Cursor CLI (`cursor-agent login`), then run with RUN_REAL_CURSOR=1');
    }
    expect(true).toBe(true);
  });
});
