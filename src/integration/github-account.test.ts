/**
 * Tests for the repo-less {@link GitHubCliAccount} discovery adapter (user-scoped autocomplete).
 *
 * All offline: an injected `exec` returns canned `gh` JSON keyed on the subcommand, so we verify argv
 * construction, JSON parsing, TTL caching (a second `suggest` before the TTL issues no new `gh` calls),
 * substring filtering across repos + issues, and best-effort behaviour when `gh` fails.
 */

import { describe, expect, it } from 'vitest';

import { GitHubCliAccount } from './github-account';
import type { ExecFn, ExecResult } from './github-cli';

function ok(stdout: string): ExecResult {
  return { code: 0, stdout, stderr: '' };
}

const LOGIN = ok('jzohdi\n');
const ORGS = ok(JSON.stringify([{ login: 'acme' }]));
const REPOS = ok(
  JSON.stringify([
    { full_name: 'jzohdi/tmux-speedrun', description: 'terminal speedruns' },
    { full_name: 'acme/web', description: 'storefront' },
  ]),
);
const ISSUES = ok(
  JSON.stringify([
    { repository: { nameWithOwner: 'jzohdi/tmux-speedrun' }, number: 5, title: 'Add split-pane timer' },
    { repository: { nameWithOwner: 'acme/web' }, number: 318, title: 'Checkout token refresh' },
  ]),
);

/** Routes a `gh` call to canned output by inspecting its args; records every invocation. */
function router(overrides: Partial<Record<'login' | 'orgs' | 'repos' | 'issues', ExecResult>> = {}): {
  exec: ExecFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ExecFn = (_file, args) => {
    calls.push(args);
    if (args[0] === 'search' && args[1] === 'issues') return Promise.resolve(overrides.issues ?? ISSUES);
    if (args[0] === 'api' && args[1]?.startsWith('user/repos')) return Promise.resolve(overrides.repos ?? REPOS);
    if (args[0] === 'api' && args[1] === 'user/orgs') return Promise.resolve(overrides.orgs ?? ORGS);
    if (args[0] === 'api' && args[1] === 'user') return Promise.resolve(overrides.login ?? LOGIN);
    return Promise.resolve({ code: 1, stdout: '', stderr: `unrouted: ${args.join(' ')}` });
  };
  return { exec, calls };
}

describe('GitHubCliAccount', () => {
  it('discovers repos + issues and returns repos first, then matching issues', async () => {
    const { exec, calls } = router();
    const account = new GitHubCliAccount({ exec });

    const all = await account.suggest('');
    expect(all.filter((s) => s.kind === 'repo').map((s) => s.ref)).toEqual(['jzohdi/tmux-speedrun', 'acme/web']);
    expect(all.filter((s) => s.kind === 'issue').map((s) => s.ref)).toEqual(['jzohdi/tmux-speedrun#5', 'acme/web#318']);
    // repos are ordered before issues so picking a repo can narrow the type-ahead to its issues
    expect(all[0]?.kind).toBe('repo');

    // Issue search covers the user's login AND their orgs, one call with repeated --owner.
    const search = calls.find((a) => a[0] === 'search');
    expect(search).toContain('--owner');
    expect(search).toContain('jzohdi');
    expect(search).toContain('acme');
    // Repo fetch is scoped to owned + org-member repos.
    expect(calls.find((a) => a[0] === 'api' && a[1]?.startsWith('user/repos'))?.[1]).toContain('affiliation=owner,organization_member');
  });

  it('filters by substring across both ref and title', async () => {
    const { exec } = router();
    const account = new GitHubCliAccount({ exec });

    expect((await account.suggest('tmux')).map((s) => s.ref)).toEqual(['jzohdi/tmux-speedrun', 'jzohdi/tmux-speedrun#5']);
    // matches an issue by its title, not just its ref
    expect((await account.suggest('checkout')).map((s) => s.ref)).toEqual(['acme/web#318']);
    // narrowing to a picked repo surfaces that repo + its issues
    expect((await account.suggest('acme/web')).map((s) => s.ref)).toEqual(['acme/web', 'acme/web#318']);
  });

  it('caches within the TTL (a second suggest issues no new gh calls) and refetches after it', async () => {
    let clock = 1_000;
    const { exec, calls } = router();
    const account = new GitHubCliAccount({ exec, now: () => clock, ttlMs: 1_000 });

    await account.suggest('a');
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    clock += 500; // still fresh
    await account.suggest('b');
    expect(calls.length).toBe(afterFirst);

    clock += 1_000; // past the TTL
    await account.suggest('c');
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('is best-effort: an unauthenticated gh yields no suggestions rather than throwing', async () => {
    // Every gh call fails (as it would when logged out); suggest still resolves to [] rather than throwing.
    const exec: ExecFn = (_file, _args) => Promise.resolve({ code: 1, stdout: '', stderr: 'gh: not logged in' });
    const account = new GitHubCliAccount({ exec });
    await expect(account.suggest('anything')).resolves.toEqual([]);
  });

  it('survives a rejecting exec (missing gh binary / timeout kill) without wedging the cache', async () => {
    // A rejected exec (spawn failure or a timeout SIGTERM) must be caught so the single-flight refresh
    // still completes — otherwise every later suggest would await a dead promise. A follow-up call works.
    const exec: ExecFn = () => Promise.reject(new Error('spawn gh ENOENT'));
    const account = new GitHubCliAccount({ exec });
    await expect(account.suggest('x')).resolves.toEqual([]);
    await expect(account.suggest('y')).resolves.toEqual([]); // not wedged on the first refresh's promise
  });

  it('still discovers the user\'s own repos when org lookup fails (no read:org scope)', async () => {
    const { exec } = router({ orgs: { code: 1, stdout: '', stderr: 'HTTP 403' } });
    const account = new GitHubCliAccount({ exec });
    const repos = (await account.suggest('')).filter((s) => s.kind === 'repo').map((s) => s.ref);
    expect(repos).toEqual(['jzohdi/tmux-speedrun', 'acme/web']);
  });

  it('coalesces concurrent suggests into a single refresh (no gh storm on rapid keystrokes)', async () => {
    const { exec, calls } = router();
    const account = new GitHubCliAccount({ exec });

    // Three keystrokes fired before the first refresh resolves must share one refresh, not trigger three.
    await Promise.all([account.suggest('a'), account.suggest('ab'), account.suggest('abc')]);

    expect(calls.filter((a) => a[0] === 'search').length).toBe(1);
    expect(calls.filter((a) => a[0] === 'api' && a[1]?.startsWith('user/repos')).length).toBe(1);
  });

  it('caps the number of repo and issue rows returned', async () => {
    const manyRepos = ok(JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ full_name: `me/repo-${i}`, description: '' }))));
    const manyIssues = ok(
      JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ repository: { nameWithOwner: `me/repo-${i}` }, number: i, title: `t${i}` }))),
    );
    const { exec } = router({ repos: manyRepos, issues: manyIssues });
    const account = new GitHubCliAccount({ exec, repoResults: 3, issueResults: 5 });

    const out = await account.suggest('repo');
    expect(out.filter((s) => s.kind === 'repo')).toHaveLength(3);
    expect(out.filter((s) => s.kind === 'issue')).toHaveLength(5);
  });
});
