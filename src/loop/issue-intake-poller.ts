/**
 * Issue Intake Poller (Milestone 11 — repo auto-pickup / continuous mode; the impure driver around the
 * pure {@link ./issue-intake.decideIntake}).
 *
 * One `checkOnce` pass, ticked on the shared `--poll-interval`, scans every **watched** enrolled repo
 * (`repos.watch`), lists its open issues through that repo's adapter, and — for the single issue the
 * pure decision selects — starts a run via {@link RunStarter}. Sequential by default (in-flight cap 1):
 * a watched repo gets one run at a time, and the next issue is admitted only once the current run's
 * issue closes (a human merges its PR — §3.5) or is stopped.
 *
 * Shaped like the Reply / PR-Feedback / Scheduler pollers: per-repo error isolation (one repo's bad
 * GitHub read never aborts the pass), and idempotent (a pass over a repo whose slot is full does
 * nothing). It never creates a run itself — it calls the same {@link RunStarter.start} the dashboard's
 * "File a new run" uses, so the dedup guard, cost ceiling, and enrollment checks all still apply.
 */

import type { RepoResolver } from '../integration/github-resolver';
import type { Repository, RunStatus } from '../store/repository';
import { decideIntake, ownerOf, DEFAULT_WATCH_LABEL, type IntakeSkip } from './issue-intake';

/** The one thing the poller needs to admit a run — satisfied by the Orchestrator's `start`. It runs the
 *  same admission path (dedup / cost ceiling / enrollment) and kicks the drain pump. */
export interface RunStarter {
  start(input: { issueRef: string }): { id: number };
}

/** What one {@link IssueIntakePoller.checkOnce} pass did (for logging / the on-demand endpoint). */
export interface IntakePass {
  /** Watched repos scanned this pass. */
  reposScanned: number;
  /** Runs started this pass (at most one per watched repo, sequential). */
  started: number;
  /** Open issues declined by the guards this pass (across all repos). */
  skipped: number;
}

export class IssueIntakePoller {
  /** Skip reasons already logged, so a guard-blocked issue is announced once, not every tick. Rebuilt
   *  each pass from the still-current skips, so an issue that clears and later recurs is logged again. */
  private loggedSkips = new Set<string>();

  constructor(
    private readonly repo: Repository,
    private readonly resolver: RepoResolver,
    private readonly starter: RunStarter,
    private readonly log: (message: string) => void = (m) => console.log(`[issue-intake] ${m}`),
  ) {}

  /** One pass over every watched repo; admits at most one run per repo (sequential cap). */
  async checkOnce(): Promise<IntakePass> {
    const pass: IntakePass = { reposScanned: 0, started: 0, skipped: 0 };
    const currentSkips = new Set<string>();
    for (const repo of this.repo.listRepos()) {
      if (!repo.watch) continue;
      pass.reposScanned += 1;
      try {
        await this.checkRepo(repo.repoRef, repo.watchLabel ?? DEFAULT_WATCH_LABEL, pass, currentSkips);
      } catch (err) {
        // A repo's adapter/read failing isolates to that repo — the next tick retries it.
        this.log(`${repo.repoRef}: intake pass failed, will retry: ${String(err)}`);
      }
    }
    this.loggedSkips = currentSkips; // forget skips no longer current so a recurrence re-logs
    return pass;
  }

  private async checkRepo(repoRef: string, overrideLabel: string, pass: IntakePass, currentSkips: Set<string>): Promise<void> {
    const { github } = this.resolver.for(repoRef);
    const openIssues = await github.listOpenIssues();

    // Latest run status per issue ref: listRuns is newest-first, so the first row per ref is the latest.
    const statusByRef = new Map<string, RunStatus>();
    for (const run of this.repo.listRuns({ repo: repoRef })) {
      const key = run.issueRef.toLowerCase();
      if (!statusByRef.has(key)) statusByRef.set(key, run.status);
    }

    const plan = decideIntake(openIssues, statusByRef, { owner: ownerOf(repoRef), overrideLabel, inFlightCap: 1 });

    for (const skip of plan.skipped) {
      pass.skipped += 1;
      this.announceSkip(skip, currentSkips);
    }

    if (!plan.start) return;
    try {
      const run = this.starter.start({ issueRef: plan.start.issueRef });
      this.repo.recordLog({
        runId: run.id,
        message: `auto-picked from ${repoRef} backlog (watched repo, continuous mode)`,
        data: { kind: 'issue_intake', issueRef: plan.start.issueRef, issueNumber: plan.start.issueNumber },
      });
      pass.started += 1;
      this.log(`started run ${run.id} for ${plan.start.issueRef}`);
    } catch (err) {
      // A lost race (a manual run beat us to the issue → dup guard) or the cost ceiling (429): leave it;
      // the next tick re-evaluates once the conflict clears. Not fatal to the pass.
      this.log(`could not start ${plan.start.issueRef}: ${String(err)}`);
    }
  }

  /** Log a guard rejection the first time it appears (skips have no run row, so they go to the daemon log). */
  private announceSkip(skip: IntakeSkip, currentSkips: Set<string>): void {
    const key = `${skip.ref}:${skip.reason}`;
    currentSkips.add(key);
    if (!this.loggedSkips.has(key)) this.log(`skipping ${skip.ref}: ${skip.reason}`);
  }
}
