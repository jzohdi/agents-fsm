/**
 * End-to-end integration of the real Stage Executor with the full pipeline (Milestone 3).
 *
 * Drives the Event Loop with the *real* `SubprocessStageExecutor` (not the stub), backed by a
 * fake harness process, and asserts a run advances start → `done`. This proves the seam the
 * subprocess executor sits behind composes correctly through every layer — loop → Agent Runner
 * → executor argv → stream-json parse → envelope validation → FSM engine — entirely offline.
 *
 * Milestone 4 wires this same executor into the loop against the real CLI; this test de-risks
 * that wiring with zero network calls.
 */

import { describe, expect, it } from 'vitest';

import { goldenPathHandler, type AgentRunRequest } from '../agent/executor';
import { AgentRunner } from '../agent/runner';
import { SubprocessStageExecutor, type ProcessResult, type SpawnProcess } from '../agent/subprocess-executor';
import { loadDefaultConfig } from '../fsm/config';
import { EventLoop } from '../loop/event-loop';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { FakeGitHub } from './github-fake';

/**
 * A fake harness: it decodes the structured input the Agent Runner JSON-encoded into the `-p`
 * prompt, asks the shared golden-path handler what this stage/phase should emit, and returns it
 * as a Claude Code stream-json result event — exactly what the real CLI would print.
 */
const goldenPathSpawn: SpawnProcess = (_command, args): Promise<ProcessResult> => {
  const prompt = args[args.indexOf('-p') + 1]!;
  const input = JSON.parse(prompt) as { stage: string; phase: string };
  const reply = goldenPathHandler({ stage: input.stage, phase: input.phase } as AgentRunRequest);
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(reply.output),
    usage: { input_tokens: reply.tokens ?? 1, output_tokens: 0 },
    total_cost_usd: 0.001,
  });
  return Promise.resolve({ code: 0, stdout, stderr: '' });
};

describe('EventLoop + SubprocessStageExecutor (fake harness)', () => {
  it('drives a run to done through the real executor and parser', async () => {
    const { fsm, agents, version } = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));
    const executor = new SubprocessStageExecutor({ spawnProcess: goldenPathSpawn });
    const runner = new AgentRunner(repo, executor, agents, new FakeGitHub({ autoSeedIssues: true }));

    const transitions: string[] = [];
    const loop = new EventLoop(repo, fsm, version, runner, {
      onTransition: (t) => transitions.push(`${t.fromState}->${t.toState}`),
    });

    const run = loop.startRun({ issueRef: 'o/r#1', repoRef: 'o/r' });
    await loop.runUntilIdle();

    const final = repo.getRun(run.id)!;
    expect(final.currentState).toBe('done');
    expect(final.status).toBe('done');
    expect(transitions).toEqual([
      'triage->plan',
      'plan->plan_review',
      'plan_review->interface_design',
      'interface_design->tdd',
      'tdd->frontend',
      'frontend->backend',
      'backend->code_review',
      'code_review->done',
    ]);
    // Usage and cost flowed from the harness through the executor seam onto the run.
    expect(final.tokensUsed).toBeGreaterThan(0);
    expect(final.costUsed).toBeGreaterThan(0);
  });
});
