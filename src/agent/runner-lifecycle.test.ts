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

/** Stand-in for the placeholder body `tdd` opens the PR with, so a body-finalization test can prove it changed. */
const prePlaceholder = 'placeholder body opened by tdd';

/** The generated working-branch shape: `agent/<date>-<issue-slug>-<rand>` (date + a `[a-z0-9-]` slug + a 6-hex suffix). */
const BRANCH_RE = /^agent\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*-[0-9a-f]{6}$/;

describe('AgentRunner lifecycle — triage', () => {
  it('prepares the repo checkout (branch + tree) but makes no commit or PR (Milestone 12)', async () => {
    // triage now runs inside the target repo's working tree (so the harness can inspect the codebase to
    // scope the issue — the tmux-speedrun#35 fix), which creates and persists the run branch. It still
    // performs no produce side effects: no commit, no PR (those belong to the produce stages).
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'triage');

    const outcome = await runner.runStage(run);

    expect(outcome.kind).toBe('handoff');
    expect(repo.getRun(run.id)!.branch).toMatch(BRANCH_RE);
    expect(github.commitCount()).toBe(0);
    expect(github.listPrs()).toHaveLength(0);
  });
});

describe('AgentRunner lifecycle — produce stages', () => {
  it('plan creates the run branch, commits, and enriches artifacts with branch + sha', async () => {
    const { repo, github, runner } = setup();
    const run = newRunAt(repo, 'plan');

    const outcome = await runner.runStage(run);

    const createdBranch = repo.getRun(run.id)!.branch!;
    expect(createdBranch).toMatch(BRANCH_RE);
    expect(github.commitCount()).toBe(1);
    expect(outcome.kind).toBe('handoff');
    if (outcome.kind === 'handoff') {
      const plan = outcome.envelope.artifacts!.find((a) => a.kind === 'plan')!;
      expect(plan.locator).toMatchObject({ branch: createdBranch });
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

  it('gives distinct branch names to distinct runs (no cross-run collision)', async () => {
    // The bug this guards: two runs sharing a branch name (e.g. after the operator wiped the db and
    // run ids restarted) would let one run adopt another's leftover remote branch + commits.
    const { repo, runner } = setup();
    const a = newRunAt(repo, 'plan');
    const b = newRunAt(repo, 'plan');
    await runner.runStage(a);
    await runner.runStage(b);

    const branchA = repo.getRun(a.id)!.branch!;
    const branchB = repo.getRun(b.id)!.branch!;
    expect(branchA).not.toBe(branchB);
    expect(branchA).toMatch(BRANCH_RE);
  });

  it('names the branch from the run date and a slug of the issue title', async () => {
    const { repo, github, runner } = setup();
    github.seedIssue('o/r#7', { number: 7, title: 'Add CSV export to the Reports page!' });
    const run = newRunAt(repo, 'plan');

    await runner.runStage(run);

    const date = repo.getRun(run.id)!.createdAt.slice(0, 10);
    // The punctuation-heavy title becomes a clean `[a-z0-9-]` slug; the date + a unique suffix bracket it.
    expect(repo.getRun(run.id)!.branch).toMatch(new RegExp(`^agent/${date}-add-csv-export-to-the-reports-page-[0-9a-f]{6}$`));
  });
});

describe('AgentRunner lifecycle — per-repo base branch (Milestone 8 Phase A)', () => {
  it('cuts the working tree and opens the PR against the run’s repo base, not a global default', async () => {
    const repo = new Repository(openDb(':memory:'));
    const github = new FakeGitHub({ autoSeedIssues: true });
    // The resolver supplies this repo's base branch (as the daemon does from the registry row); the
    // runner must thread *it* through to prepareWorkingTree and openPr — not the DEFAULT_BASE_BRANCH.
    const runner = new AgentRunner(repo, new StubExecutor(goldenPathHandler), agents, {
      for: () => ({ github, baseBranch: 'release' }),
      invalidate: () => {},
    });
    const run = repo.createRun({ issueRef: 'o/r#7', repoRef: 'o/r', initialState: 'tdd', fsmConfigVersion: 'v1' });
    repo.setRunBranch(run.id, `agent/run-${run.id}`);

    await runner.runStage(repo.getRun(run.id)!);

    expect(github.listPrs()[0]!.base).toBe('release');
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
    // The PR body closes the issue and explains provenance (a useful, not-bare description).
    expect(github.listPrs()[0]!.body).toContain('Closes #');
    expect(github.listPrs()[0]!.body).toContain('agent-fleet');

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
  it('gives code_review the base branch (not a diff), posts comments to the PR, and makes no commit', async () => {
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
    const commitsBefore = github.commitCount();

    const outcome = await runner.runStage(repo.getRun(run.id)!);

    expect(outcome.kind).toBe('handoff');
    // The runner gives the reviewer the base branch to diff against; the agent inspects the diff
    // itself via its git tools (no diff injected into the prompt).
    expect(reviewInput!.base).toBe('main');
    expect(reviewInput!.diff).toBeUndefined();
    expect(github.listComments().map((c) => c.body)).toEqual(['nit: rename x', 'add a test']);
    expect(github.commitCount()).toBe(commitsBefore); // review never commits
  });

  it('finalizes the PR body from the reviewer’s prDescription on approve, keeping Closes # and provenance', async () => {
    const description = '## How it works\nUsers can now export as CSV.\n\n## Tests added\nExport happy-path + empty case.';
    const handler: StubHandler = (req) => {
      if (req.stage !== 'code_review') return goldenPathHandler(req);
      return { output: { requestedTransition: 'approve', prDescription: description } };
    };
    const { repo, github, runner } = setup(handler);
    const run = newRunAt(repo, 'code_review');
    const branch = `agent/run-${run.id}`;
    repo.setRunBranch(run.id, branch);
    const pr = await github.openPr({ branch, base: 'main', title: 't', body: prePlaceholder });
    repo.setRunPr(run.id, pr.number);

    let updateCalls = 0;
    const realUpdate = github.updatePr.bind(github);
    github.updatePr = (input) => {
      updateCalls++;
      return realUpdate(input);
    };

    await runner.runStage(repo.getRun(run.id)!);

    const body = github.listPrs()[0]!.body;
    expect(body).toContain('Users can now export as CSV.'); // the reviewer's write-up landed
    expect(body).toContain('## How it works');
    expect(body).toContain(`Closes #${repo.getRun(run.id)!.issueRef.split('#')[1]}`); // issue link preserved
    expect(body).toContain('agent-fleet'); // provenance footer preserved
    expect(updateCalls).toBe(1);

    // A replayed approval (PR-feedback re-approve / crash-resume) must not re-write the body.
    await runner.runStage(repo.getRun(run.id)!);
    expect(updateCalls).toBe(1);
  });

  it('leaves the placeholder PR body untouched when an approval omits prDescription', async () => {
    const handler: StubHandler = (req) =>
      req.stage === 'code_review' ? { output: { requestedTransition: 'approve' } } : goldenPathHandler(req);
    const { repo, github, runner } = setup(handler);
    const run = newRunAt(repo, 'code_review');
    const branch = `agent/run-${run.id}`;
    repo.setRunBranch(run.id, branch);
    const pr = await github.openPr({ branch, base: 'main', title: 't', body: prePlaceholder });
    repo.setRunPr(run.id, pr.number);

    await runner.runStage(repo.getRun(run.id)!);

    expect(github.listPrs()[0]!.body).toBe(prePlaceholder); // unchanged — no bogus overwrite
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
