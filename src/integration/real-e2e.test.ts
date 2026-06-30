/**
 * Flag-gated REAL end-to-end run (Milestone 4b — plans/milestone-4.md §6).
 *
 * This is the only test that spends tokens and touches GitHub, so it is **off by default** and
 * skipped unless `RUN_REAL_E2E=1` — mirroring `RUN_REAL_HARNESS` / `RUN_REAL_GITHUB`. It drives the
 * full pipeline with the real Claude Code subprocess executor, the real composed prompts, and the
 * real `gh`/`git` adapter against a live repo + issue (via the same `buildRealRunner` wiring the CLI
 * uses by default), then asserts the run reached a terminal state and (when `done`) opened a PR.
 *
 * Preconditions (plans/milestone-4.md §6):
 *   - `gh auth status` logged in with push access to the target repo,
 *   - `ANTHROPIC_API_KEY` set,
 *   - the operator-created issue exists and its ref is known.
 *
 * Configure via env:
 *   RUN_REAL_E2E=1
 *   E2E_ISSUE=jzohdi/tmux-speedrun#<n>     # required; the issue ref to run
 *   E2E_BASE=main                          # optional, default "main"
 *   E2E_WORK=./.agent-work                 # optional, default "./.agent-work"
 *   E2E_DB=./.agent-work/e2e.db            # optional; a file DB makes the run resumable
 *   E2E_CHEAP=1                            # optional; pin every phase to the cheap model first
 *
 * The MVP does not auto-merge: a `done` run stops at merge-ready and a human inspects, then closes
 * the PR / deletes the branch (or merges).
 */

import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { EventLoop } from '../loop/event-loop';
import { buildRealRunner } from '../real-run';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';
import { GitHubCli } from './github-cli';

const ENABLED = process.env.RUN_REAL_E2E === '1';

describe.skipIf(!ENABLED)('REAL end-to-end (tmux-speedrun) — flag-gated, spends tokens', () => {
  it(
    'advances a real issue to a terminal state and opens a PR when done',
    async () => {
      const issueRef = process.env.E2E_ISSUE;
      if (!issueRef) throw new Error('RUN_REAL_E2E is set but E2E_ISSUE (e.g. owner/repo#5) is missing');
      const repoRef = issueRef.split('#')[0]!;
      const baseBranch = process.env.E2E_BASE ?? 'main';
      const workingRoot = process.env.E2E_WORK ?? './.agent-work';

      const { fsm, agents, version } = loadDefaultConfig();
      const repo = new Repository(openDb(process.env.E2E_DB ?? ':memory:'));
      const runner = buildRealRunner(repo, agents, { repo: repoRef, baseBranch, workingRoot, cheap: process.env.E2E_CHEAP === '1' });

      const loop = new EventLoop(repo, fsm, version, runner, {
        onTransition: (t) => console.log(`  ${t.fromState} --${t.trigger}--> ${t.toState}`),
      });

      loop.recover();
      const run = loop.startRun({ issueRef, repoRef });
      await loop.runUntilIdle();

      const final = repo.getRun(run.id)!;
      console.log(`Run ${run.id} ended in "${final.currentState}" (status ${final.status}); tokens=${final.tokensUsed}.`);
      expect(['done', 'needs_human']).toContain(final.currentState);

      if (final.currentState === 'done') {
        expect(final.branch).not.toBeNull();
        // Verify the PR really exists on GitHub, not just that we recorded a number.
        const github = new GitHubCli({ repo: repoRef, workingRoot });
        const pr = await github.findOpenPrForBranch(final.branch!);
        expect(pr).not.toBeNull();
        console.log(`Merge-ready PR: ${pr?.url}`);
      }
    },
    // Real agents take minutes per stage; allow the whole pipeline a generous ceiling.
    30 * 60 * 1000,
  );
});
