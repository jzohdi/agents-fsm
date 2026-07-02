/**
 * Scheduler Poller (Milestone 9 — the impure driver around the pure {@link ./scheduler}).
 *
 * Everything dependency-ordering that needs the *network* lives here: reading each active run's
 * issue to refresh the cached §3.5 declarations (the issue owns them — a human edit wins within a
 * tick), verifying dependency satisfaction (issue-closed is the signal) to stamp the latch, cycle
 * detection → escalation, and the visible `running ↔ blocked` status flips. Correctness never
 * depends on this poller having ticked: the claim's SQL predicate over the cached columns is the
 * enforcement (see {@link ../store/repository.Repository.claimNextEvent}); this closes the loop and
 * keeps the operator's view honest.
 *
 * Shaped like the Reply / PR Feedback pollers: a `checkOnce` pass the daemon ticks on the shared
 * `--poll-interval` (and the dashboard's on-demand check drives directly), per-run error isolation
 * so one bad GitHub read never aborts the pass, and one `recordLog` line per park/wake/escalation —
 * never per tick. All evaluation is **per repo**: dependency numbers collide across repos, so each
 * repo's runs, closed-issues set, and cycle graph are handled through its own adapter, in isolation.
 */

import type { GitHub, Issue } from '../integration/github';
import { defaultScheduling, parseMarker, sameScheduling, type SchedulingDecl } from '../integration/issue-markers';
import { isRepoResolver, singleRepoResolver, type RepoResolver } from '../integration/github-resolver';
import type { Repository, Run } from '../store/repository';
import { detectCycles, isSatisfied } from './scheduler';

/** The minimal control surface the poller needs from the Event Loop (which owns status legality). */
export interface BlockedController {
  parkBlocked(runId: number): unknown;
  wakeBlocked(runId: number): unknown;
  escalateDependencyCycle(runId: number, reason: unknown): unknown;
}

/** What one {@link SchedulerPoller.checkOnce} pass did — `woken > 0` tells the caller to kick the pump. */
export interface SchedulerPass {
  /** Runs whose cached declarations were refreshed from the issue (a human or triage edit landed). */
  refreshed: number;
  /** Runs parked `blocked` on unsatisfied dependencies. */
  parked: number;
  /** Runs woken `blocked → running` (deps cleared; working tree dropped for a fresh-base re-clone). */
  woken: number;
  /** Runs escalated to `needs_human` as dependency-cycle members. */
  escalated: number;
}

/** A run + its refreshed declaration + its issue, as one pass evaluates it. */
interface Node {
  run: Run;
  issue: Issue;
  decl: SchedulingDecl;
}

export class SchedulerPoller {
  private readonly resolver: RepoResolver;

  constructor(
    private readonly repo: Repository,
    // A single repo's adapter (single-repo / mock / tests) or a multi-repo resolver (M8 Phase A).
    github: GitHub | RepoResolver,
    private readonly loop: BlockedController,
  ) {
    this.resolver = isRepoResolver(github) ? github : singleRepoResolver({ github, baseBranch: 'main' });
  }

  /**
   * One pass over every active (`running`/`blocked`, non-archived) run, repo by repo:
   * refresh declarations → escalate cycles → verify + latch satisfaction → flip statuses.
   * Idempotent: a pass over an already-settled fleet does nothing.
   */
  async checkOnce(): Promise<SchedulerPass> {
    const pass: SchedulerPass = { refreshed: 0, parked: 0, woken: 0, escalated: 0 };
    const active = this.repo.listRuns().filter((r) => (r.status === 'running' || r.status === 'blocked') && r.archivedAt === null);

    for (const runs of partitionByRepo(active).values()) {
      await this.checkRepo(runs, pass);
    }
    return pass;
  }

  /** Evaluate one repo's runs through its own adapter (issue numbers only mean anything per repo). */
  private async checkRepo(runs: Run[], pass: SchedulerPass): Promise<void> {
    const { github } = this.resolver.for(runs[0]!.repoRef);
    // One issue read per issue per pass, shared across a diamond's dependents.
    const issueCache = new Map<string, Promise<Issue>>();
    const readIssue = (issueRef: string): Promise<Issue> => {
      const key = issueRef.toLowerCase();
      let cached = issueCache.get(key);
      if (!cached) {
        cached = github.readIssue(issueRef);
        issueCache.set(key, cached);
      }
      return cached;
    };

    // 1 · Refresh each run's cached declarations from its issue (the issue wins on conflict). A read
    // failure isolates to that run: it keeps its cache this tick and the next tick retries.
    const nodes: Node[] = [];
    for (const run of runs) {
      try {
        const issue = await readIssue(run.issueRef);
        const decl = parseMarker(issue.body) ?? defaultScheduling();
        if (!sameScheduling(decl, { dependsOn: run.dependsOn, priority: run.priority, orderKey: run.orderKey })) {
          this.repo.setRunScheduling(run.id, decl); // clears the latch iff the dep set changed
          pass.refreshed += 1;
        }
        nodes.push({ run: this.repo.getRun(run.id)!, issue, decl });
      } catch (err) {
        this.warn(run.id, `scheduler poll: issue read failed, will retry: ${String(err)}`);
      }
    }

    // 2 · Cycles (this repo's graph only) → escalate every member; members are then excluded from
    // the flip logic below (they are needs_human now, not blocked).
    const issueByRunId = new Map(nodes.map((n) => [n.run.id, n.issue.number]));
    const cycles = detectCycles(nodes.map((n) => ({ runId: n.run.id, issueNumber: n.issue.number, dependsOn: n.decl.dependsOn })));
    const inCycle = new Set(cycles.flat());
    for (const cycle of cycles) {
      const issues = cycle.map((id) => issueByRunId.get(id)!);
      for (const runId of cycle) {
        try {
          this.loop.escalateDependencyCycle(runId, { kind: 'dependency_cycle', runs: cycle, issues });
          this.repo.recordLog({
            runId,
            message: `dependency cycle detected (issues ${issues.map((n) => `#${n}`).join(' → ')}) — escalating every member`,
            data: { kind: 'dependency_cycle', runs: cycle, issues },
          });
          pass.escalated += 1;
        } catch (err) {
          this.warn(runId, `scheduler poll: cycle escalation failed: ${String(err)}`);
        }
      }
    }

    // 3 · Satisfaction + status flips for everyone not in a cycle.
    for (const { run, decl } of nodes) {
      if (inCycle.has(run.id)) continue;
      try {
        await this.settle(run, decl, readIssue, pass);
      } catch (err) {
        this.warn(run.id, `scheduler poll: dependency check failed, will retry: ${String(err)}`);
      }
    }
  }

  /** Verify + latch one run's satisfaction, then mirror it in the visible status. */
  private async settle(run: Run, decl: SchedulingDecl, readIssue: (ref: string) => Promise<Issue>, pass: SchedulerPass): Promise<void> {
    const repoRef = run.repoRef;
    let satisfied = decl.dependsOn.length === 0 || run.depsSatisfiedAt !== null;

    if (!satisfied) {
      const closed = new Set<number>();
      for (const dep of decl.dependsOn) {
        try {
          const issue = await readIssue(`${repoRef}#${dep}`);
          if (issue.state === 'closed') closed.add(dep);
        } catch {
          // Unreadable dep (bad number in the marker, transient error): treat as open this tick —
          // the run stays parked and the dashboard's "waiting on #N" points the operator at it.
        }
      }
      if (isSatisfied(decl.dependsOn, closed)) {
        this.repo.stampDepsSatisfied(run.id); // the latch: never re-verified until the declaration changes
        satisfied = true;
      }
    }

    if (!satisfied && run.status === 'running' && !this.repo.hasProcessingEvent(run.id)) {
      // Park only between stages: flipping under a mid-flight stage would race its commit (which
      // only honors pause/stop) — the claim predicate already holds the run either way, and the
      // next tick parks it visibly once the stage settles.
      this.loop.parkBlocked(run.id);
      this.repo.recordLog({
        runId: run.id,
        message: `dependencies unsatisfied — parked until merged/closed: ${decl.dependsOn.map((n) => `#${n}`).join(', ')}`,
        data: { kind: 'deps_parked', dependsOn: decl.dependsOn },
      });
      pass.parked += 1;
    }

    if (satisfied && run.status === 'blocked') {
      // Fresh-base discipline (§3.1): drop the tree BEFORE the wake flip, so nothing can dispatch
      // against the pre-merge clone (a blocked run holds no executor until the flip).
      const { github } = this.resolver.for(repoRef);
      await github.dropWorkingTree(run.id);
      this.loop.wakeBlocked(run.id);
      this.repo.recordLog({
        runId: run.id,
        message: 'dependencies cleared — waking on a fresh working tree',
        data: { kind: 'deps_woken', dependsOn: decl.dependsOn },
      });
      pass.woken += 1;
    }
  }

  private warn(runId: number, message: string): void {
    this.repo.recordLog({ runId, level: 'warn', message, data: { kind: 'scheduler_poll_error' } });
  }
}

/** Active runs grouped per repo (case-insensitive), each group evaluated in isolation. */
function partitionByRepo(runs: Run[]): Map<string, Run[]> {
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const key = run.repoRef.toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.push(run);
    } else {
      groups.set(key, [run]);
    }
  }
  return groups;
}
