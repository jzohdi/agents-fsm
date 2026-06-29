/**
 * Tests for the in-memory {@link FakeGitHub} (Milestone 3).
 *
 * The fake is the everyday test double for the whole pipeline, so its observable behavior
 * must be correct and stable: issue lookup, idempotent working-tree preparation, PR/comment
 * lifecycle, and branch-relative diffs.
 */

import { describe, expect, it } from 'vitest';

import { GitHubNotFoundError } from './github';
import { FakeGitHub } from './github-fake';

describe('FakeGitHub — issues', () => {
  it('reads a seeded issue', async () => {
    const gh = new FakeGitHub().seedIssue('o/r#42', { number: 42, title: 'Add auth', body: 'do it' });
    expect(await gh.readIssue('o/r#42')).toEqual({ ref: 'o/r#42', number: 42, title: 'Add auth', body: 'do it' });
  });

  it('rejects an unknown issue with GitHubNotFoundError', async () => {
    const gh = new FakeGitHub();
    await expect(gh.readIssue('o/r#1')).rejects.toBeInstanceOf(GitHubNotFoundError);
  });
});

describe('FakeGitHub — working tree', () => {
  it('prepares a per-run working tree with the requested branch and base', async () => {
    const gh = new FakeGitHub({ workingRoot: '/work' });
    const tree = await gh.prepareWorkingTree({ runId: 7, branch: 'agent/run-7', base: 'main' });
    expect(tree).toEqual({ path: '/work/run-7', branch: 'agent/run-7', base: 'main' });
  });

  it('is idempotent — preparing twice returns the same tree', async () => {
    const gh = new FakeGitHub();
    const first = await gh.prepareWorkingTree({ runId: 1, branch: 'agent/run-1', base: 'main' });
    const second = await gh.prepareWorkingTree({ runId: 1, branch: 'other', base: 'develop' });
    expect(second).toEqual(first);
  });
});

describe('FakeGitHub — commits and diff', () => {
  it('records commits and synthesizes a diff from them', async () => {
    const gh = new FakeGitHub();
    const { path } = await gh.prepareWorkingTree({ runId: 1, branch: 'b', base: 'main' });

    const c1 = await gh.commitAndPush({ workingDir: path, branch: 'b', message: 'add plan' });
    const c2 = await gh.commitAndPush({ workingDir: path, branch: 'b', message: 'add tests' });
    expect(c1.sha).not.toEqual(c2.sha);

    const diff = await gh.readDiff({ workingDir: path, base: 'main', branch: 'b' });
    expect(diff).toBe('+ add plan\n+ add tests');
  });

  it('returns a seeded diff override when present', async () => {
    const gh = new FakeGitHub().seedDiff({ base: 'main', branch: 'b', diff: '--- a\n+++ b' });
    const diff = await gh.readDiff({ workingDir: '/anything', base: 'main', branch: 'b' });
    expect(diff).toBe('--- a\n+++ b');
  });
});

describe('FakeGitHub — pull requests and comments', () => {
  it('opens PRs with incrementing numbers and open state', async () => {
    const gh = new FakeGitHub();
    const pr1 = await gh.openPr({ branch: 'b1', base: 'main', title: 't1', body: 'Closes #1' });
    const pr2 = await gh.openPr({ branch: 'b2', base: 'main', title: 't2', body: 'Closes #2' });
    expect([pr1.number, pr2.number]).toEqual([1, 2]);
    expect(pr1.state).toBe('open');
    expect(pr1.url).toContain('/pr/1');
  });

  it('updates an existing PR title and body', async () => {
    const gh = new FakeGitHub();
    const pr = await gh.openPr({ branch: 'b', base: 'main', title: 'draft', body: 'old' });
    const updated = await gh.updatePr({ prNumber: pr.number, title: 'final' });
    expect(updated.title).toBe('final');
    expect(updated.body).toBe('old'); // unchanged fields are preserved
    expect(gh.listPrs()[0]!.title).toBe('final');
  });

  it('posts comments tied to a PR', async () => {
    const gh = new FakeGitHub();
    const pr = await gh.openPr({ branch: 'b', base: 'main', title: 't', body: '' });
    await gh.postComment({ prNumber: pr.number, body: 'please fix naming' });
    await gh.postComment({ prNumber: pr.number, body: 'and add a test' });
    expect(gh.listComments().map((c) => c.body)).toEqual(['please fix naming', 'and add a test']);
    expect(gh.listComments().map((c) => c.id)).toEqual([1, 2]);
  });

  it('rejects updates/comments on a non-existent PR', async () => {
    const gh = new FakeGitHub();
    await expect(gh.updatePr({ prNumber: 99 })).rejects.toBeInstanceOf(GitHubNotFoundError);
    await expect(gh.postComment({ prNumber: 99, body: 'x' })).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  it('can mark a PR merged (the dependency-satisfied signal)', async () => {
    const gh = new FakeGitHub();
    const pr = await gh.openPr({ branch: 'b', base: 'main', title: 't', body: '' });
    gh.setPrState(pr.number, 'merged');
    expect(gh.listPrs()[0]!.state).toBe('merged');
  });
});
