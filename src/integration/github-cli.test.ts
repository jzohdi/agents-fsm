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
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitHubNotFoundError } from './github';
import { GitCommandError, GitHubCli, issueNumber, issueNumberFromUrl, type ExecFn, type ExecResult } from './github-cli';

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

describe('issueNumberFromUrl', () => {
  it('parses the number from a created-issue URL', () => {
    expect(issueNumberFromUrl('https://github.com/o/r/issues/57')).toBe(57);
    expect(issueNumberFromUrl('https://github.com/o/r/issues/57\n')).toBe(57);
  });

  it('throws on output with no trailing number', () => {
    expect(() => issueNumberFromUrl('not a url')).toThrowError(/issue number/);
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
  it('reads an issue, requesting the right fields and parsing the JSON (state lowercased)', async () => {
    const { exec, calls } = stubExec({
      'gh issue': ok(JSON.stringify({ number: 42, title: 'Add auth', body: 'please', state: 'CLOSED' })),
    });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const issue = await gh.readIssue('o/r#42');

    expect(issue).toEqual({ ref: 'o/r#42', number: 42, title: 'Add auth', body: 'please', state: 'closed' });
    expect(calls[0]!.args).toEqual(['issue', 'view', '42', '--repo', 'o/r', '--json', 'number,title,body,state']);
  });

  it('lists open issues with the intake fields, mapping author/assignees/labels (Milestone 11)', async () => {
    const rows = [
      { number: 3, title: 'A', body: 'b', author: { login: 'acme' }, assignees: [{ login: 'dev' }], labels: [{ name: 'bug' }] },
      { number: 5, title: 'C', body: '', author: null, assignees: [], labels: [] }, // missing author → 'unknown'
    ];
    const { exec, calls } = stubExec({ 'gh issue': ok(JSON.stringify(rows)) });
    const gh = new GitHubCli({ repo: 'acme/web', workingRoot: '/w', exec });

    const issues = await gh.listOpenIssues();

    expect(calls[0]!.args).toEqual([
      'issue', 'list', '--repo', 'acme/web', '--state', 'open',
      '--json', 'number,title,body,author,assignees,labels', '--limit', '200',
    ]);
    expect(issues).toEqual([
      { ref: 'acme/web#3', number: 3, title: 'A', body: 'b', author: 'acme', assignees: ['dev'], labels: ['bug'] },
      { ref: 'acme/web#5', number: 5, title: 'C', body: '', author: 'unknown', assignees: [], labels: [] },
    ]);
  });

  it('normalizes a URL `repo` so the `gh api` path is owner/repo, not a broken URL path', async () => {
    // Regression: `--repo https://github.com/jzohdi/tmux-speedrun` once produced
    // `gh api repos/https://github.com/.../comments` → "unsupported protocol scheme".
    const { exec, calls } = stubExec({ 'gh api': ok('[]') });
    const gh = new GitHubCli({ repo: 'https://github.com/jzohdi/tmux-speedrun', workingRoot: '/w', exec });

    await gh.listIssueComments(31);

    expect(calls[0]!.args).toEqual(['api', 'repos/jzohdi/tmux-speedrun/issues/31/comments?per_page=100']);
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

  it('edits an issue then reads it back, sending only the provided fields', async () => {
    const view = JSON.stringify({ number: 7, title: 'Add OAuth', body: 'scoped', state: 'OPEN' });
    const { exec, calls } = stubExec({ 'gh issue': ok(view) });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const issue = await gh.updateIssue({ number: 7, body: 'scoped' });

    expect(issue).toMatchObject({ ref: 'o/r#7', number: 7, title: 'Add OAuth', body: 'scoped' });
    expect(calls[0]!.args.slice(0, 4)).toEqual(['issue', 'edit', '7', '--repo']);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--body', 'scoped']));
    expect(calls[0]!.args).not.toContain('--title');
  });

  it('creates an issue and parses the number from the returned URL', async () => {
    const { exec, calls } = stubExec({ 'gh issue': ok('https://github.com/o/r/issues/58\n') });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const issue = await gh.createIssue({ title: 'piece', body: 'b' });

    expect(issue).toEqual({ ref: 'o/r#58', number: 58, title: 'piece', body: 'b', state: 'open' });
    expect(calls[0]!.args.slice(0, 3)).toEqual(['issue', 'create', '--repo']);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['--title', 'piece', '--body', 'b']));
  });

  it('posts an issue comment via REST, returning id/author/timestamp', async () => {
    const { exec, calls } = stubExec({
      'gh api': ok(JSON.stringify({ id: 555, user: { login: 'fleet[bot]' }, created_at: '2026-06-29T00:00:00Z' })),
    });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const c = await gh.postIssueComment({ issueNumber: 7, body: 'a question' });

    expect(c).toEqual({ id: 555, issueNumber: 7, author: 'fleet[bot]', body: 'a question', createdAt: '2026-06-29T00:00:00Z' });
    expect(calls[0]!.args).toEqual(['api', 'repos/o/r/issues/7/comments', '-f', 'body=a question']);
  });

  it('lists issue comments via REST, mapping author + timestamp', async () => {
    const arr = JSON.stringify([
      { id: 1, user: { login: 'fleet[bot]' }, body: 'q', created_at: '2026-06-29T00:00:00Z' },
      { id: 2, user: { login: 'alice' }, body: 'a', created_at: '2026-06-29T01:00:00Z' },
    ]);
    const { exec, calls } = stubExec({ 'gh api': ok(arr) });
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: '/w', exec });

    const comments = await gh.listIssueComments(7);

    expect(comments).toEqual([
      { id: 1, issueNumber: 7, author: 'fleet[bot]', body: 'q', createdAt: '2026-06-29T00:00:00Z' },
      { id: 2, issueNumber: 7, author: 'alice', body: 'a', createdAt: '2026-06-29T01:00:00Z' },
    ]);
    expect(calls[0]!.args).toEqual(['api', 'repos/o/r/issues/7/comments?per_page=100']);
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

  it('adds a git worktree off a local checkout and pushes to the GitHub remote (Milestone 12 local mode)', async () => {
    const remote = makeRemote();
    // A local checkout of the same repo (origin = the bare remote), as the operator would have.
    const localRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-local-'));
    const localRepo = join(localRoot, 'checkout');
    git(localRoot, ['clone', remote, localRepo]);

    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote, localRepo });

    const tree = await gh.prepareWorkingTree({ runId: 9, branch: 'agent/run-9', base: 'main' });
    // A worktree, not a clone: `.git` is a file pointing back to the shared checkout, and the checkout
    // registers the worktree.
    expect(statSync(join(tree.path, '.git')).isFile()).toBe(true);
    expect(git(localRepo, ['worktree', 'list'])).toContain(tree.path);
    // origin is inherited from the checkout — the GitHub remote — so push/PR target GitHub.
    expect(git(tree.path, ['remote', 'get-url', 'origin']).trim()).toBe(remote);
    git(tree.path, ['config', 'user.email', 't@t']);
    git(tree.path, ['config', 'user.name', 'T']);

    writeFileSync(join(tree.path, 'local-sourced.txt'), 'hi\n');
    await gh.commitAndPush({ workingDir: tree.path, branch: 'agent/run-9', message: 'from worktree' });

    // The branch reached the GitHub remote.
    expect(execFileSync('git', ['ls-remote', '--heads', remote, 'agent/run-9'], { encoding: 'utf8' })).toContain('agent/run-9');

    // dropWorkingTree removes the worktree registration (a plain rm would leave it stale).
    await gh.dropWorkingTree(9);
    expect(git(localRepo, ['worktree', 'list'])).not.toContain(tree.path);
  });

  it('restores a pushed branch into a fresh worktree after the tree was lost (local-mode crash recovery)', async () => {
    const remote = makeRemote();
    const localRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-local-'));
    const localRepo = join(localRoot, 'checkout');
    git(localRoot, ['clone', remote, localRepo]);
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote, localRepo });

    const tree = await gh.prepareWorkingTree({ runId: 11, branch: 'agent/run-11', base: 'main' });
    git(tree.path, ['config', 'user.email', 't@t']);
    git(tree.path, ['config', 'user.name', 'T']);
    writeFileSync(join(tree.path, 'pushed.txt'), 'work\n');
    await gh.commitAndPush({ workingDir: tree.path, branch: 'agent/run-11', message: 'pushed work' });

    await gh.dropWorkingTree(11); // lose the worktree
    const restored = await gh.prepareWorkingTree({ runId: 11, branch: 'agent/run-11', base: 'main' });
    expect(restored.path).toBe(tree.path);
    expect(git(tree.path, ['log', '--oneline'])).toContain('pushed work'); // restored, not reset to base
  });

  it('re-prepares a worktree idempotently when workingRoot is relative (daemon cwd ≠ source repo)', async () => {
    // Regression: the `--work ./.agent-work` default is a *relative* path. The git worktree command runs
    // with `-C localRepo` (resolving it against the source repo) while the `existsSync` reuse guard
    // resolved it against the daemon's process cwd. When those differ — the normal case, daemon started
    // outside the source checkout — the guard always missed and the second prepare hit `worktree add`,
    // failing with "'<branch>' is already used by worktree at …". Path must be absolute for both to agree.
    const remote = makeRemote();
    const localRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-local-'));
    const localRepo = join(localRoot, 'checkout');
    git(localRoot, ['clone', remote, localRepo]);

    // A relative workingRoot, and a process cwd that is NOT the source repo (the temp local root here) —
    // so an unfixed reuse guard would resolve `.agent-work/run-N` to the wrong place and never match.
    const relativeRoot = `.agent-work-${Math.random().toString(36).slice(2)}`;
    const gh = new GitHubCli({ repo: 'o/r', workingRoot: relativeRoot, cloneUrl: remote, localRepo });

    const tree = await gh.prepareWorkingTree({ runId: 42, branch: 'agent/run-42', base: 'main' });
    expect(isAbsolute(tree.path)).toBe(true); // absolute so git and existsSync anchor identically
    expect(tree.path.startsWith(localRepo)).toBe(true); // created under the source checkout, where git put it
    expect(git(localRepo, ['worktree', 'list'])).toContain(tree.path);

    // Re-prepare, as a resume/back-edge does. Before the fix this threw GitCommandError (git 128).
    const again = await gh.prepareWorkingTree({ runId: 42, branch: 'agent/run-42', base: 'main' });
    expect(again.path).toBe(tree.path);
  });

  it('re-adds a worktree after its directory vanished but the registration was left stale', async () => {
    // Crash between the rm and the prune leaves a dangling worktree registration: git still thinks the
    // branch is "already used" though the directory is gone. prepareWorktree now prunes before adding,
    // so recovery does not wedge on that leftover state.
    const remote = makeRemote();
    const localRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-local-'));
    const localRepo = join(localRoot, 'checkout');
    git(localRoot, ['clone', remote, localRepo]);
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote, localRepo });

    const tree = await gh.prepareWorkingTree({ runId: 13, branch: 'agent/run-13', base: 'main' });
    // Delete the directory directly (no `git worktree remove`), leaving the registration behind.
    rmSync(tree.path, { recursive: true, force: true });
    expect(git(localRepo, ['worktree', 'list'])).toContain(tree.path); // still registered (stale)

    const again = await gh.prepareWorkingTree({ runId: 13, branch: 'agent/run-13', base: 'main' });
    expect(again.path).toBe(tree.path);
    expect(statSync(join(again.path, '.git')).isFile()).toBe(true); // a live worktree again
  });

  it('syncBaseBranch fast-forwards a clean on-base checkout, and leaves a dirty/off-base one alone', async () => {
    const remote = makeRemote();
    const localRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-local-'));
    const localRepo = join(localRoot, 'checkout');
    git(localRoot, ['clone', remote, localRepo]);
    git(localRepo, ['config', 'user.email', 't@t']);
    git(localRepo, ['config', 'user.name', 'T']);
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote, localRepo });

    // Advance the remote's main by one commit (through a separate worktree that pushes).
    const wt = await gh.prepareWorkingTree({ runId: 20, branch: 'main-advance', base: 'main' });
    git(wt.path, ['config', 'user.email', 't@t']);
    git(wt.path, ['config', 'user.name', 'T']);
    writeFileSync(join(wt.path, 'landed.txt'), 'landed\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-m', 'landed on main']);
    git(wt.path, ['push', 'origin', 'HEAD:main']);

    // Clean + on main → fast-forwarded to the new tip.
    await gh.syncBaseBranch('main');
    expect(git(localRepo, ['log', '--oneline'])).toContain('landed on main');

    // Dirty tree → left untouched (a second landed commit is fetched but not merged).
    const before = git(localRepo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(localRepo, 'scratch.txt'), 'wip\n'); // dirty
    writeFileSync(join(wt.path, 'landed2.txt'), 'more\n');
    git(wt.path, ['add', '-A']);
    git(wt.path, ['commit', '-m', 'second landing']);
    git(wt.path, ['push', 'origin', 'HEAD:main']);
    await gh.syncBaseBranch('main');
    expect(git(localRepo, ['rev-parse', 'HEAD']).trim()).toBe(before); // working copy not moved
  });

  it('syncBaseBranch is a no-op for clone-on-run mode (no local checkout)', async () => {
    const remote = makeRemote();
    const workingRoot = mkdtempSync(join(tmpdir(), 'agent-fleet-work-'));
    const gh = new GitHubCli({ repo: 'o/r', workingRoot, cloneUrl: remote }); // no localRepo
    await expect(gh.syncBaseBranch('main')).resolves.toBeUndefined();
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
