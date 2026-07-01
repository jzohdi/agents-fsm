/**
 * PR Feedback Poller — the PR sibling of the Reply Poller (`reply-poller.ts`).
 *
 * A run that reaches a finished state (`done` or `needs_human`) has an open PR that a human reviewer
 * can still comment on. This poller closes that loop: it periodically scans each finished run's open
 * PR for a **new, deterministically-marked** reviewer comment (default marker `feedback:`) and, when
 * it finds one, re-opens the run so the pipeline addresses the feedback — re-entering `plan` by
 * default (see `EventLoop.reopenForPrFeedback`).
 *
 * Design (mirrors the Reply Poller):
 *  - **Polling, not webhooks.** One `getPr` + one `listPrComments` per watched run per tick; no server,
 *    no inbound networking. Consistent with the rest of the MVP's polled-signal approach.
 *  - **Deterministic signal, not heuristics.** A comment is actionable only if its body starts with the
 *    marker (`feedback:`) and it was posted *after the run entered its finished state*. The marker is the
 *    human's explicit "please act on this"; the bot never uses it, so benign chatter and the pipeline's
 *    own review comments are cleanly ignored.
 *  - **The transition log is the anchor** (like the Reply Poller): the run's most recent transition is
 *    the one that moved it into its finished state, so its timestamp is exactly "when the run finished".
 *    A reviewer comment newer than that is unaddressed feedback; a comment older than it (a pipeline
 *    review comment, or discussion from before completion) is not. This needs no stored high-water mark
 *    and is restart-safe: after a re-open the run's *new* finish transition advances the boundary, so an
 *    already-addressed comment never re-triggers.
 *  - **Stops on merge/close.** Once a PR is `merged` or `closed` the run is flagged and never scanned
 *    again — the work is landed (or abandoned), so there is nothing left to iterate on.
 *  - **`checkOnce` is the pure core**; the timed `poll` driver is a thin loop over it with an injected
 *    clock + sleep so tests drive it without real time.
 */

import type { GitHub, PrComment } from '../integration/github';
import { isRepoResolver, singleRepoResolver, type RepoResolver } from '../integration/github-resolver';
import type { Repository, Run } from '../store/repository';

/** The minimal re-entry surface the poller needs from the Event Loop (it owns the transition + event). */
export interface PrFeedbackReopener {
  reopenForPrFeedback(runId: number, reason: unknown): void;
}

/** Default marker a PR comment must start with to be treated as actionable feedback. */
export const DEFAULT_FEEDBACK_MARKER = 'feedback:';

/** Run flag set once a run's PR is merged/closed, so the poller stops scanning it. A boolean run flag. */
export const PR_FEEDBACK_CLOSED_FLAG = 'pr_feedback_closed';

/**
 * What one check of a run's PR produced:
 *  - `reopened`     — new marker feedback (posted after the run finished) was found; the run was re-opened.
 *  - `watching`     — the PR is open with no new feedback since the run finished (still watched).
 *  - `stopped`      — the PR merged/closed, so the run is now flagged and no longer watched.
 *  - `not_watching` — the run isn't a finished run with an open, still-watched PR (nothing to check).
 */
export type PrFeedbackCheck = 'reopened' | 'watching' | 'stopped' | 'not_watching';

export interface PrFeedbackPollerOptions {
  /** Delay between ticks, in ms. Default 15s (matches the Reply Poller). */
  intervalMs?: number;
  /** Marker a comment must start with (case-insensitive, trimmed) to count as feedback. Default `feedback:`. */
  marker?: string;
  /** Injectable sleep (so tests advance without real time). Default a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 15_000;

/**
 * Whether a PR comment body is actionable feedback: it starts with `marker` (case-insensitive, after
 * trimming leading whitespace). Pure and exported so the marker rule is unit-tested directly.
 */
export function isFeedbackComment(body: string, marker: string): boolean {
  return body.trimStart().toLowerCase().startsWith(marker.toLowerCase());
}

/**
 * The comments that should re-open a finished run: those that start with `marker` **and** were posted
 * after `sinceIso` (the moment the run entered its finished state). The finished-state boundary is what
 * separates fresh reviewer feedback from comments left earlier — the pipeline's own review comments, or
 * discussion from before the run finished. GitHub comment timestamps and our transition timestamps are
 * both ISO-8601 UTC, so `Date.parse` compares them directly (tolerating GitHub's second precision vs our
 * millisecond one). An absent boundary (`undefined` — a run with no transitions) counts every marker
 * comment. Pure and exported so the rule is unit-tested with controlled timestamps.
 */
export function newFeedbackComments(comments: PrComment[], marker: string, sinceIso: string | undefined): PrComment[] {
  const since = sinceIso ? Date.parse(sinceIso) : 0;
  return comments.filter((c) => isFeedbackComment(c.body, marker) && Date.parse(c.createdAt) > since);
}

export class PrFeedbackPoller {
  private readonly intervalMs: number;
  private readonly marker: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolver: RepoResolver;

  constructor(
    private readonly repo: Repository,
    // A single repo's adapter (single-repo / mock / tests) or a multi-repo RepoResolver; the poller
    // reads each run's PR via *its* repo's adapter (M8 Phase A), like the Reply Poller.
    github: GitHub | RepoResolver,
    private readonly reopener: PrFeedbackReopener,
    options: PrFeedbackPollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.marker = options.marker ?? DEFAULT_FEEDBACK_MARKER;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resolver = isRepoResolver(github) ? github : singleRepoResolver({ github, baseBranch: 'main' });
  }

  /**
   * One pass over every finished run with an open PR: baseline a newly-seen run, re-open a run whose PR
   * has new marker-matching feedback, and stop watching a run whose PR merged/closed. Returns how many
   * runs were re-opened. A transient error on one run is logged and skipped, never aborting the pass.
   */
  async checkOnce(): Promise<number> {
    let reopened = 0;
    for (const run of this.watchedRuns()) {
      try {
        if ((await this.processRun(run)) === 'reopened') reopened += 1;
      } catch (err) {
        // A transient GitHub/read error on one run must not abort polling for the others; the run stays
        // watched and the next tick retries. Recorded so the operator can see it happened.
        this.repo.recordLog({ runId: run.id, level: 'warn', message: `PR feedback poll failed, will retry: ${String(err)}`, data: { kind: 'pr_feedback_poll_error' } });
      }
    }
    return reopened;
  }

  /**
   * Drive `checkOnce` on the configured interval until `maxWaitMs` elapses, draining the loop after any
   * tick that re-opened something (the poller only re-opens; the caller's `drain` re-runs the re-entered
   * stage). Returns the total number of runs re-opened. `sleep`/`now` are injectable so tests drive it
   * without real time. (The daemon uses `checkOnce` on a timer instead; this exists for the one-shot CLI
   * and tests, mirroring the Reply Poller.)
   */
  async poll(opts: { maxWaitMs: number; drain: () => Promise<void>; now?: () => number }): Promise<number> {
    const now = opts.now ?? Date.now;
    const deadline = now() + opts.maxWaitMs;
    let total = 0;
    while (now() < deadline && this.watchedRuns().length > 0) {
      await this.sleep(this.intervalMs);
      const reopened = await this.checkOnce();
      if (reopened > 0) {
        total += reopened;
        await opts.drain();
      }
    }
    return total;
  }

  /**
   * Check one run's PR on demand (the dashboard's "Check now" button) and report what happened. Returns
   * `not_watching` when the run isn't a finished run with an open, still-watched PR; otherwise the same
   * outcome the background poller acts on. Same idempotent logic as a background tick, so a manual check
   * and a scheduled one are interchangeable.
   */
  async checkRun(runId: number): Promise<PrFeedbackCheck> {
    const run = this.repo.getRun(runId);
    if (!run || !this.isWatchable(run)) return 'not_watching';
    return this.processRun(run);
  }

  /**
   * A finished run (`done`/`needs_human`) that still has an open PR we haven't stopped watching. An
   * **archived** run is excluded: archiving is the operator filing a resolved run away, so we don't
   * resurrect it from a PR comment (that would pop it back into an active lane unexpectedly).
   */
  private isWatchable(run: Run): boolean {
    return (
      (run.status === 'done' || run.status === 'needs_human') &&
      run.prNumber !== null &&
      run.archivedAt === null &&
      run.flags[PR_FEEDBACK_CLOSED_FLAG] !== true
    );
  }

  /** Finished runs (`done`/`needs_human`) that still have an open PR we haven't stopped watching. */
  private watchedRuns(): Run[] {
    return [...this.repo.listRuns({ status: 'done' }), ...this.repo.listRuns({ status: 'needs_human' })].filter((r) =>
      this.isWatchable(r),
    );
  }

  /** Process one watched run; returns the outcome of the check (see {@link PrFeedbackCheck}). */
  private async processRun(run: Run): Promise<Exclude<PrFeedbackCheck, 'not_watching'>> {
    const prNumber = run.prNumber!; // isWatchable filtered out null PRs
    const { github } = this.resolver.for(run.repoRef);

    // Stop watching a landed/abandoned PR: nothing left to iterate on.
    const pr = await github.getPr(prNumber);
    if (pr.state !== 'open') {
      this.repo.mergeRunFlags(run.id, { [PR_FEEDBACK_CLOSED_FLAG]: true });
      this.repo.recordLog({ runId: run.id, message: `PR #${prNumber} is ${pr.state} — no longer watching for feedback`, data: { kind: 'pr_feedback_stopped', prNumber, state: pr.state } });
      return 'stopped';
    }

    const comments = await github.listPrComments(prNumber);
    // Feedback newer than the run's finished-state transition is unaddressed reviewer feedback; anything
    // older (a pipeline review comment, pre-completion discussion) is not. The run's most recent
    // transition is the one that moved it into its finished state, so its timestamp is "when it finished".
    const finishedAt = this.repo.listTransitions(run.id).at(-1)?.createdAt;
    const actionable = newFeedbackComments(comments, this.marker, finishedAt);

    if (actionable.length === 0) return 'watching';

    this.repo.recordLog({
      runId: run.id,
      message: `${actionable.length} new PR feedback comment(s) on #${prNumber} — re-opening for review`,
      data: { stage: 'pr_feedback', kind: 'pr_feedback_detected', prNumber, commentIds: actionable.map((c) => c.id) },
    });
    this.reopener.reopenForPrFeedback(run.id, {
      kind: 'pr_feedback',
      prNumber,
      comments: actionable.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt })),
    });
    return 'reopened';
  }
}
