/**
 * Issue Intake Poller (Milestone 11 — repo auto-pickup / continuous mode; the impure driver around the
 * pure {@link ./issue-intake.decideIntake}).
 *
 * One `checkOnce` pass, ticked on the shared `--poll-interval`, scans every **watched** enrolled repo
 * (`repos.watch`), lists its open issues through that repo's adapter, and — for each issue the pure
 * decision selects — starts a run via {@link RunStarter}. The per-repo in-flight cap is configurable
 * (`repos.watch_in_flight_cap`, agents-fsm#10), default 1 = sequential: a watched repo gets one run at a
 * time, and the next issue is admitted only once the current run's issue closes (a human merges its PR —
 * §3.5) or is stopped. At a cap of N the decision fills up to N free slots in a single pass (oldest-first).
 *
 * Shaped like the Reply / PR-Feedback / Scheduler pollers: per-repo error isolation (one repo's bad
 * GitHub read never aborts the pass), and idempotent (a pass over a repo whose slot is full does
 * nothing). It never creates a run itself — it calls the same {@link RunStarter.start} the dashboard's
 * "File a new run" uses, so the dedup guard, cost ceiling, and enrollment checks all still apply.
 */

import type { IssueFilter } from '../integration/github';
import type { RepoResolver } from '../integration/github-resolver';
import type { Repo, Repository, RunStatus } from '../store/repository';
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
  /** Runs started this pass (up to each watched repo's free in-flight slots, across all repos). */
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
    private readonly log: (message: string) => void = (m) => console.log(m),
  ) {}

  /** One pass over every watched repo; admits up to each repo's free in-flight slots (configurable cap). */
  async checkOnce(): Promise<IntakePass> {
    const pass: IntakePass = { reposScanned: 0, started: 0, skipped: 0 };
    const currentSkips = new Set<string>();
    for (const repo of this.repo.listRepos()) {
      if (!repo.watch) continue;
      // Defensive: `setRepoWatch` refuses to watch an unconfigured repo, but skip one here too so a repo
      // that lost its source binding never has its auto-picked runs bounce at the start gate (Milestone 12).
      if (repo.sourceMode === null) continue;
      pass.reposScanned += 1;
      try {
        await this.checkRepo(repo, pass, currentSkips);
      } catch (err) {
        // A repo's adapter/read failing isolates to that repo — the next tick retries it.
        this.emit(`${repo.repoRef}: intake pass failed, will retry: ${String(err)}`);
      }
    }
    this.loggedSkips = currentSkips; // forget skips no longer current so a recurrence re-logs
    return pass;
  }

  private async checkRepo(repo: Repo, pass: IntakePass, currentSkips: Set<string>): Promise<void> {
    const repoRef = repo.repoRef;
    const overrideLabel = repo.watchLabel ?? DEFAULT_WATCH_LABEL;
    const { github } = this.resolver.for(repoRef);
    // Scope filter (issue #11): applied at fetch time, so the pure decision below still gets an
    // already-scoped set and the guards run on it unchanged. An all-`null` filter is unconstrained
    // (== no filter), so an unwatched-scope repo behaves exactly as before.
    const filter: IssueFilter = { label: repo.watchFilterLabel, milestone: repo.watchFilterMilestone };
    const openIssues = await github.listOpenIssues(filter);

    // Latest run status per issue ref: listRuns is newest-first, so the first row per ref is the latest.
    const statusByRef = new Map<string, RunStatus>();
    for (const run of this.repo.listRuns({ repo: repoRef })) {
      const key = run.issueRef.toLowerCase();
      if (!statusByRef.has(key)) statusByRef.set(key, run.status);
    }

    const plan = decideIntake(openIssues, statusByRef, {
      owner: ownerOf(repoRef),
      overrideLabel,
      inFlightCap: repo.watchInFlightCap,
    });

    for (const skip of plan.skipped) {
      pass.skipped += 1;
      this.announceSkip(skip, currentSkips);
    }

    // Fill the free slots oldest-first (agents-fsm#10). Each start runs the same admission path the
    // manual "File a new run" uses (dedup / cost ceiling / enrollment), applied independently per issue.
    for (const start of plan.starts) {
      try {
        const run = this.starter.start({ issueRef: start.issueRef });
        this.repo.recordLog({
          runId: run.id,
          message: `auto-picked from ${repoRef} backlog (watched repo, continuous mode)`,
          data: { kind: 'issue_intake', issueRef: start.issueRef, issueNumber: start.issueNumber },
        });
        pass.started += 1;
        this.emit(`started run ${run.id} for ${start.issueRef}`);
      } catch (err) {
        // A lost race (a manual run beat us to the issue → dup guard) or the cost ceiling (429): leave it;
        // the next tick re-evaluates once the conflict clears. Break out of the rest of this pass's starts
        // so we don't hammer the same failure (e.g. the global cost ceiling) once per waiting issue.
        this.emit(`could not start ${start.issueRef}: ${String(err)}`);
        break;
      }
    }
  }

  /** Log a guard rejection the first time it appears (skips have no run row, so they go to the daemon log). */
  private announceSkip(skip: IntakeSkip, currentSkips: Set<string>): void {
    const key = `${skip.ref}:${skip.reason}`;
    currentSkips.add(key);
    if (!this.loggedSkips.has(key)) this.emit(`skipping ${skip.ref}: ${skip.reason}`);
  }

  private emit(message: string): void {
    this.log(`[issue-intake] ${message}`);
  }
}
