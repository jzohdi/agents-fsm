/**
 * Triage stage tests (Q1): the router/editor path through the Agent Runner.
 *
 * Drives the real default triage recipe (io.kind 'triage') against the in-memory GitHub fake and a
 * stub agent that emits each triage decision, asserting the GitHub side effects the runner performs
 * (improve the issue, sign off, ask the human, split) and the {@link StageOutcome} it maps to. No
 * network, no money.
 */

import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import type { RepoResolver } from '../integration/github-resolver';
import { parseMarker } from '../integration/issue-markers';
import { openDb } from '../store/db';
import { Repository, type Run } from '../store/repository';
import { StubExecutor, type StubHandler } from './executor';
import { AgentRunner } from './runner';

const { agents } = loadDefaultConfig();
const ISSUE_REF = 'o/r#7';

/** A stub whose triage produce phase returns `output`; any other call is unreachable in these tests. */
function triageStub(output: unknown): StubHandler {
  return () => ({ output });
}

function setup(output: unknown, seed: { title?: string; body?: string } = {}) {
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ repoRef: 'o/r', botLogin: 'bot[bot]' });
  github.seedIssue(ISSUE_REF, { number: 7, title: seed.title ?? 'Do a thing', body: seed.body ?? 'vague' });
  const runner = new AgentRunner(repo, new StubExecutor(triageStub(output)), agents, github);
  const run: Run = repo.createRun({ issueRef: ISSUE_REF, repoRef: 'o/r', initialState: 'triage', fsmConfigVersion: 'v1' });
  return { repo, github, runner, run };
}

describe('AgentRunner triage — proceed (sign-off)', () => {
  it('hands off to plan and posts a human-visible sign-off comment', async () => {
    const { github, runner, run } = setup({ decision: 'proceed', message: 'Looks well scoped.' });

    const outcome = await runner.runStage(run);

    expect(outcome).toMatchObject({ kind: 'handoff', envelope: { requestedTransition: 'proceed' } });
    const comments = await github.listIssueComments(7);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('Triage sign-off');
    expect(comments[0]!.body).toContain('Looks well scoped.');
    expect(comments[0]!.author).toBe('bot[bot]');
  });

  it('improves the issue description first when issueUpdate is present', async () => {
    const { github, runner, run } = setup({
      decision: 'proceed',
      issueUpdate: { title: 'Add OAuth login', body: '## Goal\nSupport Google OAuth.\n## Acceptance\n- redirect works' },
    });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    const issue = await github.readIssue(ISSUE_REF);
    expect(issue.title).toBe('Add OAuth login');
    expect(issue.body).toContain('Support Google OAuth');
  });
});

describe('AgentRunner triage — clarify (ask the human, then wait)', () => {
  it('posts the questions and returns an await_input outcome anchoring the reply poller', async () => {
    const { github, runner, run } = setup({ decision: 'clarify', questions: ['Which provider?', 'Mobile too?'] });

    const outcome = await runner.runStage(run);

    // The questions reached the issue as a single comment.
    const comments = await github.listIssueComments(7);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('Which provider?');
    expect(comments[0]!.body).toContain('Mobile too?');
    // The await_input reason carries the poller's anchor (issue + question comment + bot login);
    // the loop records it in the transition log, so no separate marker store is needed.
    expect(outcome.kind).toBe('await_input');
    if (outcome.kind === 'await_input') {
      expect(outcome.reason).toMatchObject({
        kind: 'needs_more_detail',
        questions: ['Which provider?', 'Mobile too?'],
        issueNumber: 7,
        commentId: comments[0]!.id,
        botLogin: 'bot[bot]',
      });
    }
  });
});

describe('AgentRunner triage — split', () => {
  const subIssues = [
    { title: 'Backend: token endpoint', body: 'Issue OAuth tokens' },
    { title: 'Frontend: login button', body: 'Add the button' },
  ];

  it('creates the sub-issues, links them, and hands this run off to the chosen child', async () => {
    const { repo, github, runner, run } = setup({ decision: 'split', subIssues, handoff: 1 });

    const outcome = await runner.runStage(run);

    // Two new issues were opened (numbers after the seeded #7).
    const created1 = await github.readIssue('o/r#8');
    const created2 = await github.readIssue('o/r#9');
    expect(created1.title).toBe('Backend: token endpoint');
    expect(created2.title).toBe('Frontend: login button');
    // The run was retargeted to the chosen child (index 1 → #9) and continues to plan.
    expect(repo.getRun(run.id)!.issueRef).toBe('o/r#9');
    expect(outcome).toMatchObject({ kind: 'handoff', envelope: { requestedTransition: 'proceed' } });
    if (outcome.kind === 'handoff') {
      expect(outcome.envelope.reason).toMatchObject({ kind: 'triage_split_handoff', continuingOn: 'o/r#9', siblings: ['o/r#8'] });
    }
    // The original issue got a linking comment.
    const comments = await github.listIssueComments(7);
    expect(comments[0]!.body).toContain('o/r#8');
    expect(comments[0]!.body).toContain('o/r#9');
  });

  it('escalates (should_split) when no handoff is given, leaving the children for the operator', async () => {
    const { repo, github, runner, run } = setup({ decision: 'split', subIssues });

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') {
      expect(outcome.trigger).toBe('should_split');
      expect(outcome.reason).toMatchObject({ kind: 'should_split', created: [{ ref: 'o/r#8' }, { ref: 'o/r#9' }] });
    }
    // The run is NOT retargeted (the operator schedules the children).
    expect(repo.getRun(run.id)!.issueRef).toBe(ISSUE_REF);
    expect((await github.listIssueComments(7))[0]!.body).toContain('split this issue');
  });
});

describe('AgentRunner triage — malformed output', () => {
  it('escalates malformed_output when the agent does not emit a valid decision', async () => {
    const { github, runner, run } = setup({ requestedTransition: 'proceed' }); // a work envelope, not a triage decision

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') expect(outcome.trigger).toBe('malformed_output');
    // No GitHub side effects on malformed output.
    expect(await github.listIssueComments(7)).toHaveLength(0);
  });
});

describe('AgentRunner — multi-repo (Milestone 8 Phase A)', () => {
  it('routes each run to its own repo’s adapter, not a single shared one', async () => {
    const repo = new Repository(openDb(':memory:'));
    const webGh = new FakeGitHub({ repoRef: 'acme/web', botLogin: 'bot[bot]' }).seedIssue('acme/web#1', { number: 1 });
    const apiGh = new FakeGitHub({ repoRef: 'acme/api', botLogin: 'bot[bot]' }).seedIssue('acme/api#1', { number: 1 });
    // A resolver mapping each repoRef to its own adapter — what the daemon builds from the repos registry.
    const resolver: RepoResolver = { for: (ref) => ({ github: ref === 'acme/web' ? webGh : apiGh, baseBranch: 'main' }), invalidate: () => {} };
    const runner = new AgentRunner(repo, new StubExecutor(triageStub({ decision: 'proceed', message: 'ok' })), agents, resolver);

    const webRun = repo.createRun({ issueRef: 'acme/web#1', repoRef: 'acme/web', initialState: 'triage', fsmConfigVersion: 'v1' });
    const apiRun = repo.createRun({ issueRef: 'acme/api#1', repoRef: 'acme/api', initialState: 'triage', fsmConfigVersion: 'v1' });

    await runner.runStage(webRun);
    await runner.runStage(apiRun);

    // Each repo's adapter saw exactly its own run's sign-off — never the other's.
    expect(await webGh.listIssueComments(1)).toHaveLength(1);
    expect(await apiGh.listIssueComments(1)).toHaveLength(1);
  });
});

describe('AgentRunner triage — scheduling declarations (Milestone 9, README §3.5)', () => {
  const HUMAN_BLOCK = '<!-- agent-orchestrator:v1\ndepends_on: [42]\npriority: 2\norder_key: "human"\n-->';

  it('writes the declaration into the issue marker block and caches it on the run, in one commit', async () => {
    const { repo, github, runner, run } = setup({
      decision: 'proceed',
      scheduling: { depends_on: [57, 42], priority: 10, order_key: 'q3' },
    });

    await runner.runStage(run);

    // The issue body carries the §3.5 block, canonically formatted by the runner (never the agent).
    const issue = await github.readIssue(ISSUE_REF);
    expect(parseMarker(issue.body)).toEqual({ dependsOn: [42, 57], priority: 10, orderKey: 'q3' });
    // And the run's cache gates its very next stage — no poller tick needed.
    expect(repo.getRun(run.id)).toMatchObject({ dependsOn: [42, 57], priority: 10, orderKey: 'q3' });
  });

  it('caches a human pre-declared block even when the agent declares nothing', async () => {
    const { repo, github, runner, run } = setup(
      { decision: 'proceed' },
      { body: `Needs the auth work first.\n\n${HUMAN_BLOCK}` },
    );

    await runner.runStage(run);

    // No issue edit happened (nothing to write), but the human's declaration now gates the run.
    const issue = await github.readIssue(ISSUE_REF);
    expect(issue.body).toContain('Needs the auth work first.');
    expect(repo.getRun(run.id)).toMatchObject({ dependsOn: [42], priority: 2, orderKey: 'human' });
  });

  it('a partial declaration overlays the existing block — a human depends_on survives a priority-only update', async () => {
    const { repo, github, runner, run } = setup(
      { decision: 'proceed', scheduling: { priority: 9 } },
      { body: `Context.\n\n${HUMAN_BLOCK}` },
    );

    await runner.runStage(run);

    const issue = await github.readIssue(ISSUE_REF);
    expect(parseMarker(issue.body)).toEqual({ dependsOn: [42], priority: 9, orderKey: 'human' });
    expect(repo.getRun(run.id)).toMatchObject({ dependsOn: [42], priority: 9, orderKey: 'human' });
  });

  it('an issue rewrite that dropped the block gets it carried back in (never strip a human declaration)', async () => {
    const { repo, github, runner, run } = setup(
      { decision: 'proceed', issueUpdate: { body: '## Goal\nRewritten spec, no block.' } },
      { body: `Old text.\n\n${HUMAN_BLOCK}` },
    );

    await runner.runStage(run);

    const issue = await github.readIssue(ISSUE_REF);
    expect(issue.body).toContain('Rewritten spec');
    expect(parseMarker(issue.body)).toEqual({ dependsOn: [42], priority: 2, orderKey: 'human' });
    expect(repo.getRun(run.id)).toMatchObject({ dependsOn: [42], priority: 2, orderKey: 'human' });
  });

  it('a split handoff resets the cache — the child issue declares for itself', async () => {
    const { repo, runner, run } = setup(
      {
        decision: 'split',
        subIssues: [
          { title: 'A', body: 'part one' },
          { title: 'B', body: 'part two' },
        ],
        handoff: 0,
        scheduling: { depends_on: [42] },
      },
      { body: 'huge issue' },
    );

    await runner.runStage(run);

    // The parent's declaration was cached mid-stage, then the retarget to the child reset it.
    expect(repo.getRun(run.id)).toMatchObject({ dependsOn: [], priority: 0, orderKey: '', depsSatisfiedAt: null });
  });
});
