/**
 * ARCHIVE SPIKE — live Cursor CLI probe (see ./README.md).
 *
 * Unlike cursor-result-parsing.test.ts (which runs offline against Cursor's *documented* shapes), this
 * spawns the real `cursor-agent` and dumps the actual `--output-format stream-json` events, so we can
 * confirm the event families and the terminal `result` shape against a live binary. It AUTO-SKIPS when
 * `cursor-agent` is not on PATH (the default on this machine), so it never breaks `npm test`; run it on
 * a machine with the Cursor CLI installed and authenticated (`cursor-agent login`) to capture reality.
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

const HAS_CURSOR = cursorOnPath();

describe('Cursor harness — live CLI probe', () => {
  it.skipIf(!HAS_CURSOR)(
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
      // eslint-disable-next-line no-console
      console.log('[cursor-live-probe] event types:', types.join(', '));
      // eslint-disable-next-line no-console
      console.log('[cursor-live-probe] raw stdout:\n' + proc.stdout);

      // The existing (Claude Code) parser should read Cursor's terminal result event unchanged.
      const parsed = parseHarnessOutput(proc.stdout);
      // eslint-disable-next-line no-console
      console.log('[cursor-live-probe] parsed:', JSON.stringify(parsed));

      expect(types).toContain('result');
      expect(parsed.output).toEqual({ ok: true });
    },
    130_000,
  );

  it('documents how to run this probe when cursor-agent is absent', () => {
    if (!HAS_CURSOR) {
      // eslint-disable-next-line no-console
      console.log('[cursor-live-probe] SKIPPED — install + auth the Cursor CLI, then re-run: `cursor-agent login`');
    }
    expect(true).toBe(true);
  });
});
