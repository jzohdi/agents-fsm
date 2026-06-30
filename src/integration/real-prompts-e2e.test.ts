/**
 * End-to-end integration of the Milestone 4b pieces — the real composed system prompts flowing
 * through the real Stage Executor and the full pipeline — without spending a cent.
 *
 * It wires the real `createSystemPromptFn` into the Agent Runner and the real
 * `SubprocessStageExecutor` into the loop, backed by a fake harness process. The fake harness
 * asserts that every invocation it receives carries a well-formed composed prompt (base + a stage
 * role + the matching output contract on the `--append-system-prompt` arg), then replies with the
 * golden-path output. So this proves the new prompt layer composes correctly and survives the whole
 * path — loop → runner → executor argv → stream-json parse → envelope validation → engine — exactly
 * where the real CLI run will exercise it, but offline.
 */

import { describe, expect, it } from 'vitest';

import { createSystemPromptFn } from '../agent/prompts';
import { goldenPathHandler, type AgentRunRequest } from '../agent/executor';
import { AgentRunner } from '../agent/runner';
import { SubprocessStageExecutor, type ProcessResult, type SpawnProcess } from '../agent/subprocess-executor';
import { loadDefaultConfig } from '../fsm/config';
import { EventLoop } from '../loop/event-loop';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { FakeGitHub } from './github-fake';

/** Pull the value that follows `flag` out of a spawned argv (mirrors how the CLI passes args). */
function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) throw new Error(`missing ${flag} in argv`);
  return args[i + 1]!;
}

/** What the fake harness captured for one invocation, asserted after the run completes. */
interface Invocation {
  stage: string;
  phase: string;
  system: string;
  /** The issue the runner plumbed into the harness input (the source of intent for the whole run). */
  issue: unknown;
}

describe('EventLoop + real prompts + SubprocessStageExecutor (fake harness)', () => {
  it('drives a run to done, with a well-formed composed prompt on every invocation', async () => {
    const { fsm, agents, version } = loadDefaultConfig();
    const repo = new Repository(openDb(':memory:'));

    // The fake harness records the prompt it was handed and answers golden-path. We assert on the
    // captured prompts *after* the run, so an assertion failure surfaces directly instead of being
    // swallowed into an executor-error escalation (which would only show up as "expected done").
    const invocations: Invocation[] = [];
    const harness: SpawnProcess = (_command, args): Promise<ProcessResult> => {
      const system = argValue(args, '--append-system-prompt');
      const input = JSON.parse(argValue(args, '-p')) as { stage: string; phase: string; issue?: unknown };
      invocations.push({ stage: input.stage, phase: input.phase, system, issue: input.issue });

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

    const executor = new SubprocessStageExecutor({ spawnProcess: harness });
    const runner = new AgentRunner(repo, executor, agents, new FakeGitHub({ autoSeedIssues: true }), {
      systemPrompt: createSystemPromptFn(),
    });

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

    // Every invocation carried a well-formed composed prompt: shared base + a stage role + exactly
    // the matching output contract (verdict for self_review, envelope otherwise).
    expect(invocations.length).toBeGreaterThanOrEqual(8);
    for (const { stage, phase, system, issue } of invocations) {
      const where = `${stage}:${phase}`;
      expect(system, where).toContain('automated software-delivery pipeline');
      expect(system, where).toContain('## Your stage:');
      // Each (stage, phase) carries exactly its matching output contract: the triage decision contract
      // for triage, the verdict for self_review, the work envelope otherwise.
      const expected =
        stage === 'triage'
          ? 'Output contract — triage decision'
          : phase === 'self_review'
            ? 'Output contract — review verdict'
            : 'Output contract — work envelope';
      const others = ['Output contract — triage decision', 'Output contract — review verdict', 'Output contract — work envelope'].filter(
        (c) => c !== expected,
      );
      expect(system, where).toContain(expected);
      for (const other of others) expect(system, where).not.toContain(other);
      // The issue (source of intent) reached the harness input on every invocation, not just the prompt.
      expect(issue, where).toMatchObject({ number: 1 });
    }
  });
});
