/**
 * Runner operator-context wiring (jzohdi/agents-fsm#5).
 *
 * The runner reads the three operator-context layers off the repo/run at each dispatch — global
 * (settings `context_global`), per-stage (settings `context_stage:<stage>`), per-run
 * (`runs.issue_context`) — composes them, and passes the block as the 3rd arg to the system-prompt
 * fn, which splices it before the load-bearing contract. Here we drive a real stage through the real
 * `createSystemPromptFn` and inspect the `system` string handed to the executor:
 *   - with global + per-run context configured, the composed operator block reaches the agent
 *     (INV-EVERY-INVOCATION for a real stage), before the output contract;
 *   - with nothing configured, the system prompt carries no operator block (INV-STABLE-PROMPTS).
 */

import { describe, expect, it } from 'vitest';

import { FakeGitHub } from '../integration/github-fake';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { StubExecutor, type AgentRunRequest, type StubHandler } from './executor';
import { AgentRunner } from './runner';
import { createSystemPromptFn } from './prompts';

const OP_HEADING = '## Operator-provided context';

/** Drive one `plan` produce stage through the real composed prompts, capturing every executor request. */
function runPlan(configure: (repo: Repository, runId: number) => void): Promise<AgentRunRequest[]> {
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const seen: AgentRunRequest[] = [];
  const handler: StubHandler = (req) => {
    seen.push(req);
    return { output: { requestedTransition: 'proceed' } };
  };
  const runner = new AgentRunner(repo, new StubExecutor(handler), { plan: { phases: ['produce'] } }, github, {
    systemPrompt: createSystemPromptFn(),
  });
  const run = repo.createRun({ issueRef: 'o/r#1', repoRef: 'o/r', initialState: 'plan', fsmConfigVersion: 'v1' });
  configure(repo, run.id);
  return runner.runStage(repo.getRun(run.id)!).then(() => seen);
}

describe('AgentRunner — operator context reaches the system prompt (agents-fsm#5)', () => {
  it('injects the composed global + per-run block before the output contract', async () => {
    const seen = await runPlan((repo, runId) => {
      repo.setSetting('context_global', 'GLOBAL_STANDING_GUIDANCE');
      repo.setRunIssueContext(runId, 'PER_ISSUE_GUIDANCE');
    });

    const system = seen.find((r) => r.phase === 'produce')!.system;
    expect(system).toContain(OP_HEADING);
    expect(system).toContain('GLOBAL_STANDING_GUIDANCE');
    expect(system).toContain('PER_ISSUE_GUIDANCE');
    // The contract stays last: operator guidance precedes the envelope contract.
    expect(system.indexOf(OP_HEADING)).toBeLessThan(system.indexOf('Output contract — work envelope'));
    // global (broadest) precedes the per-run layer (narrowest).
    expect(system.indexOf('GLOBAL_STANDING_GUIDANCE')).toBeLessThan(system.indexOf('PER_ISSUE_GUIDANCE'));
  });

  it('also injects a per-stage layer keyed by the stage being run', async () => {
    const seen = await runPlan((repo) => {
      repo.setSetting('context_stage:plan', 'PLAN_STAGE_GUIDANCE');
    });
    const system = seen.find((r) => r.phase === 'produce')!.system;
    expect(system).toContain(OP_HEADING);
    expect(system).toContain('PLAN_STAGE_GUIDANCE');
  });

  it('carries no operator block when no layer is configured (INV-STABLE-PROMPTS)', async () => {
    const seen = await runPlan(() => {});
    const system = seen.find((r) => r.phase === 'produce')!.system;
    expect(system).not.toContain(OP_HEADING);
    // The prompt is exactly what the composer produces with no operator context (the plain composition).
    expect(system).toBe(createSystemPromptFn()('plan', 'produce'));
  });
});
