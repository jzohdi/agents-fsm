/**
 * Stage Executor contract tests (Milestone 3).
 *
 * Runs the shared contract suite against every executor implementation:
 *  - the in-memory `StubExecutor` (always),
 *  - the `SubprocessStageExecutor` over a *fake* harness (always) — this proves the real
 *    executor's parsing satisfies the same contract as the stub, fully offline,
 *  - the `SubprocessStageExecutor` over the *real* Claude Code CLI (only when
 *    `RUN_REAL_HARNESS=1`, since it needs the binary + an API key and costs tokens).
 *
 * Because all participants run the identical assertions, the stub cannot silently drift from
 * harness behavior (README Milestone 3).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StubExecutor } from './executor';
import { contractRequest, stageExecutorContract } from './executor-contract';
import { SubprocessStageExecutor, type ProcessResult, type SpawnProcess } from './subprocess-executor';

// 1. The in-memory stub: the canned handler simply returns the expected output.
stageExecutorContract({
  name: 'StubExecutor',
  setup(expected) {
    return {
      executor: new StubExecutor(() => ({ output: expected, tokens: 7 })),
      req: contractRequest(),
    };
  },
});

// 2. The subprocess executor over a fake harness: the fake spawn emits stream-json whose
//    final result message is `expected` as JSON, so the real parse path is exercised offline.
stageExecutorContract({
  name: 'SubprocessStageExecutor (fake harness)',
  setup(expected) {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: JSON.stringify(expected),
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
    ].join('\n');
    const spawnProcess: SpawnProcess = (): Promise<ProcessResult> => Promise.resolve({ code: 0, stdout, stderr: '' });
    return {
      executor: new SubprocessStageExecutor({ spawnProcess }),
      req: contractRequest(),
    };
  },
});

// 3. The subprocess executor over the real Claude Code CLI — opt-in, costs tokens.
const RUN_REAL = process.env.RUN_REAL_HARNESS === '1';
if (RUN_REAL) {
  stageExecutorContract({
    name: 'SubprocessStageExecutor (real Claude Code CLI)',
    setup(expected) {
      const workingDir = mkdtempSync(join(tmpdir(), 'agent-fleet-harness-'));
      return {
        executor: new SubprocessStageExecutor({ modelMap: { frontier: 'haiku' } }), // cheap model for the test
        req: contractRequest({
          workingDir,
          allowedTools: [], // no tools needed; the agent only emits JSON
          system: `Output exactly the following JSON and nothing else — no prose, no markdown fences: ${JSON.stringify(expected)}`,
        }),
      };
    },
  });
}
