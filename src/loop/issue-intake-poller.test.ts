/**
 * Issue Intake Poller tests (Milestone 11 — the impure driver of continuous mode). Against the
 * in-memory fake adapter + the real store: only watched repos are scanned, the pure decision is
 * honored end-to-end (auto-start via the RunStarter), the sequential cap holds across passes, guard
 * rejections are logged once, and each repo is evaluated through its own adapter.
 */

import { describe, expect, it } from 'vitest';

import { FakeGitHub } from '../integration/github-fake';
import { EnrolledRepoResolver, singleRepoResolver, type RepoResolver } from '../integration/github-resolver';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { IssueIntakePoller, type RunStarter } from './issue-intake-poller';

const VERSION = 'test-v1';

/** A RunStarter backed by the real store, so a started run shows up in-flight on the next pass. */
function storeStarter(repo: Repository): RunStarter {
  return {
    start: ({ issueRef }) => repo.createRun({ issueRef, repoRef: issueRef.split('#')[0]!, initialState: 'triage', fsmConfigVersion: VERSION }),
  };
}

/** Single-repo fixture: one enrolled repo `acme/web`, its fake adapter, and a log collector. */
function setup(
  options: { watch?: boolean; label?: string | null; filterLabel?: string | null; filterMilestone?: string | null } = {},
) {
  const repo = new Repository(openDb(':memory:'));
  const github = new FakeGitHub({ repoRef: 'acme/web' });
  repo.upsertRepo({ repoRef: 'acme/web', workingRoot: '/tmp/wr' });
  repo.setRepoSource('acme/web', 'clone', null); // a working directory is required to be watched (M12)
  if (options.watch !== false) {
    repo.setRepoWatch('acme/web', true, options.label, {
      filterLabel: options.filterLabel,
      filterMilestone: options.filterMilestone,
    });
  }
  const logs: string[] = [];
  const resolver: RepoResolver = singleRepoResolver({ github, baseBranch: 'main' });
  const poller = new IssueIntakePoller(repo, resolver, storeStarter(repo), (m) => logs.push(m));
  return { repo, github, poller, logs };
}

describe('IssueIntakePoller — watched-repo scanning', () => {
  it('auto-starts a run for the next eligible open issue of a watched repo', async () => {
    const { repo, github, poller } = setup();
    github.seedIssue('acme/web#1', { number: 1, author: 'acme' });

    const pass = await poller.checkOnce();
    expect(pass).toMatchObject({ reposScanned: 1, started: 1 });
    const run = repo.listRuns()[0]!;
    expect(run.issueRef).toBe('acme/web#1');
    // The started run carries an intake log entry (so the operator sees why it appeared).
    expect(repo.listLogs(run.id).some((l) => l.message.includes('auto-picked'))).toBe(true);
  });

  it('does nothing for an enrolled-but-unwatched repo', async () => {
    const { github, poller, repo } = setup({ watch: false });
    github.seedIssue('acme/web#1', { number: 1 });
    const pass = await poller.checkOnce();
    expect(pass).toEqual({ reposScanned: 0, started: 0, skipped: 0 });
    expect(repo.listRuns()).toHaveLength(0);
  });

  it('does not let a repo-bound fake adapter leak issues from another repo into intake decisions', async () => {
    const { repo, github, poller } = setup();
    github.seedIssue('other/repo#1', { number: 1, author: 'other' });
    github.seedIssue('acme/web#2', { number: 2, author: 'acme' });

    const pass = await poller.checkOnce();

    expect(pass).toEqual({ reposScanned: 1, started: 1, skipped: 0 });
    expect(repo.listRuns().map((r) => r.issueRef)).toEqual(['acme/web#2']);
  });
});

describe('IssueIntakePoller — sequential cap across passes', () => {
  it('starts one run, then holds until that issue closes (a merge)', async () => {
    const { repo, github, poller } = setup();
    github.seedIssue('acme/web#1', { number: 1 });
    github.seedIssue('acme/web#2', { number: 2 });

    // Pass 1: #1 admitted.
    expect((await poller.checkOnce()).started).toBe(1);
    // Pass 2: #1 in flight (its run is 'running') → #2 held back, nothing new.
    expect((await poller.checkOnce()).started).toBe(0);
    expect(repo.listRuns()).toHaveLength(1);

    // #1's PR merges → the issue closes → its run finishes; the slot frees and #2 is admitted.
    github.closeIssue(1);
    repo.setRunStatus(repo.listRuns().find((r) => r.issueRef === 'acme/web#1')!.id, 'done');
    expect((await poller.checkOnce()).started).toBe(1);
    expect(repo.listRuns().map((r) => r.issueRef).sort()).toEqual(['acme/web#1', 'acme/web#2']);
  });
});

describe('IssueIntakePoller — guards + logging', () => {
  it('skips guarded issues and logs each rejection exactly once across ticks', async () => {
    const { github, poller, logs, repo } = setup();
    github.seedIssue('acme/web#1', { number: 1, author: 'stranger' }); // non-owner → guarded

    const first = await poller.checkOnce();
    expect(first).toMatchObject({ started: 0, skipped: 1 });
    expect(repo.listRuns()).toHaveLength(0);
    const skipLogs = () => logs.filter((l) => l.startsWith('[issue-intake] skipping acme/web#1'));
    expect(skipLogs()).toHaveLength(1);

    // A second tick with the same unchanged skip does not re-log it (no spam).
    await poller.checkOnce();
    expect(skipLogs()).toHaveLength(1);
  });

  it('logs skipped issues with the operator-visible prefix and override-label hint', async () => {
    const { github, poller, logs } = setup({ label: 'fleet: go' });
    github.seedIssue('acme/web#1', { number: 1, assignees: ['dev'] });

    await poller.checkOnce();

    expect(logs).toContain(
      '[issue-intake] skipping acme/web#1: already assigned to @dev — add the "fleet: go" label to pick it up anyway',
    );
  });

  it('re-logs a skip after the issue clears and later recurs', async () => {
    const { github, poller, logs } = setup();
    github.seedIssue('acme/web#1', { number: 1, author: 'stranger' });
    await poller.checkOnce();
    // The stranger's issue closes → no longer skipped (drops out of the current-skip set).
    github.closeIssue(1);
    await poller.checkOnce();
    // It reopens (a new open issue, same ref, still guarded) → logged again.
    github.seedIssue('acme/web#1', { number: 1, author: 'stranger' });
    await poller.checkOnce();
    expect(logs.filter((l) => l.startsWith('[issue-intake] skipping acme/web#1'))).toHaveLength(2);
  });
});

describe('IssueIntakePoller — scope filter (issue #11)', () => {
  it('a label filter admits only matching issues; a non-matching but otherwise-eligible issue is never picked up', async () => {
    const { repo, github, poller } = setup({ filterLabel: 'bug' });
    // #1 is eligible and lowest-numbered, so WITHOUT the filter it would be picked first — but it lacks
    // the label, so the scope filter excludes it before the guards ever run.
    github.seedIssue('acme/web#1', { number: 1, author: 'acme' });
    github.seedIssue('acme/web#2', { number: 2, author: 'acme', labels: ['bug'] });

    const pass = await poller.checkOnce();

    // Only the matching issue becomes a candidate run…
    expect(pass).toMatchObject({ reposScanned: 1, started: 1 });
    expect(repo.listRuns().map((r) => r.issueRef)).toEqual(['acme/web#2']);
    // …and the excluded issue is filtered out *before* the guards — never a candidate, never a skip.
    expect(pass.skipped).toBe(0);
  });

  it('a milestone filter admits only issues in that milestone', async () => {
    const { repo, github, poller } = setup({ filterMilestone: 'v2' });
    github.seedIssue('acme/web#1', { number: 1, author: 'acme', milestone: 'v1' });
    github.seedIssue('acme/web#2', { number: 2, author: 'acme', milestone: 'v2' });

    const pass = await poller.checkOnce();

    expect(pass).toMatchObject({ reposScanned: 1, started: 1, skipped: 0 });
    expect(repo.listRuns().map((r) => r.issueRef)).toEqual(['acme/web#2']);
  });

  it('when both fields are set, only an issue matching all of them is admitted (match-all)', async () => {
    const { repo, github, poller } = setup({ filterLabel: 'bug', filterMilestone: 'v2' });
    github.seedIssue('acme/web#1', { number: 1, author: 'acme', labels: ['bug'], milestone: 'v1' }); // label only
    github.seedIssue('acme/web#2', { number: 2, author: 'acme', labels: ['chore'], milestone: 'v2' }); // milestone only
    github.seedIssue('acme/web#3', { number: 3, author: 'acme', labels: ['bug'], milestone: 'v2' }); // both

    const pass = await poller.checkOnce();

    expect(pass).toMatchObject({ started: 1, skipped: 0 });
    expect(repo.listRuns().map((r) => r.issueRef)).toEqual(['acme/web#3']);
  });

  it('the scope filter and the safety guards compose: a filtered-in issue must still clear the guards', async () => {
    const { repo, github, poller } = setup({ filterLabel: 'bug' });
    // #1: eligible + lowest, but out of scope (no label) → excluded before the guards, never counted.
    github.seedIssue('acme/web#1', { number: 1, author: 'acme' });
    // #2: in scope but guard-blocked (a stranger filed it) → a skip within the scoped set.
    github.seedIssue('acme/web#2', { number: 2, author: 'stranger', labels: ['bug'] });
    // #3: in scope and eligible → the one admitted.
    github.seedIssue('acme/web#3', { number: 3, author: 'acme', labels: ['bug'] });

    const pass = await poller.checkOnce();

    expect(pass).toMatchObject({ started: 1, skipped: 1 }); // #3 started, #2 skipped, #1 not counted
    expect(repo.listRuns().map((r) => r.issueRef)).toEqual(['acme/web#3']);
  });

  it('with no scope filter set, behaviour is unchanged — all open issues are considered', async () => {
    const { repo, github, poller } = setup();
    github.seedIssue('acme/web#1', { number: 1, author: 'acme', labels: ['bug'] });

    expect((await poller.checkOnce()).started).toBe(1);
    expect(repo.listRuns().map((r) => r.issueRef)).toEqual(['acme/web#1']);
  });
});

describe('IssueIntakePoller — multi-repo isolation', () => {
  it('scans each watched repo through its own adapter, ignoring an unwatched one', async () => {
    const repo = new Repository(openDb(':memory:'));
    const ghA = new FakeGitHub({ repoRef: 'a/one' });
    const ghB = new FakeGitHub({ repoRef: 'b/two' });
    ghA.seedIssue('a/one#1', { number: 1, author: 'a' });
    ghB.seedIssue('b/two#1', { number: 1, author: 'b' });
    repo.upsertRepo({ repoRef: 'a/one', workingRoot: '/tmp/a' });
    repo.upsertRepo({ repoRef: 'b/two', workingRoot: '/tmp/b' });
    repo.setRepoSource('a/one', 'clone', null);
    repo.setRepoSource('b/two', 'clone', null);
    repo.setRepoWatch('a/one', true);
    // b/two enrolled but NOT watched.

    const resolver = new EnrolledRepoResolver(
      (ref) => repo.getRepo(ref),
      (row) => (row.repoRef === 'a/one' ? ghA : ghB),
    );
    const poller = new IssueIntakePoller(repo, resolver, storeStarter(repo), () => {});

    const pass = await poller.checkOnce();
    expect(pass).toMatchObject({ reposScanned: 1, started: 1 });
    expect(repo.listRuns().map((r) => r.repoRef)).toEqual(['a/one']);
  });
});
