/**
 * Agent Runner working-tree / GitHub lifecycle tests (Milestone 4a).
 *
 * Drives single stages against the real default agent config (so each stage's `io` is the real
 * one) with the in-memory GitHub fake, asserting the git/GitHub side effects that bracket a stage:
 * branch creation, commit/push, find-or-open PR (idempotent), review comments, and the structured
 * escalation on a git failure. No network, no money.
 */

import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { FakeGitHub } from '../integration/github-fake';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { StubExecutor, goldenPathHandler, type StubHandler } from './executor';
import { AgentRunner } from './runner';

const { agents } = loadDefaultConfig();

function setup(handler: StubHandler = goldenPathHandler) {
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ autoSeedIssues: true });
  const runner = new AgentRunner(repo, new StubExecutor(handler), agents, github, { baseBranch: 'main' });
  return { repo, github, runner };
}

function newRunAt(repo: Repository, state: string) {
  return repo.createRun({ issueRef: 'o/r#7', repoRef: 'o/r', initialState: state, fsmConfigVersion: 'v1' });
}

describe('AgentRunner lifecycle — triage', () => {
  it('reads the issue but creates no branch, tree, or commit', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'triage');

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    expect(repo.getRun(run.id)!.branch).toBeNull();
    expect(github.commitCount()).toBe(0);
    expect(github.listPrs()).toHaveLength(0);
  });
});

describe('AgentRunner lifecycle — produce stages', () => {
  it('plan creates the run branch, commits, and enriches artifacts with branch + sha', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'plan');

    const outcome = await runner.runStage(run);

    expect(repo.getRun(run.id)!.branch).toBe(`agent/run-${run.id}`);
    expect(github.commitCount()).toBe(1);
    expect(outcome.kind).toBe('handoff');
    if (outcome.kind === 'handoff') {
      const plan = outcome.envelope.artifacts!.find((a) => a.kind === 'plan')!;
      expect(plan.locator).toMatchObject({ branch: `agent/run-${run.id}` });
      expect(plan.locator).toHaveProperty('sha');
    }
  });

  it('reuses the existing branch on a later produce stage (branch created once)', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'plan');
    await runner.runStage(run);
    const branch = repo.getRun(run.id)!.branch;

    repo.setRunState(run.id, 'interface_design');
    await runner.runStage(repo.getRun(run.id)!);

    expect(repo.getRun(run.id)!.branch).toBe(branch); // unchanged
    expect(github.commitCount()).toBe(2); // one commit per produce stage
  });
});

describe('AgentRunner lifecycle — tdd opens the PR idempotently', () => {
  it('opens the PR once and adopts (never duplicates) it on a re-run', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'tdd');
    repo.setRunBranch(run.id, `agent/run-${run.id}`);

    await runner.runStage(repo.getRun(run.id)!);
    const prNumber = repo.getRun(run.id)!.prNumber;
    expect(github.listPrs()).toHaveLength(1);
    expect(prNumber).not.toBeNull();

    // A back-edge re-run of tdd must not open a second PR.
    await runner.runStage(repo.getRun(run.id)!);
    expect(github.listPrs()).toHaveLength(1);
    expect(repo.getRun(run.id)!.prNumber).toBe(prNumber);
  });

  it('adopts an already-open PR when the number was never persisted (crash window)', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'tdd');
    const branch = `agent/run-${run.id}`;
    repo.setRunBranch(run.id, branch);
    // A prior attempt opened the PR but crashed before setRunPr persisted the number.
    const orphan = await github.openPr({ branch, base: 'main', title: 't', body: '' });
    expect(repo.getRun(run.id)!.prNumber).toBeNull();

    await runner.runStage(repo.getRun(run.id)!);

    expect(github.listPrs()).toHaveLength(1); // no duplicate
    expect(repo.getRun(run.id)!.prNumber).toBe(orphan.number); // adopted
  });
});

describe('AgentRunner lifecycle — review stages', () => {
  it('code_review is fed the branch diff, posts comments to the PR, and makes no commit', async () => {
    let reviewInput: Record<string, unknown> | undefined;
    const handler: StubHandler = (req) => {
      if (req.stage !== 'code_review') return goldenPathHandler(req);
      reviewInput = req.input as Record<string, unknown>;
      return { output: { requestedTransition: 'approve', comments: ['nit: rename x', 'add a test'] } };
    };
    const { repo, github, runner } = setup(handler);
    const run = newRunAt(repo, 'code_review');
    const branch = `agent/run-${run.id}`;
    repo.setRunBranch(run.id, branch);
    const pr = await github.openPr({ branch, base: 'main', title: 't', body: '' });
    repo.setRunPr(run.id, pr.number);
    github.seedDiff({ base: 'main', branch, diff: 'diff --git a/x b/x' });
    const commitsBefore = github.commitCount();

    const outcome = await runner.runStage(repo.getRun(run.id)!);

    expect(outcome.kind).toBe('handoff');
    // The runner injected the diff so the reviewer has something to review (read-only — no Bash).
    expect(reviewInput!.diff).toBe('diff --git a/x b/x');
    expect(github.listComments().map((c) => c.body)).toEqual(['nit: rename x', 'add a test']);
    expect(github.commitCount()).toBe(commitsBefore); // review never commits
  });

  it('plan_review (no PR) is not fed a diff and posts nothing', async () => {
    let reviewInput: Record<string, unknown> | undefined;
    const handler: StubHandler = (req) => {
      if (req.stage !== 'plan_review') return goldenPathHandler(req);
      reviewInput = req.input as Record<string, unknown>;
      return { output: { requestedTransition: 'approve' } };
    };
    const { repo, github, runner } = setup(handler);
    const run = newRunAt(repo, 'plan_review');
    repo.setRunBranch(run.id, `agent/run-${run.id}`); // branch exists from plan, but no PR yet

    const outcome = await runner.runStage(repo.getRun(run.id)!);

    expect(outcome.kind).toBe('handoff');
    expect(reviewInput!.diff).toBeUndefined(); // nothing to diff before the PR exists
    expect(github.listComments()).toHaveLength(0);
  });
});

describe('AgentRunner lifecycle — git failures escalate (no bare crash)', () => {
  it('returns a structured git_error when a push fails', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'plan');
    github.commitAndPush = () => Promise.reject(new Error('push rejected'));

    const outcome = await runner.runStage(repo.getRun(run.id)!);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') expect(outcome.reason).toMatchObject({ kind: 'git_error', op: 'effects' });
  });

  it('returns a structured git_error when stage preparation fails', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'plan');
    github.readIssue = () => Promise.reject(new Error('issue 404'));

    const outcome = await runner.runStage(repo.getRun(run.id)!);

    expect(outcome.kind).toBe('escalate');
    if (outcome.kind === 'escalate') expect(outcome.reason).toMatchObject({ kind: 'git_error', op: 'prepare' });
  });
});
