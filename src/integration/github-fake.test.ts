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

  it('auto-seeds a synthetic issue (number from the ref) when configured', async () => {
    const gh = new FakeGitHub({ autoSeedIssues: true });
    expect(await gh.readIssue('o/r#42')).toMatchObject({ ref: 'o/r#42', number: 42 });
    expect(await gh.readIssue('bare-ref')).toMatchObject({ number: 1 }); // fallback when no #n
  });

  it('suggests seeded issues filtered by query (ref or title), newest first', async () => {
    const gh = new FakeGitHub()
      .seedIssue('acme/web#318', { number: 318, title: 'Checkout token refresh' })
      .seedIssue('acme/web#312', { number: 312, title: 'Cart rounding error' })
      .seedIssue('acme/api#205', { number: 205, title: 'Rate limit 429s' });

    expect(await gh.suggestIssues('web')).toEqual([
      { kind: 'issue', ref: 'acme/web#318', repo: 'acme/web', number: 318, title: 'Checkout token refresh' },
      { kind: 'issue', ref: 'acme/web#312', repo: 'acme/web', number: 312, title: 'Cart rounding error' },
    ]);
    expect((await gh.suggestIssues('rounding')).map((s) => s.number)).toEqual([312]); // matches title
    expect((await gh.suggestIssues('')).map((s) => s.number)).toEqual([318, 312, 205]); // all, newest first
  });
});

describe('FakeGitHub — issue editing, creation, and comments', () => {
  it('updates a seeded issue title and/or body', async () => {
    const gh = new FakeGitHub().seedIssue('o/r#7', { number: 7, title: 'old', body: 'vague' });
    const updated = await gh.updateIssue({ number: 7, title: 'Add OAuth', body: 'scoped' });
    expect(updated).toMatchObject({ ref: 'o/r#7', number: 7, title: 'Add OAuth', body: 'scoped' });
    // The change persists for later reads, and a partial update leaves other fields intact.
    await gh.updateIssue({ number: 7, body: 'tighter' });
    expect(await gh.readIssue('o/r#7')).toMatchObject({ title: 'Add OAuth', body: 'tighter' });
  });

  it('rejects updating a non-existent issue', async () => {
    await expect(new FakeGitHub().updateIssue({ number: 99, body: 'x' })).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  it('creates new issues with incrementing numbers above the seeded ones', async () => {
    const gh = new FakeGitHub({ repoRef: 'o/r' }).seedIssue('o/r#7', { number: 7 });
    const a = await gh.createIssue({ title: 'piece A', body: 'a' });
    const b = await gh.createIssue({ title: 'piece B', body: 'b' });
    expect(a).toEqual({ ref: 'o/r#8', number: 8, title: 'piece A', body: 'a' });
    expect(b.ref).toBe('o/r#9');
    // A created issue is then readable like any other.
    expect(await gh.readIssue('o/r#8')).toMatchObject({ title: 'piece A' });
  });

  it('posts issue comments authored by the bot login and lists them per issue', async () => {
    const gh = new FakeGitHub({ botLogin: 'fleet[bot]' });
    const c = await gh.postIssueComment({ issueNumber: 7, body: 'a question' });
    expect(c).toMatchObject({ issueNumber: 7, author: 'fleet[bot]', body: 'a question' });
    expect(c.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Listing is scoped to the issue.
    await gh.postIssueComment({ issueNumber: 8, body: 'elsewhere' });
    expect((await gh.listIssueComments(7)).map((x) => x.body)).toEqual(['a question']);
  });

  it('seedIssueComment simulates a human reply with a distinct author', async () => {
    const gh = new FakeGitHub();
    gh.seedIssueComment(7, { author: 'alice', body: 'Use Postgres' });
    const comments = await gh.listIssueComments(7);
    expect(comments[0]).toMatchObject({ author: 'alice', body: 'Use Postgres' });
    expect(comments[0]!.author).not.toBe(gh.agentLogin());
  });
});

describe('FakeGitHub — findOpenPrForBranch', () => {
  it('returns the open PR for a branch, or null', async () => {
    const gh = new FakeGitHub();
    expect(await gh.findOpenPrForBranch('feature')).toBeNull();
    const pr = await gh.openPr({ branch: 'feature', base: 'main', title: 't', body: '' });
    expect(await gh.findOpenPrForBranch('feature')).toMatchObject({ number: pr.number });
  });

  it('does not return a merged/closed PR (a new one can be opened)', async () => {
    const gh = new FakeGitHub();
    const pr = await gh.openPr({ branch: 'feature', base: 'main', title: 't', body: '' });
    gh.setPrState(pr.number, 'merged');
    expect(await gh.findOpenPrForBranch('feature')).toBeNull();
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
