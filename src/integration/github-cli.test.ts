/**
 * Tests for the real {@link GitHubCli} adapter (Milestone 3).
 *
 * Three layers of evidence, all offline:
 *  - `issueNumber` parsing (pure).
 *  - the `gh`-backed GitHub API methods, with an *injected* exec returning canned `gh` JSON,
 *    so argv construction, parsing, and error mapping are verified without network.
 *  - the local-git methods (`prepareWorkingTree`/`commitAndPush`/`readDiff`) against a real
 *    temp repo with a local bare remote — real `git`, no network.
 *
 * A live end-to-end smoke test against real GitHub would sit behind `RUN_REAL_GITHUB`; it is
 * intentionally not included here since the fake is what the rest of the suite runs against.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitHubNotFoundError } from './github';
import { GitCommandError, GitHubCli, issueNumber, type ExecFn, type ExecResult } from './github-cli';

describe('issueNumber', () => {
  it('parses the number from a ref or a bare number', () => {
    expect(issueNumber('owner/repo#42')).toBe(42);
    expect(issueNumber('42')).toBe(42);
    expect(issueNumber('#7')).toBe(7);
  });

  it('throws on an unparseable ref', () => {
    expect(() => issueNumber('owner/repo')).toThrowError(/issue number/);
  });
});

/** An exec fake that dispatches on the command + first arg, recording every call. */
function stubExec(routes: Record<string, ExecResult>): { exec: ExecFn; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: ExecFn = (file, args) => {
    calls.push({ file, args });
    const key = `${file} ${args[0]}`;
    const result = routes[key];
    if (!result) return Promise.resolve({ code: 1, stdout: '', stderr: `unrouted: ${key}` });
    return Promise.resolve(result);
  };
  return { exec, calls };
}

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

describe('GitHubCli — gh-backed API (injected exec)', () => {
  it('reads an issue, requesting the right fields and parsing the JSON', async () => {
    const { exec, calls } = stubExec({
      'gh issue': ok(JSON.stringify({ number: 42, title: 'Add auth', body: 'please' })),
    });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const issue = await gh.readIssue('o/r#42');

    expect(issue).toEqual({ ref: 'o/r#42', number: 42, title: 'Add auth', body: 'please' });
    expect(calls[0]!.args).toEqual(['issue', 'view', '42', '--repo', 'o/r', '--json', 'number,title,body']);
  });

  it('opens a PR then reads it back by branch', async () => {
    const { exec, calls } = stubExec({
      'gh pr': ok(
        JSON.stringify({
          number: 5,
          headRefName: 'feature',
          baseRefName: 'main',
          title: 't',
          body: 'Closes #1',
          state: 'OPEN',
          url: 'https://github.com/o/r/pull/5',
        }),
      ),
    });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const pr = await gh.openPr({ branch: 'feature', base: 'main', title: 't', body: 'Closes #1' });

    expect(pr).toMatchObject({ number: 5, branch: 'feature', base: 'main', state: 'open' });
    expect(calls[0]!.args.slice(0, 3)).toEqual(['pr', 'create', '--repo']);
    expect(calls[1]!.args.slice(0, 3)).toEqual(['pr', 'view', 'feature']);
  });

  it('edits a PR then reads it back', async () => {
    const view = JSON.stringify({
      number: 5, headRefName: 'feature', baseRefName: 'main', title: 'final', body: 'b', state: 'OPEN', url: 'u',
    });
    const { exec, calls } = stubExec({ 'gh pr': ok(view) });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const pr = await gh.updatePr({ prNumber: 5, title: 'final' });

    expect(pr.title).toBe('final');
    expect(calls[0]!.args.slice(0, 4)).toEqual(['pr', 'edit', '5', '--repo']);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--title', 'final']));
    expect(calls[0]!.args).not.toContain('--body'); // only provided fields are sent
  });

  it('posts a comment via the REST API and returns its id', async () => {
    const { exec, calls } = stubExec({ 'gh api': ok(JSON.stringify({ id: 9001 })) });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const comment = await gh.postComment({ prNumber: 5, body: 'fix naming' });

    expect(comment).toEqual({ id: 9001, prNumber: 5, body: 'fix naming' });
    expect(calls[0]!.args).toEqual(['api', 'repos/o/r/issues/5/comments', '-f', 'body=fix naming']);
  });

  it('findOpenPrForBranch returns an open PR, or null when none / closed', async () => {
    const openPr = JSON.stringify({
      number: 5, headRefName: 'feature', baseRefName: 'main', title: 't', body: '', state: 'OPEN', url: 'u',
    });
    const ghOpen = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec: stubExec({ 'gh pr': ok(openPr) }).exec });
    expect(await ghOpen.findOpenPrForBranch('feature')).toMatchObject({ number: 5, state: 'open' });

    // A closed PR does not block opening a new one → treated as null.
    const closedPr = JSON.stringify({ ...JSON.parse(openPr), state: 'CLOSED' });
    const ghClosed = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec: stubExec({ 'gh pr': ok(closedPr) }).exec });
    expect(await ghClosed.findOpenPrForBranch('feature')).toBeNull();

    // No PR for the branch → gh exits non-zero "no pull requests found" → null, not a throw.
    const noPr: ExecFn = () => Promise.resolve({ code: 1, stdout: '', stderr: 'no pull requests found for branch' });
    const ghNone = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec: noPr });
    expect(await ghNone.findOpenPrForBranch('feature')).toBeNull();
  });

  it('maps a gh "not found" failure to GitHubNotFoundError', async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to an Issue (404)' });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });
    await expect(gh.readIssue('o/r#999')).rejects.toBeInstanceOf(GitHubNotFoundError);
  });

  it('maps other gh failures to GitCommandError', async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 1, stdout: '', stderr: 'authentication required' });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });
    await expect(gh.readIssue('o/r#1')).rejects.toBeInstanceOf(GitCommandError);
  });
});

// --- local git against a real temp repo + bare remote (no network) ------------

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

/** Create a bare remote whose `main` branch holds one seed commit, and return its path. */
function makeRemote(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-fleet-git-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '--quiet', '-u', 'origin', 'main']);
  return remote;
}

describe('GitHubCli — local git (real temp repo)', () => {
  it('prepares a working tree, commits + pushes, and reads the branch diff', async () => {
    const remote = makeRemote();
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote });

    const tree = await gh.prepareWorkingTree({ runId: 1, branch: 'agent/run-1', base: 'main' });
    expect(tree).toEqual({ path: join(workingRoot, 'run-1'), branch: 'agent/run-1', base: 'main' });
    // Identify ourselves in the fresh clone so the adapter's `git commit` has an author.
    git(tree.path, ['config', 'user.email', 't@t']);
    git(tree.path, ['config', 'user.name', 'T']);

    writeFileSync(join(tree.path, 'feature.txt'), 'hello\n');
    const commit = await gh.commitAndPush({ workingDir: tree.path, branch: 'agent/run-1', message: 'add feature' });
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);

    const diff = await gh.readDiff({ workingDir: tree.path, base: 'main', branch: 'agent/run-1' });
    expect(diff).toContain('feature.txt');
    expect(diff).toContain('+hello');

    // The branch was pushed to the remote.
    expect(execFileSync('git', ['ls-remote', '--heads', remote, 'agent/run-1'], { encoding: 'utf8' })).toContain('agent/run-1');
  });

  it('re-preparing the same branch keeps existing commits (idempotent for back-edges)', async () => {
    const remote = makeRemote();
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote });

    const tree = await gh.prepareWorkingTree({ runId: 2, branch: 'agent/run-2', base: 'main' });
    git(tree.path, ['config', 'user.email', 't@t']);
    git(tree.path, ['config', 'user.name', 'T']);
    writeFileSync(join(tree.path, 'work.txt'), 'wip\n');
    await gh.commitAndPush({ workingDir: tree.path, branch: 'agent/run-2', message: 'wip' });

    // Re-prepare (as a back-edge would): the branch already exists, so work is preserved.
    const again = await gh.prepareWorkingTree({ runId: 2, branch: 'agent/run-2', base: 'main' });
    expect(again.path).toBe(tree.path);
    const log = git(tree.path, ['log', '--oneline']);
    expect(log).toContain('wip');
  });

  it('restores a pushed branch when the working tree was lost (crash recovery preserves commits)', async () => {
    const remote = makeRemote();
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote });

    const tree = await gh.prepareWorkingTree({ runId: 5, branch: 'agent/run-5', base: 'main' });
    git(tree.path, ['config', 'user.email', 't@t']);
    git(tree.path, ['config', 'user.name', 'T']);
    writeFileSync(join(tree.path, 'pushed.txt'), 'work\n');
    await gh.commitAndPush({ workingDir: tree.path, branch: 'agent/run-5', message: 'pushed work' });

    // Simulate losing the local working tree (crash, moved machine, cleaned tmp).
    rmSync(tree.path, { recursive: true, force: true });

    // Re-preparing must re-clone and restore the *pushed* branch, never reset it to base.
    const restored = await gh.prepareWorkingTree({ runId: 5, branch: 'agent/run-5', base: 'main' });
    expect(restored.path).toBe(tree.path);
    expect(git(tree.path, ['log', '--oneline'])).toContain('pushed work');
  });

  it('clones the working tree from a local checkout but pushes to the GitHub remote', async () => {
    const remote = makeRemote();
    // A local checkout of the same repo (origin = the bare remote), as the operator would have.
    const localRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-local-'));
    const localRepo = join(localRoot, 'checkout');
    git(localRoot, ['clone', remote, localRepo]);

    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote, localRepo });

    const tree = await gh.prepareWorkingTree({ runId: 9, branch: 'agent/run-9', base: 'main' });
    // origin must point at the GitHub remote (the bare repo), not the local checkout we cloned from.
    expect(git(tree.path, ['remote', 'get-url', 'origin']).trim()).toBe(remote);
    git(tree.path, ['config', 'user.email', 't@t']);
    git(tree.path, ['config', 'user.name', 'T']);

    writeFileSync(join(tree.path, 'local-sourced.txt'), 'hi\n');
    await gh.commitAndPush({ workingDir: tree.path, branch: 'agent/run-9', message: 'from local clone' });

    // The branch reached the GitHub remote, not the local checkout.
    expect(execFileSync('git', ['ls-remote', '--heads', remote, 'agent/run-9'], { encoding: 'utf8' })).toContain('agent/run-9');
    expect(execFileSync('git', ['ls-remote', '--heads', localRepo, 'agent/run-9'], { encoding: 'utf8' })).toBe('');
  });

  it('commitAndPush is a no-op when there is nothing to commit', async () => {
    const remote = makeRemote();
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote });

    const tree = await gh.prepareWorkingTree({ runId: 3, branch: 'agent/run-3', base: 'main' });
    const headBefore = git(tree.path, ['rev-parse', 'HEAD']).trim();
    const commit = await gh.commitAndPush({ workingDir: tree.path, branch: 'agent/run-3', message: 'empty' });
    expect(commit.sha).toBe(headBefore); // HEAD unchanged, no new commit
  });
});
