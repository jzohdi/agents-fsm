/**
 * Reply Poller (Q1 triage human-in-the-loop).
 *
 * When `triage` asks the human a question, it posts the questions as an issue comment and parks the
 * run in `awaiting_input` (see the Agent Runner + Event Loop). This poller is the cheap, polling-based
 * counterpart that closes the loop: it periodically checks each parked run's issue thread for a human
 * reply and, when it finds one, re-arms the run so the loop re-runs `triage` — which now reads the
 * answer from the thread.
 *
 * Design:
 *  - **Polling, not webhooks.** A single `gh`/API read per parked run per tick; no server, no inbound
 *    networking. This matches the rest of the MVP's polled-signal approach (README §3.5 dependency
 *    clearing) and is the explicit choice for this feature.
 *  - **The transition log is the anchor, not heuristics.** The `await_input` transition's `reason`
 *    records the issue and the exact question comment; a "reply" is unambiguously any *later* comment
 *    by someone other than the bot that asked. No fuzzy matching, so detection is deterministic.
 *  - **`checkOnce` is the pure core**; the timed `poll` driver is a thin loop over it, with an injected
 *    clock + sleep so tests drive it without real time.
 */

import { AWAIT_INPUT_TRIGGER } from './event-loop';
import type { GitHub, IssueComment } from '../integration/github';
import { isRepoResolver, singleRepoResolver, type RepoResolver } from '../integration/github-resolver';
import type { Repository, Run } from '../store/repository';

/** The minimal re-arm surface the poller needs from the Event Loop (it owns the status + event write). */
export interface AwaitingResumer {
  resumeAwaitingInput(runId: number): void;
}

/** What a "new reply" is measured against, read from the latest `await_input` transition's reason. */
interface PendingQuestion {
  issueNumber: number;
  commentId: number;
  botLogin: string;
}

export interface ReplyPollerOptions {
  /** Delay between ticks while runs remain parked, in ms. Default 15s. */
  intervalMs?: number;
  /** Injectable sleep (so tests advance without real time). Default a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 15_000;

export class ReplyPoller {
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly resolver: RepoResolver;

  constructor(
    private readonly repo: Repository,
    // A single repo's adapter (single-repo / mock / tests) or a multi-repo {@link RepoResolver}; the
    // poller reads each parked run's issue thread via *its* repo's adapter (M8 Phase A).
    github: GitHub | RepoResolver,
    private readonly resumer: AwaitingResumer,
    options: ReplyPollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resolver = isRepoResolver(github) ? github : singleRepoResolver({ github, baseBranch: 'main' });
  }

  /**
   * One pass over every `awaiting_input` run: re-arm each whose issue thread has a human reply since
   * its question. Returns how many runs were re-armed. Idempotent — a run already re-armed leaves
   * `awaiting_input`, so the next pass skips it.
   */
  async checkOnce(): Promise<number> {
    let rearmed = 0;
    for (const run of this.repo.listRuns({ status: 'awaiting_input' })) {
      try {
        const reply = await this.findReply(run);
        if (!reply) continue;
        // Record the wake-up on the run's activity stream before re-arming, so the audit trail shows
        // *why* triage re-ran (the dashboard/CLI surface this; the transition log alone wouldn't).
        this.repo.recordLog({
          runId: run.id,
          message: `human reply from @${reply.author} detected — resuming triage`,
          data: { stage: 'triage', kind: 'reply_detected', commentId: reply.id },
        });
        this.resumer.resumeAwaitingInput(run.id);
        rearmed += 1;
      } catch (err) {
        // A transient GitHub/read error on one run must not abort polling for the others; the run
        // stays parked and the next tick retries. Recorded so the operator can see it happened.
        this.repo.recordLog({ runId: run.id, level: 'warn', message: `reply poll failed, will retry: ${String(err)}`, data: { kind: 'poll_error' } });
      }
    }
    return rearmed;
  }

  /**
   * Drive {@link checkOnce} on the configured interval until no run remains parked or `maxWaitMs`
   * elapses, draining the loop after any tick that re-armed something (the poller only re-arms; it
   * does not run stages, so the caller's `drain` is what actually re-runs triage). Returns the total
   * number of runs re-armed. `sleep` and `now` are injectable so tests drive it without real time.
   */
  async poll(opts: { maxWaitMs: number; drain: () => Promise<void>; now?: () => number }): Promise<number> {
    const now = opts.now ?? Date.now;
    const deadline = now() + opts.maxWaitMs;
    let total = 0;
    while (this.repo.listRuns({ status: 'awaiting_input' }).length > 0 && now() < deadline) {
      await this.sleep(this.intervalMs);
      const rearmed = await this.checkOnce();
      if (rearmed > 0) {
        total += rearmed;
        await opts.drain();
      }
    }
    return total;
  }

  /** The human reply (if any) to the run's most recent triage question — a later comment, not the bot's. */
  private async findReply(run: Run): Promise<IssueComment | undefined> {
    const question = this.pendingQuestion(run.id);
    if (!question) return undefined;
    const { github } = this.resolver.for(run.repoRef);
    const comments = await github.listIssueComments(question.issueNumber);
    return comments.find((c) => c.id > question.commentId && c.author !== question.botLogin);
  }

  /** The run's most recent triage question, from the latest `await_input` transition's reason
   *  (parsed defensively — a malformed/absent reason is ignored). */
  private pendingQuestion(runId: number): PendingQuestion | undefined {
    const parked = this.repo.listTransitions(runId).filter((t) => t.trigger === AWAIT_INPUT_TRIGGER).at(-1);
    const reason = parked?.reason;
    if (typeof reason !== 'object' || reason === null) return undefined;
    const { issueNumber, commentId, botLogin } = reason as Record<string, unknown>;
    if (typeof issueNumber !== 'number' || typeof commentId !== 'number' || typeof botLogin !== 'string') return undefined;
    return { issueNumber, commentId, botLogin };
  }
}
