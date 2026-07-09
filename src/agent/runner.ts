/**
 * Agent Runner (Layer 4 — see README §3.3, plans/milestone-4.md §3.1).
 *
 * Runs one stage end to end as an agent *work session*:
 *  1. **Prepare** the stage's context per its declared I/O (read the issue; for produce/review
 *     stages ensure the working tree exists, creating the branch the first time; inject the diff
 *     for code review).
 *  2. **Run the phase recipe** — produce, then a bounded self-review → fix loop — calling the
 *     swappable `StageExecutor` (the harness) once per phase, with bounded retry on malformed
 *     output and an `agent_runs` row + usage per invocation.
 *  3. **Apply git/GitHub side effects** on a handoff — commit/push, find-or-open the PR, post
 *     review comments — through the `GitHub` adapter (agents never touch git/GitHub directly).
 *
 * It depends on the store, the agent config (the recipe), and the GitHub adapter, but NOT on the
 * FSM engine — the engine decides the *next* stage from the envelope; the runner only produces it.
 * Git/GitHub failures are caught and returned as a structured escalation, never a bare throw, so
 * the loop parks the run in `needs_human` with the cause in the log (plans/milestone-4.md §3.10).
 */

import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import { recipeFor, type AgentsConfig, type StageIo } from '../fsm/config';
import { ADDRESSING_PR_FEEDBACK_FLAG, MERGE_CONFLICT_TRIGGER, RESOLVE_CONFLICTS_STATE, RESUME_TRIGGER, REVERT_TRIGGER } from '../loop/event-loop';
import type { BaseSync, GitHub, Issue, IssueComment, PullRequest } from '../integration/github';
import { BOT_COMMENT_MARKER, defaultScheduling, parseMarker, upsertMarker, type SchedulingDecl } from '../integration/issue-markers';
import { isRepoResolver, singleRepoResolver, type RepoContext, type RepoResolver } from '../integration/github-resolver';
import type { AgentPhase, ChatExchange, ConflictPolicy, Repository, Run, Transition } from '../store/repository';
import type { AgentActivity, AgentRunResult, StageExecutor } from './executor';
import { DEFAULT_HARNESS, isHarnessResolver, singleHarness, type HarnessResolver } from './harness';
import {
  parseEnvelope,
  parseReviewVerdict,
  parseTriageOutput,
  type AgentEnvelope,
  type ArtifactRef,
  type Parsed,
  type TriageOutput,
  type TriageScheduling,
} from './envelope';
import { AmbiguousSideEffectError, SideEffectLedger } from './side-effects';

/**
 * Default logical model per phase. `simplify` is the review loop's **fix** phase (prompts/phases/
 * simplify.md): it is handed the blocking findings a frontier reviewer raised, and a weaker model
 * reliably fails to resolve them — the loop then never converges and trips the review cap, which
 * costs an escalation + a human + a re-run, dwarfing the tokens saved. So it defaults to the
 * frontier role too; a stage whose fixes are mechanical can set `models.simplify: 'cheap'` in its
 * agent config to restore the economy.
 */
export const DEFAULT_MODELS: Record<AgentPhase, string> = {
  produce: 'frontier',
  self_review: 'frontier',
  simplify: 'frontier',
};

/**
 * The logical role a per-run model override replaces — the primary produce/review model. This mirrors
 * the `--model` flag, which remaps this same role daemon-wide (see `real-run` `modelMap.frontier`), so
 * an operator's per-run pick affects the real work while the cheaper `simplify` pass stays cheap.
 */
export const OVERRIDE_ROLE = 'frontier';

/**
 * The concrete model to run a phase under. When a run carries a `modelOverride` (the dashboard's model
 * dropdown) it replaces the {@link OVERRIDE_ROLE} logical name; every other phase (and an unset override)
 * falls through to the recipe's logical model for the Layer-5 executor to resolve as before. Pure and
 * exported so the override precedence is unit-tested directly.
 */
export function phaseModel(logical: string, override: string | null): string {
  return override && logical === OVERRIDE_ROLE ? override : logical;
}

/**
 * Tools the conflict resolver is pre-approved to use (Claude Code reads this as `--allowedTools`, so a
 * headless run never stalls on a permission prompt it cannot answer — the bug where the resolver's
 * `Write`/`Edit` were blocked and it spun retrying). It reads and rewrites the conflicted files, and
 * that is all it needs. **Deliberately no `Bash`**: the resolver must not run git commands (checkout
 * --ours, merge --abort, add/commit) that would disturb the in-progress merge the runner concludes
 * itself via `finishBaseMerge` — the prompt says so, and withholding the tool enforces it. Cursor
 * ignores this list (its `-p --force` grants write/shell wholesale).
 */
export const RESOLVE_CONFLICTS_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'];

/**
 * The pseudo-stage label a run-chat invocation runs under (the operator's "general chat" side
 * channel). Like {@link RESOLVE_CONFLICTS_STATE} it is not an FSM state — chat is an orchestrator-
 * owned side operation the engine never sees — but it is the `agent_runs.stage` label and the
 * prompt-composition key, so telemetry and the dashboard read a clear "chat".
 */
export const CHAT_STAGE = 'chat';

/**
 * Tools a **read**-mode chat is granted: inspect-only file tools plus the read-only git commands
 * (the same grant `code_review` gets), so the agent can answer questions about the branch/PR while
 * a stage may be running — nothing here can disturb the working tree. Cursor ignores allow-lists
 * (`-p --force` grants write/shell wholesale), so for Cursor runs the read-only rule is carried by
 * the chat prompt instead of the harness.
 */
export const CHAT_READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];

/** Tools a **write**-mode chat is granted — the full producing-stage grant (`frontend`/`backend`),
 *  since a write chat only ever runs while the pipeline is parked (no stage to race). */
export const CHAT_WRITE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

/**
 * The pseudo-stage label an escalation-resolution advisor invocation runs under (the dashboard's
 * "Suggest resolutions" button — Layer 3, see README §9.5). Like {@link CHAT_STAGE} it is NOT an FSM
 * state — the advisor is an operator-initiated, read-only side operation the engine never sees — but
 * it is the `agent_runs.stage` telemetry label and the prompt-composition key.
 */
export const ADVISE_STAGE = 'advise';

/**
 * Tools the advisor is granted: inspect-only, identical shape to {@link CHAT_READ_TOOLS} — the
 * advisor reads the run's artifacts + tree + the escalation reason and proposes resolutions; it never
 * mutates. (Cursor ignores allow-lists; the read-only rule is carried by the advise prompt there.)
 */
export const ADVISE_READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];

/** How many prior completed exchanges ride along as the chat's conversation context. */
const CHAT_HISTORY_LIMIT = 10;

/** What a chat invocation produced: the reply shown to the operator, its token usage (stored on the
 *  exchange for per-prompt telemetry), plus (write mode) the pushed commit. */
export interface ChatResult {
  response: string;
  tokens: number;
  commitSha?: string;
}

/** One suggested resolution the advisor proposes for a stuck (needs_human) run (Layer 3). */
export interface AdviceOption {
  /** Short imperative label for the card, e.g. "Accept the reviewer's findings and retry". */
  label: string;
  /** Why this option resolves the escalation — one or two sentences. */
  rationale: string;
  /** The control action this card maps to. `resume` retries the escalated-from state;
   *  `revert` sends the run back to an earlier state. */
  action: 'resume' | 'revert';
  /** For `revert`, the target state to revert to. Omitted for `resume` (which always returns to the
   *  escalated-from state, derived by the loop itself). */
  toState?: string;
  /** Operator guidance pre-filled into the guidance box when this card is selected. */
  suggestedNotes?: string;
}

/** What one advisor invocation produced: a plain-English summary + 1–3 options (first = recommended). */
export interface AdviceResult {
  summary: string;
  options: AdviceOption[];
}

/** Default base branch a run's working branch is cut from and diffed against. */
export const DEFAULT_BASE_BRANCH = 'main';
/** Default number of extra attempts on malformed output before escalating (plans/milestone-4.md §3.5). */
export const DEFAULT_MALFORMED_RETRY_CAP = 1;

/** The result of running a stage: hand the envelope to the engine, escalate, or wait on a human. */
export type StageOutcome =
  | { kind: 'handoff'; envelope: AgentEnvelope }
  | { kind: 'escalate'; trigger: string; reason: unknown }
  /**
   * `triage` asked the human a question on the issue and is now waiting for a reply. The loop parks
   * the run in `awaiting_input` (no follow-up event); the Reply Poller re-arms it when a human replies.
   */
  | { kind: 'await_input'; reason: unknown };

/** Builds the per-phase system prompt. The real implementation is `createSystemPromptFn`
 * (agent/prompts.ts); injected via {@link AgentRunnerOptions.systemPrompt} for real runs. */
export type SystemPromptFn = (stage: string, phase: AgentPhase) => string;

/** Default used by stub/fake runs that don't inject real prompts (the demo CLI, most unit tests). */
const defaultSystemPrompt: SystemPromptFn = (stage, phase) => `[${stage}:${phase}] system prompt (stub — inject createSystemPromptFn for real runs)`;

/**
 * Why the current stage is being *re-run* rather than visited for the first time — delivered to the
 * agent as the `reentry` input field (documented in prompts/base.md). This is the delivery half of
 * README §2's "every back-edge carries a structured reason so the target state knows why it is being
 * re-run": the reasons were always *recorded* in the transition log; this hands them to the stage.
 */
export interface ReentryContext {
  kind: 'operator_resume' | 'operator_revert' | 'back_edge';
  /** What sent the run back: the escalation trigger (e.g. `internal_review_cap`), `revert`, or the back-edge trigger. */
  trigger: string;
  /** The structured payload that sent the run back (the escalation reason / the reviewing stage's issues). */
  reason?: unknown;
  /** Free-text guidance the operator typed (resume notes / a string revert reason). */
  operatorNotes?: string;
}

/**
 * Derive the {@link ReentryContext} for a stage dispatch from the run's transition log: the latest
 * transition, when it re-entered `currentState` via an operator resume/revert or an agent back-edge.
 * A first visit, a forward handoff, or an `await_input` re-arm (triage reads the human's reply from
 * the issue thread instead) yields `undefined`. Pure, so the classification is unit-tested directly.
 */
export function reentryContext(transitions: readonly Transition[], currentState: string): ReentryContext | undefined {
  const last = transitions[transitions.length - 1];
  if (!last || last.toState !== currentState) return undefined;

  if (last.trigger === RESUME_TRIGGER) {
    // The escalation this resume undoes: the latest transition out of this stage into the state the
    // resume came from (the escalation state — matched structurally so no FSM config is needed here).
    const escalation = [...transitions].reverse().find((t) => t.fromState === currentState && t.toState === last.fromState);
    const notes = operatorResumeNotes(last.reason);
    return {
      kind: 'operator_resume',
      trigger: escalation?.trigger ?? RESUME_TRIGGER,
      ...(escalation?.reason != null ? { reason: escalation.reason } : {}),
      ...(notes !== undefined ? { operatorNotes: notes } : {}),
    };
  }
  if (last.trigger === REVERT_TRIGGER) {
    return {
      kind: 'operator_revert',
      trigger: REVERT_TRIGGER,
      // The dashboard's revert form sends a plain string — surface it as the operator's words.
      ...(typeof last.reason === 'string' ? { operatorNotes: last.reason } : last.reason != null ? { reason: last.reason } : {}),
    };
  }
  if (last.backEdge) {
    return { kind: 'back_edge', trigger: last.trigger, ...(last.reason != null ? { reason: last.reason } : {}) };
  }
  return undefined;
}

/** The operator's notes from a guided-resume transition reason (`{ kind: 'operator_resume', notes }`). */
function operatorResumeNotes(reason: unknown): string | undefined {
  if (reason && typeof reason === 'object' && typeof (reason as { notes?: unknown }).notes === 'string') {
    return (reason as { notes: string }).notes;
  }
  return undefined;
}

/**
 * The per-visit review-cap bump an operator attached to the resume that re-entered this stage (0 when
 * none). Parsed from the latest resume transition's `{ kind: 'operator_resume', extraRounds }` reason
 * — so it applies only to the resumed re-run and expires once the run advances (Layer 3,
 * `internal_review_cap` escalations). Pure and exported so the parse is unit-tested directly.
 */
export function operatorResumeExtraRounds(reason: unknown): number {
  if (reason && typeof reason === 'object') {
    const extra = (reason as { extraRounds?: unknown }).extraRounds;
    if (typeof extra === 'number' && Number.isInteger(extra) && extra > 0) return extra;
  }
  return 0;
}

/** The reason of the latest transition that re-entered `currentState` via an operator resume (else
 *  undefined) — the record a per-visit `extraRounds` bump rides on. */
function latestResumeReason(transitions: readonly Transition[], currentState: string): unknown {
  const last = transitions[transitions.length - 1];
  if (last && last.toState === currentState && last.trigger === RESUME_TRIGGER) return last.reason;
  return undefined;
}

/** One live activity from a running stage, carrying the run context the bare {@link AgentActivity} lacks. */
export interface PhaseActivity {
  runId: number;
  stage: string;
  phase: AgentPhase;
  activity: AgentActivity;
}

export interface AgentRunnerOptions {
  systemPrompt?: SystemPromptFn;
  /** Base branch new working branches are cut from. Default {@link DEFAULT_BASE_BRANCH}. */
  baseBranch?: string;
  /** Extra attempts on malformed output before escalating. Default {@link DEFAULT_MALFORMED_RETRY_CAP}. */
  malformedRetryCap?: number;
  /**
   * Optional live-progress sink for the CLI/dashboard. The runner already persists every streamed
   * activity to the log stream; this is the in-process push so a watcher can render it as it happens
   * (the seam the API's WebSocket stream subscribes to, M5). Best-effort — a throwing sink is ignored.
   */
  onActivity?: (activity: PhaseActivity) => void;
}

/** Per-phase extras layered onto the agent input. */
interface PhaseExtra {
  producedEnvelope?: AgentEnvelope;
  reviewNotes?: unknown;
  /**
   * Which round of the bounded self-review → fix loop this phase runs in (1-based, of `cap`), with
   * the previous round's verdict notes once there are any. Lets the reviewer *verify the prior
   * findings were resolved* instead of re-reviewing cold each round — the convergence half of the
   * review-cap guard (documented in prompts/base.md).
   */
  reviewRound?: { round: number; cap: number; previousNotes?: unknown };
  /** On a malformed-output retry: why the previous attempt failed, so the agent can correct it. */
  retry?: { attempt: number; previousError: string };
}

/** The context a stage runs in: the issue, the prepared working tree (if any), and stage input. */
interface StagePrep {
  issue: Issue;
  workingDir?: string;
  branch?: string;
  /** Stage input merged into the agent's input (the issue, and the diff for code review). */
  input: Record<string, unknown>;
}

export class AgentRunner {
  private readonly systemPrompt: SystemPromptFn;
  private readonly githubResolver: RepoResolver;
  private readonly harnesses: HarnessResolver;
  private readonly malformedRetryCap: number;
  private readonly onActivity?: (activity: PhaseActivity) => void;

  constructor(
    private readonly repo: Repository,
    // A single harness executor (mock / tests) or a multi-harness {@link HarnessResolver}; the former is
    // normalized to a one-harness resolver so the rest of the runner resolves per-run identically. A run
    // is dispatched to the executor its `harness` id names (per-run harness selection).
    harnesses: StageExecutor | HarnessResolver,
    private agents: AgentsConfig,
    // A single repo's adapter (single-repo / mock / tests) or a multi-repo {@link RepoResolver}; the
    // former is normalized to a one-repo resolver so the rest of the runner is repo-agnostic (M8).
    github: GitHub | RepoResolver,
    options: AgentRunnerOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.harnesses = isHarnessResolver(harnesses) ? harnesses : singleHarness(harnesses);
    this.githubResolver = isRepoResolver(github)
      ? github
      : singleRepoResolver({ github, baseBranch: options.baseBranch ?? DEFAULT_BASE_BRANCH });
    this.malformedRetryCap = options.malformedRetryCap ?? DEFAULT_MALFORMED_RETRY_CAP;
    this.onActivity = options.onActivity;
  }

  /** The adapter + base branch for a run's repo (M8 Phase A). Memoized inside the resolver, so the
   *  repeated calls across a stage's helper methods all return the same adapter instance. */
  private repoContext(run: Run): RepoContext {
    return this.githubResolver.for(run.repoRef);
  }

  /**
   * Swap the per-stage agent recipe (M5 `updateConfig`). Paired with {@link EventLoop.setConfig};
   * the Orchestrator calls both only while no run is in flight, so a running stage is never
   * re-pointed at a changed recipe.
   */
  setAgents(agents: AgentsConfig): void {
    this.agents = agents;
  }

  /** Run the run's current stage to completion and return its outcome. */
  async runStage(run: Run): Promise<StageOutcome> {
    const recipe = recipeFor(run.currentState, this.agents);

    // triage is a router/editor with its own contract and GitHub side effects (edit issue, ask the
    // human, split), so it has a dedicated path rather than the produce/review pipeline below.
    if (recipe.io.kind === 'triage') return this.runTriageStage(run, recipe);

    // 1. Prepare the stage context (issue + working tree + stage input).
    let prep: StagePrep;
    try {
      prep = await this.prepareStage(run, recipe.io);
    } catch (err) {
      return gitError(run, 'prepare', err);
    }

    // 1.5 Between-stage base sync: fold the latest base into the branch so the run never drifts into
    //     an unmergeable PR. A conflict either auto-resolves (repo policy `auto`, a verified resolver
    //     invocation) or parks the run for the operator (`manual`). Skipped for triage above — the
    //     branch has no commits of its own yet, so there is nothing to conflict.
    const syncOutcome = await this.syncWithBase(run, prep);
    if (syncOutcome) return syncOutcome;

    // 2. Run the phase recipe. Executor throws propagate (the loop escalates `executor_error`);
    //    only malformed *output* is retried-then-escalated here.
    const phaseOutcome = await this.runPhases(run, recipe, prep);
    if (phaseOutcome.kind !== 'handoff') return phaseOutcome;

    // 3. Apply this stage's git/GitHub side effects on a handoff.
    try {
      const envelope = await this.applyStageEffects(run, recipe.io, prep, phaseOutcome.envelope);
      return { kind: 'handoff', envelope };
    } catch (err) {
      return effectsError(run, err);
    }
  }

  /**
   * A per-stage {@link SideEffectLedger} (the transactional outbox, README Milestone 7) keyed at this
   * run's current state and visit index. The prefix `${state}#${visit}` makes the slot keys stable
   * across a crash/replay of the same visit (so completed calls are reused, not repeated) yet fresh on
   * a legitimate re-entry (a back-edge or operator resume bumps the visit → side effects run anew).
   */
  private ledgerFor(run: Run): SideEffectLedger {
    const visit = this.repo.stateVisitCount(run.id, run.currentState);
    return new SideEffectLedger(this.repo, run.id, `${run.currentState}#${visit}`);
  }

  // --- triage (router / issue editor) -----------------------------------------

  /**
   * Run the `triage` stage: read the issue *and its comment thread* (so a re-run after a human reply
   * sees the answer), let the agent decide, then perform the GitHub side effects its decision implies
   * (improve the issue, ask the human, split into smaller issues) and map it to a {@link StageOutcome}.
   */
  private async runTriageStage(run: Run, recipe: Recipe): Promise<StageOutcome> {
    const { github, baseBranch } = this.repoContext(run);
    let issue: Issue;
    let comments: IssueComment[];
    let workingDir: string;
    let branch: string;
    try {
      issue = await github.readIssue(run.issueRef);
      comments = await github.listIssueComments(issue.number);
      // Prepare the repo checkout so triage runs *inside the target repository*, not the daemon's own
      // cwd (Milestone 12 — the tmux-speedrun#35 failure). triage needs to inspect the codebase to scope
      // the issue; without a working tree the harness subprocess would inherit `process.cwd()`. No commit
      // or push happens in triage (that's only in produce stages), so creating the local branch here is
      // harmless and `plan` reuses it.
      branch = run.branch ?? branchName(run, issue.title);
      const tree = await github.prepareWorkingTree({ runId: run.id, branch, base: baseBranch });
      if (run.branch === null) this.repo.setRunBranch(run.id, branch);
      workingDir = tree.path;
    } catch (err) {
      return gitError(run, 'prepare', err);
    }
    // The comment thread is the human↔agent conversation; pass it so triage can read the latest reply.
    const prep: StagePrep = {
      issue,
      workingDir,
      branch,
      input: { issue, comments: comments.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt })) },
    };

    // triage runs a single produce phase against its own decision contract (retry, then escalate).
    const parsed = await this.invokeParsed(run, 'produce', recipe, prep, {}, parseTriageOutput);
    if (!parsed.ok) return malformed('produce', parsed.error, parsed.raw);

    try {
      return await this.applyTriageDecision(run, issue, parsed.value);
    } catch (err) {
      return effectsError(run, err);
    }
  }

  /**
   * Carry out one triage decision's GitHub side effects and turn it into a {@link StageOutcome}.
   *
   * Idempotency note: editing the issue is idempotent, but posting comments and creating sub-issues
   * are not. The non-idempotent calls go through the {@link SideEffectLedger} (the transactional
   * outbox, README Milestone 7): on a crash/replay a completed call is reused rather than repeated
   * (no duplicate comment or sub-issues), and a call left in-flight by a crash escalates instead of
   * blindly retrying. Editing the issue stays a direct call (re-writing the same text is harmless).
   */
  private async applyTriageDecision(run: Run, issue: Issue, output: TriageOutput): Promise<StageOutcome> {
    const { github } = this.repoContext(run);
    const ledger = this.ledgerFor(run);

    // Improve the issue first, if the agent rewrote it, so every downstream stage reads the scoped
    // spec — folding any `scheduling` declaration into the §3.5 marker block in the same write (the
    // agent supplies values; this runner owns the byte format — integration/issue-markers). A block
    // already in the issue is *carried*: a body rewrite that dropped it gets it re-inserted, and a
    // partial declaration overlays only the fields the agent set, so a human's edits are never
    // silently stripped. Editing to the same text is harmless, keeping a back-edge re-run idempotent.
    let current = issue;
    const baseBody = output.issueUpdate?.body ?? issue.body;
    const carried = parseMarker(baseBody) ?? parseMarker(issue.body);
    const declared = output.scheduling ? overlayScheduling(carried ?? defaultScheduling(), output.scheduling) : carried;
    const body = declared ? upsertMarker(baseBody, declared) : baseBody;
    if (output.issueUpdate || output.scheduling) {
      current = await github.updateIssue({
        number: issue.number,
        ...(output.issueUpdate?.title !== undefined ? { title: output.issueUpdate.title } : {}),
        body,
      });
    }
    // Cache the final body's declarations on the run — unconditionally, so a pre-declared block (a
    // human's, or one just written above) gates the run's very next stage without waiting for a
    // Scheduler Poller tick (M9 plan §3.4). A split handoff below retargets the run to a child issue,
    // and `setRunIssueRef` resets this cache with it.
    this.repo.setRunScheduling(run.id, parseMarker(current.body) ?? defaultScheduling());

    switch (output.decision) {
      case 'proceed': {
        // Sign off with a human-visible audit comment, then hand to plan. The FSM transition is the
        // machine sign-off later stages key off; this comment is for people reading the issue.
        await ledger.once('signoff', () => github.postIssueComment({ issueNumber: current.number, body: signoffComment(output.message) }));
        return { kind: 'handoff', envelope: { requestedTransition: 'proceed', reason: { kind: 'triage_signoff' } } };
      }

      case 'clarify': {
        const questions = output.questions ?? [];
        const comment = await ledger.once('clarify', () => github.postIssueComment({ issueNumber: current.number, body: clarifyComment(questions, output.message) }));
        // The await_input reason carries everything the Reply Poller needs to detect the human's
        // answer — the issue, the question comment to measure replies against, and the bot login that
        // distinguishes the agent's own comment from a human reply. The loop records it in the
        // transition log, which is where the poller reads it from (no separate marker store).
        return {
          kind: 'await_input',
          reason: { kind: 'needs_more_detail', questions, issueNumber: current.number, commentId: comment.id, botLogin: comment.author },
        };
      }

      case 'split': {
        const subIssues = output.subIssues ?? [];
        const created: Issue[] = [];
        // Each child gets its own ledger slot, so a crash partway through never re-creates the ones
        // already made (the duplicate-sub-issues case the outbox exists to prevent — README M7).
        for (let i = 0; i < subIssues.length; i++) {
          created.push(await ledger.once(`subissue:${i}`, () => github.createIssue(subIssues[i]!)));
        }
        await ledger.once('split', () => github.postIssueComment({ issueNumber: current.number, body: splitComment(created, output.message) }));

        if (output.handoff === undefined) {
          // No handoff: the operator starts runs for the children; this run stops with them recorded.
          return { kind: 'escalate', trigger: 'should_split', reason: { kind: 'should_split', created: created.map(issueSummary) } };
        }
        // Hand off: continue THIS run on the chosen child (retarget); the siblings await the operator.
        const chosen = created[output.handoff]!;
        this.repo.setRunIssueRef(run.id, chosen.ref);
        const siblings = created.filter((_, i) => i !== output.handoff).map((c) => c.ref);
        return {
          kind: 'handoff',
          envelope: { requestedTransition: 'proceed', reason: { kind: 'triage_split_handoff', continuingOn: chosen.ref, siblings } },
        };
      }
    }
  }

  // --- stage preparation ------------------------------------------------------

  /**
   * Read the issue and ensure the run's working tree exists (creating + persisting the branch the
   * first time). The tree-and-branch primitive shared by {@link prepareStage} and the standalone
   * {@link resolveConflicts} — both need a checked-out branch to operate on, nothing stage-specific.
   */
  private async prepareTree(run: Run): Promise<{ issue: Issue; workingDir: string; branch: string }> {
    const { github, baseBranch } = this.repoContext(run);
    const issue = await github.readIssue(run.issueRef);
    const branch = run.branch ?? branchName(run, issue.title);
    const tree = await github.prepareWorkingTree({ runId: run.id, branch, base: baseBranch });
    if (run.branch === null) this.repo.setRunBranch(run.id, branch);
    return { issue, workingDir: tree.path, branch };
  }

  private async prepareStage(run: Run, io: StageIo): Promise<StagePrep> {
    const { github, baseBranch } = this.repoContext(run);
    const { issue, workingDir, branch } = await this.prepareTree(run);

    const input: Record<string, unknown> = { issue };
    // code_review (a review stage with a PR) inspects the branch diff itself via its git tools, so
    // we give it the base branch to diff against rather than injecting a (possibly huge) diff — the
    // harness manages its own context (plans/milestone-4.md §3.6). plan_review has no PR and reads
    // `.agent/plan.md` from the tree, so it needs neither.
    if (io.kind === 'review' && run.prNumber !== null) {
      input.base = baseBranch;
    }
    // PR-feedback cycle: a finished run re-opened to address reviewer comments already has an open PR
    // (the flag is set only by that re-open, so the first build pass is unaffected). Give every stage
    // the PR + its comment thread so it *iterates on the existing work* — refining the plan/interface/
    // code and addressing the feedback — instead of rebuilding the PR from scratch. The prompts (base.md)
    // tell the agent how to use these fields.
    if (run.flags[ADDRESSING_PR_FEEDBACK_FLAG] === true && run.prNumber !== null) {
      const prComments = await github.listPrComments(run.prNumber);
      input.pullRequest = { number: run.prNumber, branch, addressingFeedback: true };
      input.prFeedback = prComments.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt }));
    }
    return { issue, workingDir, branch, input };
  }

  // --- between-stage base sync (merge-conflict handling) -----------------------

  /** The repo's merge-conflict policy, read fresh from the registry at stage time (a dashboard change
   *  applies from the very next stage). Runs without a registry row (one-shot CLI, mocks) get the
   *  conservative default: `manual`. */
  private conflictPolicy(run: Run): ConflictPolicy {
    return this.repo.getRepo(run.repoRef)?.conflictPolicy ?? 'manual';
  }

  /**
   * Fold the latest base into the run's branch **before the stage runs**, so long-lived runs never
   * drift into an unmergeable PR (the "every stage pulls latest first" rule). Returns `undefined` to
   * proceed (up to date, merged clean, or conflicts resolved-and-verified) or an escalation outcome.
   * Invariant: **the tree is never left mid-merge** — every failure path aborts the merge first.
   */
  private async syncWithBase(run: Run, prep: StagePrep): Promise<StageOutcome | undefined> {
    const { github, baseBranch } = this.repoContext(run);
    let sync: BaseSync;
    try {
      sync = await github.syncBranchWithBase(run.id, baseBranch);
    } catch (err) {
      return gitError(run, 'sync_base', err);
    }
    if (sync.result === 'merged') {
      // The clean merge commit rides out on the stage's own push later; nothing to do here.
      this.repo.recordLog({
        runId: run.id,
        message: `merged the latest ${baseBranch} into ${prep.branch} cleanly (between-stage base sync)`,
        data: { kind: 'base_sync', stage: run.currentState, result: 'merged' },
      });
    }
    if (sync.result !== 'conflict') return undefined;

    const policy = this.conflictPolicy(run);
    const reason = { kind: 'merge_conflict', stage: run.currentState, base: baseBranch, files: sync.conflictFiles, policy };
    if (policy !== 'auto') {
      // Manual policy: the operator resolves (merge base into the branch themselves, push, resume) —
      // or clicks "Resolve merge conflicts" to invoke the resolver on demand.
      await github.abortBaseMerge(run.id);
      return { kind: 'escalate', trigger: MERGE_CONFLICT_TRIGGER, reason };
    }

    // Auto policy: the resolver runs over the in-progress merge (executor throws propagate → the loop
    // escalates executor_error). Success → proceed to the stage; failure → escalate with the evidence.
    const finish = await this.resolveInProgressMerge(run, prep, baseBranch, sync.conflictFiles);
    if (finish.ok) {
      this.repo.recordLog({
        runId: run.id,
        message: `resolved ${sync.conflictFiles.length} merge-conflicted file(s) with ${baseBranch} and pushed (auto policy)`,
        data: { kind: 'base_sync', stage: run.currentState, result: 'resolved', files: sync.conflictFiles },
      });
      return undefined;
    }
    if ('gitError' in finish) return gitError(run, 'sync_base', finish.gitError);
    return { kind: 'escalate', trigger: MERGE_CONFLICT_TRIGGER, reason: { ...reason, resolutionAttempted: true, unresolved: finish.unresolved } };
  }

  /**
   * Resolve a merge that is **already in progress** (a conflict was detected): run one resolver
   * invocation over the conflicted files, then conclude the merge via mechanical verification
   * ({@link GitHub.finishBaseMerge} — never trusts the agent's self-report). Shared by the between-
   * stage {@link syncWithBase} and the standalone {@link resolveConflicts}.
   *
   * Invariant: **always leaves the tree clean.** A resolver throw aborts the merge then propagates
   * (the loop escalates `executor_error`); a verification miss or a git failure aborts and is reported.
   */
  private async resolveInProgressMerge(
    run: Run,
    prep: StagePrep,
    baseBranch: string,
    files: string[],
  ): Promise<{ ok: true } | { ok: false; unresolved: string[] } | { ok: false; gitError: unknown }> {
    const { github } = this.repoContext(run);
    try {
      await this.invokeConflictResolver(run, prep, baseBranch, files);
    } catch (err) {
      await github.abortBaseMerge(run.id); // restore the tree, then let the caller propagate executor_error
      throw err;
    }
    try {
      const finish = await github.finishBaseMerge(run.id, prep.branch!); // prepareTree always sets branch
      if (!finish.ok) await github.abortBaseMerge(run.id); // markers remained → roll back to a clean tree
      return finish;
    } catch (err) {
      await github.abortBaseMerge(run.id);
      return { ok: false, gitError: err };
    }
  }

  /**
   * **Standalone** merge-conflict resolution for a *finished* run whose PR drifted into conflict with
   * base — the dedicated `resolve_conflicts` operation the loop dispatches (from the PR poller under
   * `auto` policy, or the operator's "Resolve merge conflicts" button). Unlike the between-stage sync
   * it runs *no pipeline*: it merges base, resolves+pushes, and reports back so the loop returns the
   * run to the finished state it came from.
   *
   * Because invoking it *is* the authorization (a human clicked, or auto policy opted in), it always
   * runs the resolver on a conflict — the `manual` gate is the between-stage sync's job, not this one.
   */
  async resolveConflicts(run: Run): Promise<{ kind: 'resolved' } | { kind: 'escalate'; reason: unknown }> {
    const { github, baseBranch } = this.repoContext(run);
    let prep: StagePrep;
    try {
      prep = { ...(await this.prepareTree(run)), input: {} };
    } catch (err) {
      return { kind: 'escalate', reason: { kind: 'merge_conflict', stage: RESOLVE_CONFLICTS_STATE, base: baseBranch, op: 'prepare', detail: String(err) } };
    }
    let sync: BaseSync;
    try {
      sync = await github.syncBranchWithBase(run.id, baseBranch);
    } catch (err) {
      return { kind: 'escalate', reason: { kind: 'merge_conflict', stage: RESOLVE_CONFLICTS_STATE, base: baseBranch, op: 'sync_base', detail: String(err) } };
    }
    if (sync.result !== 'conflict') {
      // Nothing to reconcile. A clean merge must still be pushed (no later stage will do it here); an
      // `up_to_date` branch already contains base, so its PR is mergeable and there is nothing to push.
      if (sync.result === 'merged') {
        try {
          await github.commitAndPush({ workingDir: prep.workingDir!, branch: prep.branch!, message: `Merge latest ${baseBranch}` });
        } catch (err) {
          return { kind: 'escalate', reason: { kind: 'merge_conflict', stage: RESOLVE_CONFLICTS_STATE, base: baseBranch, op: 'sync_base', detail: String(err) } };
        }
      }
      this.repo.recordLog({
        runId: run.id,
        message: sync.result === 'merged' ? `merged the latest ${baseBranch} and pushed — no conflicts` : `already up to date with ${baseBranch} — nothing to resolve`,
        data: { kind: 'conflict_resolution', result: sync.result },
      });
      return { kind: 'resolved' };
    }

    const finish = await this.resolveInProgressMerge(run, prep, baseBranch, sync.conflictFiles);
    if (finish.ok) {
      this.repo.recordLog({
        runId: run.id,
        message: `resolved ${sync.conflictFiles.length} merge-conflicted file(s) with ${baseBranch} and pushed`,
        data: { kind: 'conflict_resolution', result: 'resolved', files: sync.conflictFiles },
      });
      return { kind: 'resolved' };
    }
    const detail = 'gitError' in finish ? { op: 'finish_merge', detail: String(finish.gitError) } : { unresolved: finish.unresolved };
    return {
      kind: 'escalate',
      reason: { kind: 'merge_conflict', stage: RESOLVE_CONFLICTS_STATE, base: baseBranch, files: sync.conflictFiles, resolutionAttempted: true, ...detail },
    };
  }

  // --- run chat (the operator's per-run "general chat" side channel) -----------

  /**
   * Run one claimed chat exchange to completion — the operator's ad-hoc prompt against this run's
   * working tree. Not a stage: no envelope, no FSM transition; the agent's reply is the product. The
   * caller (the Orchestrator's chat pump) owns the exchange lifecycle and the safety scheduling —
   * by the time this runs, a `write` exchange is guaranteed alone on the run (paused-like status, no
   * stage in flight, stage dispatch gated on it), while a `read` exchange may legitimately overlap a
   * running stage (its tool grant cannot disturb the tree).
   *
   * Read mode: answer from the tree/branch/PR with the read-only grant. Write mode: do the work,
   * then commit-if-dirty + push through the adapter (agents never run git), so e.g. "fix the failing
   * build" lands on the run's open PR. Usage is charged to the run's tokens/cost (real spend, and the
   * cost ceiling must see it) but deliberately NOT `agentRuns` — the run budget bounds the *pipeline's*
   * loops, and operator-initiated chat must not eat the stages' budget. Throws on failure; the caller
   * records the error on the exchange.
   */
  async runChat(run: Run, exchange: ChatExchange): Promise<ChatResult> {
    const { github, baseBranch } = this.repoContext(run);
    const prep = await this.prepareTree(run);
    const history = this.repo
      .listChatExchanges(run.id)
      .filter((c) => c.status === 'done' && c.id !== exchange.id)
      .slice(-CHAT_HISTORY_LIMIT)
      .map((c) => ({ mode: c.mode, prompt: c.prompt, response: c.response }));

    // Same model/effort override precedence as any produce phase — the chat answers for the run, so
    // it runs on the run's picked model.
    const model = phaseModel(DEFAULT_MODELS.produce, run.modelOverride);
    const effort = run.effortOverride && DEFAULT_MODELS.produce === OVERRIDE_ROLE ? run.effortOverride : undefined;
    const input = {
      issueRef: run.issueRef,
      repoRef: run.repoRef,
      stage: CHAT_STAGE,
      phase: 'produce',
      issue: prep.issue,
      base: baseBranch,
      artifacts: this.repo.listArtifacts(run.id),
      run: { state: run.currentState, status: run.status },
      chat: { mode: exchange.mode, prompt: exchange.prompt, history },
      ...(run.prNumber !== null ? { pullRequest: { number: run.prNumber, branch: prep.branch } } : {}),
    };

    const startedAt = Date.now();
    let result: AgentRunResult;
    try {
      const executor = this.harnesses.for(run.harness);
      result = await executor.run({
        runId: run.id,
        stage: CHAT_STAGE,
        phase: 'produce',
        model,
        ...(effort ? { effort } : {}),
        system: this.systemPrompt(CHAT_STAGE, 'produce'),
        input,
        onActivity: (activity) => this.handleActivity(run.id, CHAT_STAGE, 'produce', activity),
        allowedTools: exchange.mode === 'write' ? CHAT_WRITE_TOOLS : CHAT_READ_TOOLS,
        workingDir: prep.workingDir,
      });
    } catch (err) {
      // Same telemetry contract as invokePhase: record the failed invocation, then propagate.
      this.repo.recordAgentRun({
        runId: run.id,
        stage: CHAT_STAGE,
        phase: 'produce',
        model,
        input,
        output: { error: String(err) },
        tokens: 0,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      throw err;
    }
    this.repo.recordAgentRun({
      runId: run.id,
      stage: CHAT_STAGE,
      phase: 'produce',
      model,
      input,
      output: result.output,
      tokens: result.usage.tokens,
      durationMs: Date.now() - startedAt,
      success: true,
    });
    this.repo.addRunUsage(run.id, { tokens: result.usage.tokens, cost: result.usage.cost });

    const response = chatResponseText(result.output);
    if (exchange.mode !== 'write') return { response, tokens: result.usage.tokens };

    // Write mode: everything the agent left in the tree is the deliverable — commit-if-dirty and
    // push through the adapter (base.md's "the tree is committed verbatim" rule applies to chat too).
    const commit = await github.commitAndPush({
      workingDir: prep.workingDir,
      branch: prep.branch,
      message: chatCommitMessage(exchange.prompt),
    });
    this.repo.recordLog({
      runId: run.id,
      message: `chat: committed and pushed the agent's changes (${commit.sha.slice(0, 7)})`,
      data: { kind: 'chat', mode: exchange.mode, sha: commit.sha },
    });
    return { response, tokens: result.usage.tokens, commitSha: commit.sha };
  }

  /**
   * One read-only advisor invocation over a `needs_human` run (Layer 3 — the dashboard's "Suggest
   * resolutions" button). Reads the run's artifacts + the escalation trigger/reason and returns a
   * plain-English summary + 1–3 resolution options. Modeled exactly on {@link runChat} (read mode):
   * prepareTree, same model/effort override precedence, record telemetry via `recordAgentRun` (stage
   * `advise`, phase `produce`), add usage via `addRunUsage` WITHOUT bumping `agentRuns` (operator-
   * initiated work must not eat the pipeline budget — cost still counts toward the global ceiling).
   * Read-only: leaves the tree untouched (no commit/push). Malformed output degrades to a graceful
   * fallback (advisory, never load-bearing); an executor failure is recorded then rethrown.
   */
  async runAdvisor(run: Run): Promise<AdviceResult & { tokens: number }> {
    const { baseBranch } = this.repoContext(run);
    const prep = await this.prepareTree(run);

    // The escalation this advisor is reasoning about: the latest transition into the run's current
    // (escalation) state — located structurally, the same way resumeRun/escalationModel do, so no
    // `src/fsm/` import is needed here.
    const escalation = [...this.repo.listTransitions(run.id)].reverse().find((t) => t.toState === run.currentState);

    // Same model/effort override precedence as any produce phase / chat — the advisor reasons about
    // the run, so it runs on the run's picked model.
    const model = phaseModel(DEFAULT_MODELS.produce, run.modelOverride);
    const effort = run.effortOverride && DEFAULT_MODELS.produce === OVERRIDE_ROLE ? run.effortOverride : undefined;
    const input = {
      issueRef: run.issueRef,
      repoRef: run.repoRef,
      stage: ADVISE_STAGE,
      phase: 'produce',
      issue: prep.issue,
      base: baseBranch,
      artifacts: this.repo.listArtifacts(run.id),
      run: { state: run.currentState, status: run.status },
      escalation: { trigger: escalation?.trigger ?? null, reason: escalation?.reason ?? null },
      ...(run.prNumber !== null ? { pullRequest: { number: run.prNumber, branch: prep.branch } } : {}),
    };

    const startedAt = Date.now();
    let result: AgentRunResult;
    try {
      const executor = this.harnesses.for(run.harness);
      result = await executor.run({
        runId: run.id,
        stage: ADVISE_STAGE,
        phase: 'produce',
        model,
        ...(effort ? { effort } : {}),
        system: this.systemPrompt(ADVISE_STAGE, 'produce'),
        input,
        onActivity: (activity) => this.handleActivity(run.id, ADVISE_STAGE, 'produce', activity),
        allowedTools: ADVISE_READ_TOOLS,
        workingDir: prep.workingDir,
      });
    } catch (err) {
      // Same telemetry contract as invokePhase/runChat: record the failed invocation, then propagate.
      this.repo.recordAgentRun({
        runId: run.id,
        stage: ADVISE_STAGE,
        phase: 'produce',
        model,
        input,
        output: { error: String(err) },
        tokens: 0,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      throw err;
    }
    this.repo.recordAgentRun({
      runId: run.id,
      stage: ADVISE_STAGE,
      phase: 'produce',
      model,
      input,
      output: result.output,
      tokens: result.usage.tokens,
      durationMs: Date.now() - startedAt,
      success: true,
    });
    // No `agentRuns: 1` — operator-initiated advice must not eat the pipeline budget (like chat).
    this.repo.addRunUsage(run.id, { tokens: result.usage.tokens, cost: result.usage.cost });

    return { ...parseAdvice(result.output), tokens: result.usage.tokens };
  }

  /**
   * One conflict-resolver harness invocation over the working tree's in-progress merge. Telemetry is
   * recorded under the {@link RESOLVE_CONFLICTS_STATE} pseudo-stage (phase `produce` — the column's
   * CHECK set is closed; the stage label carries the meaning). The agent's *text output is ignored*:
   * whether the conflicts are actually gone is judged mechanically by `finishBaseMerge`, so a resolver
   * that lies (or rambles) can never sneak markers into a commit.
   */
  private async invokeConflictResolver(run: Run, prep: StagePrep, base: string, files: string[]): Promise<void> {
    // Same model/effort override precedence as any produce phase — the resolver reconciles *intent*
    // between the branch and base, frontier-grade work (cf. the simplify-model lesson above).
    const model = phaseModel(DEFAULT_MODELS.produce, run.modelOverride);
    const effort = run.effortOverride && DEFAULT_MODELS.produce === OVERRIDE_ROLE ? run.effortOverride : undefined;
    const input = {
      issueRef: run.issueRef,
      repoRef: run.repoRef,
      stage: RESOLVE_CONFLICTS_STATE,
      phase: 'produce',
      issue: prep.issue,
      conflict: { base, branch: prep.branch, files },
    };

    const startedAt = Date.now();
    let result: AgentRunResult;
    try {
      const executor = this.harnesses.for(run.harness);
      result = await executor.run({
        runId: run.id,
        stage: RESOLVE_CONFLICTS_STATE,
        phase: 'produce',
        model,
        ...(effort ? { effort } : {}),
        system: this.systemPrompt(RESOLVE_CONFLICTS_STATE, 'produce'),
        input,
        onActivity: (activity) => this.handleActivity(run.id, RESOLVE_CONFLICTS_STATE, 'produce', activity),
        // Pre-approve the edit tools so a headless run never stalls on a permission prompt (see the
        // constant's doc) — the same grant the producing stages get, minus Bash.
        allowedTools: RESOLVE_CONFLICTS_ALLOWED_TOOLS,
        ...(prep.workingDir ? { workingDir: prep.workingDir } : {}),
      });
    } catch (err) {
      // Same telemetry contract as invokePhase: record the failed invocation, then propagate.
      this.repo.recordAgentRun({
        runId: run.id,
        stage: RESOLVE_CONFLICTS_STATE,
        phase: 'produce',
        model,
        input,
        output: { error: String(err) },
        tokens: 0,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      throw err;
    }
    this.repo.recordAgentRun({
      runId: run.id,
      stage: RESOLVE_CONFLICTS_STATE,
      phase: 'produce',
      model,
      input,
      output: result.output,
      tokens: result.usage.tokens,
      durationMs: Date.now() - startedAt,
      success: true,
    });
    this.repo.addRunUsage(run.id, { tokens: result.usage.tokens, cost: result.usage.cost, agentRuns: 1 });
  }

  // --- phase recipe (produce → bounded self-review → simplify) ----------------

  private async runPhases(run: Run, recipe: Recipe, prep: StagePrep): Promise<StageOutcome> {
    const produced = await this.invokeParsed(run, 'produce', recipe, prep, {}, parseEnvelope);
    if (!produced.ok) return malformed('produce', produced.error, produced.raw);
    let envelope = produced.value;

    // Pure review stages (no self-review configured): hand off the produced envelope.
    if (!recipe.phases.includes('self_review')) return { kind: 'handoff', envelope };

    // Per-resume review-budget override (Layer 3): an operator resuming an `internal_review_cap`
    // escalation can attach `extraRounds` to give the loop more room *for this visit only*. It rides
    // on the same latest resume transition the re-entry context reads, so it naturally expires once
    // the run advances (a later escalation → a fresh resume without it → back to recipe.reviewCap).
    const extraRounds = operatorResumeExtraRounds(latestResumeReason(this.repo.listTransitions(run.id), run.currentState));
    const effectiveCap = recipe.reviewCap + extraRounds;

    let lastNotes: unknown;
    for (let round = 0; round < effectiveCap; round++) {
      // Round context: the reviewer verifies the previous round's findings were resolved (rather
      // than re-reviewing cold), and both phases know how much round budget remains (the effective,
      // possibly-bumped cap — so the reviewer/fixer see the real budget).
      const reviewRound = { round: round + 1, cap: effectiveCap, ...(round > 0 ? { previousNotes: lastNotes } : {}) };
      const verdict = await this.invokeParsed(run, 'self_review', recipe, prep, { producedEnvelope: envelope, reviewRound }, parseReviewVerdict);
      if (!verdict.ok) return malformed('self_review', verdict.error, verdict.raw);
      if (verdict.value.acceptable) return { kind: 'handoff', envelope };

      lastNotes = verdict.value.notes;
      if (recipe.phases.includes('simplify')) {
        const fixed = await this.invokeParsed(
          run,
          'simplify',
          recipe,
          prep,
          { producedEnvelope: envelope, reviewNotes: lastNotes, reviewRound },
          parseEnvelope,
        );
        if (!fixed.ok) return malformed('simplify', fixed.error, fixed.raw);
        envelope = fixed.value;
      }
    }

    // Cap hit while the review still reports blocking issues: escalate (README §2 guards). The reported
    // cap is the effective one (recipe + any per-resume extraRounds), so a re-hit after a budget bump
    // shows the real ceiling.
    return { kind: 'escalate', trigger: 'internal_review_cap', reason: { kind: 'internal_review_cap', cap: effectiveCap, notes: lastNotes } };
  }

  /**
   * Invoke a phase and parse its output, retrying a bounded number of times on malformed output
   * (LLM nondeterminism often yields valid JSON on a retry) before giving up — never coerce
   * (README §3.3 Layer 4, plans/milestone-4.md §3.5).
   */
  private async invokeParsed<T>(
    run: Run,
    phase: AgentPhase,
    recipe: Recipe,
    prep: StagePrep,
    extra: PhaseExtra,
    parse: (raw: unknown) => Parsed<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: string; raw: unknown }> {
    let lastError = '';
    let lastRaw: unknown;
    for (let attempt = 0; attempt <= this.malformedRetryCap; attempt++) {
      // On a retry, tell the agent why its previous output was rejected so it can correct it.
      const attemptExtra = attempt === 0 ? extra : { ...extra, retry: { attempt, previousError: lastError } };
      const raw = await this.invokePhase(run, phase, recipe, prep, attemptExtra);
      const parsed = parse(raw);
      if (parsed.ok) return { ok: true, value: parsed.value };
      lastError = parsed.error;
      lastRaw = raw;
    }
    return { ok: false, error: lastError, raw: lastRaw };
  }

  /** One phase invocation: call the executor (harness), record telemetry + usage, return the raw output. */
  private async invokePhase(run: Run, phase: AgentPhase, recipe: Recipe, prep: StagePrep, extra: PhaseExtra): Promise<unknown> {
    // The run's model override (dashboard dropdown) replaces the frontier role; `run` is the snapshot the
    // loop loaded when this stage was dispatched, so the whole stage uses one model and a mid-run change
    // is picked up by the *next* stage's fresh dispatch (README event loop). null override → default.
    const logical = recipe.models[phase] ?? DEFAULT_MODELS[phase];
    const model = phaseModel(logical, run.modelOverride);
    // The run's reasoning-effort override pairs with the model override: both target the frontier
    // role, so a phase a stage explicitly configured onto a cheaper logical model keeps its default
    // effort (and its model) rather than being silently promoted.
    const effort = run.effortOverride && logical === OVERRIDE_ROLE ? run.effortOverride : undefined;
    // Why this stage is being re-run (operator resume/revert, agent back-edge), if it is — the
    // escalation reason + operator guidance would otherwise sit unread in the transition log.
    const reentry = reentryContext(this.repo.listTransitions(run.id), run.currentState);
    const input = {
      issueRef: run.issueRef,
      repoRef: run.repoRef,
      stage: run.currentState,
      phase,
      // Durable artifacts + minimal state slice — never prior transcripts (README §3.3 Layer 4).
      artifacts: this.repo.listArtifacts(run.id),
      ...(reentry ? { reentry } : {}),
      ...prep.input,
      ...extra,
    };

    const startedAt = Date.now();
    let result: AgentRunResult;
    try {
      // Resolve the harness per stage inside the try: precedence is `recipe.harness` (per-stage
      // override) > `run.harness` (per-run, pinned at start) > DEFAULT_HARNESS. An unknown/unregistered
      // id throws here and is recorded as a failed agent_run + rethrown, so the loop escalates the one
      // run (executor_error → needs_human) rather than silently switching harness or crashing the drain.
      const executor = this.harnesses.for(recipe.harness ?? run.harness ?? DEFAULT_HARNESS);
      result = await executor.run({
        runId: run.id,
        stage: run.currentState,
        phase,
        model,
        ...(effort ? { effort } : {}),
        system: this.systemPrompt(run.currentState, phase),
        input,
        onActivity: (activity) => this.handleActivity(run.id, run.currentState, phase, activity),
        ...(prep.workingDir ? { workingDir: prep.workingDir } : {}),
        ...(recipe.allowedTools ? { allowedTools: recipe.allowedTools } : {}),
      });
    } catch (err) {
      // The executor threw after exhausting its own retries (Layer 5). Record the failed
      // invocation for telemetry, then propagate so the loop escalates `executor_error`.
      this.repo.recordAgentRun({
        runId: run.id,
        stage: run.currentState,
        phase,
        model,
        input,
        output: { error: String(err) },
        tokens: 0,
        durationMs: Date.now() - startedAt,
        success: false,
      });
      throw err;
    }
    const durationMs = Date.now() - startedAt;

    this.repo.recordAgentRun({
      runId: run.id,
      stage: run.currentState,
      phase,
      model,
      input,
      output: result.output,
      tokens: result.usage.tokens,
      durationMs,
      success: true,
    });
    this.repo.addRunUsage(run.id, { tokens: result.usage.tokens, cost: result.usage.cost, agentRuns: 1 });

    return result.output;
  }

  /**
   * Handle one streamed activity from the harness: persist it to the run's durable log stream and
   * push it to the optional in-process watcher. Both are best-effort observability that must never
   * disturb the work session, so a failure in either is swallowed (the harness keeps streaming).
   */
  private handleActivity(runId: number, stage: string, phase: AgentPhase, activity: AgentActivity): void {
    try {
      this.repo.recordLog({ runId, level: 'info', message: activity.summary, data: { stage, phase, kind: activity.kind } });
    } catch {
      // Persisting a log line is non-critical; never let it interrupt a paid, in-flight stage.
    }
    if (!this.onActivity) return;
    try {
      this.onActivity({ runId, stage, phase, activity });
    } catch {
      // A throwing watcher must not affect the run.
    }
  }

  // --- git/GitHub side effects ------------------------------------------------

  private async applyStageEffects(run: Run, io: StageIo, prep: StagePrep, envelope: AgentEnvelope): Promise<AgentEnvelope> {
    const { github } = this.repoContext(run);
    if (io.kind === 'review') {
      // plan_review has no PR — nothing to post, nothing to strip; its feedback travels back to `plan`
      // via the envelope's `reason`, handled by the normal back-edge mechanism.
      if (run.prNumber === null) return envelope;
      const prNumber = run.prNumber;
      // Post review comments to the PR (if any). Each gets its own ledger slot, so a crash mid-post
      // never double-posts on replay (M7).
      const comments = envelope.comments ?? [];
      const ledger = this.ledgerFor(run);
      for (let i = 0; i < comments.length; i++) {
        const body = comments[i]!;
        await ledger.once(`comment:${i}`, () => github.postComment({ prNumber, body }));
      }
      // On the terminal approving review (code_review's approve → `done`), strip the `.agent/` scratch
      // from the branch tip so it never reaches `main` and never causes cross-run conflicts (agents-fsm#21).
      // Gated on `approve` so the artifacts survive a `request_changes` re-run they feed, and evaluated
      // independently of `comments` so a zero-comment approval still strips. The adapter is naturally
      // idempotent, so re-firing on a PR-feedback re-approval is safe.
      if (envelope.requestedTransition === 'approve') {
        // Finalize the PR description: the reviewer has seen the whole diff, so replace the placeholder
        // body `tdd` opened with its rich write-up (how it works, architecture, tests, manual checks).
        // Ledger-guarded so a crash mid-approval never re-writes it on replay (M7), and skipped when the
        // reviewer returned none so a bare approval still leaves the useful placeholder in place.
        if (envelope.prDescription) {
          const description = envelope.prDescription;
          await ledger.once('pr_description', () => github.updatePr({ prNumber, body: prBody(run, prep.issue, description) }));
        }
        const ref = await github.stripAgentArtifacts(run.id, prep.branch!, `chore(run ${run.id}): remove .agent scratch artifacts before merge`);
        if (ref) {
          this.repo.recordLog({
            runId: run.id,
            message: `stripped .agent scratch artifacts from ${prep.branch} before merge`,
            data: { kind: 'strip_artifacts', stage: run.currentState },
          });
        }
      }
      if (comments.length === 0) return envelope;
      return appendArtifact(envelope, { kind: 'review', locator: { prNumber, comments: comments.length } });
    }

    // produce: commit the agent's work, enrich its artifacts with the real branch + sha, and
    // (for `tdd`) find-or-open the PR.
    const branch = prep.branch!;
    const commit = await github.commitAndPush({ workingDir: prep.workingDir!, branch, message: commitMessage(run, prep.issue) });
    let envelopeOut: AgentEnvelope = { ...envelope, artifacts: enrichArtifacts(envelope.artifacts, { branch, sha: commit.sha }) };
    if (io.opensPr) {
      const pr = await this.ensurePr(run, branch, prep.issue);
      envelopeOut = appendArtifact(envelopeOut, { kind: 'pr', locator: { number: pr.number, url: pr.url, branch } });
    }
    return envelopeOut;
  }

  /**
   * Find-or-create the run's PR. Guarding only on `run.pr_number` is not enough: there is a
   * crash/resume window between `openPr` succeeding and persisting the number, so we first ask
   * the adapter whether an open PR already exists for the branch and adopt it (plans/milestone-4.md §3.3).
   */
  private async ensurePr(run: Run, branch: string, issue: Issue): Promise<PullRequest> {
    const { github, baseBranch } = this.repoContext(run);
    const existing = await github.findOpenPrForBranch(branch);
    if (existing) {
      if (run.prNumber === null) this.repo.setRunPr(run.id, existing.number);
      return existing;
    }
    const pr = await github.openPr({
      branch,
      base: baseBranch,
      title: issue.title || `Run ${run.id}`,
      body: prBody(run, issue),
    });
    this.repo.setRunPr(run.id, pr.number);
    return pr;
  }
}

/** The effective recipe shape `recipeFor` returns. */
type Recipe = ReturnType<typeof recipeFor>;

/** How many characters of the issue-title slug a branch name keeps — long enough to recognize the issue
 *  at a glance, short enough that the ref stays manageable. */
const BRANCH_SLUG_MAX = 40;

/**
 * The run's working-branch name: `agent/<date>-<issue-slug>-<rand>`, e.g.
 * `agent/2026-07-06-add-csv-export-a1b2c3`. Human-readable — the date the run started plus the issue
 * title — where the old `agent/run-<id>-<rand>` was opaque, while keeping every property that mattered:
 *  - **Globally unique.** The short random suffix keeps a fresh run from ever adopting a prior run's
 *    leftover remote branch + PR — even when the run id is reused (the operator wiped the local db and
 *    ids restarted at 1) or two runs share a title on the same day. That collision once let a stale
 *    implementation slip onto a new run's branch, so the suffix stays.
 *  - **Stable.** Created once and persisted (callers guard on `run.branch`), so recovery reuses it. The
 *    date is taken from the run's own `createdAt`, not the wall clock, so a recompute before the branch
 *    is persisted yields the same date.
 *  - **A valid git ref.** The slug is `[a-z0-9-]` only. A title with no usable characters (empty,
 *    all-punctuation, non-latin) falls back to `run-<id>` so the name is never `agent/<date>--<rand>`.
 */
function branchName(run: Run, issueTitle: string): string {
  const date = run.createdAt.slice(0, 10); // YYYY-MM-DD off the ISO-8601 timestamp
  const slug = slugifyTitle(issueTitle) || `run-${run.id}`;
  return `agent/${date}-${slug}-${randomBytes(3).toString('hex')}`;
}

/**
 * Reduce an issue title to the `[a-z0-9-]` slug portion of a git branch name: lowercase, every run of
 * non-alphanumerics collapses to a single hyphen, ends trimmed, then length-capped (re-trimming any
 * hyphen the cut left dangling). Returns `''` when the title has no usable characters, so the caller
 * can fall back rather than emit a bare/hyphen-only segment.
 */
function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, BRANCH_SLUG_MAX).replace(/-+$/, '');
}

function commitMessage(run: Run, issue: Issue): string {
  return `[agent] ${run.currentState}: ${issue.title || `issue #${issue.number}`} (#${issue.number})`;
}

/** The commit message a write-mode chat's changes land under: the operator's prompt, first line only,
 *  bounded so a pasted paragraph never becomes a subject line. */
export function chatCommitMessage(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0]!.trim();
  const snippet = firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
  return `[agent] chat: ${snippet}`;
}

/**
 * The operator-facing reply text from a chat invocation's parsed output. The chat contract asks for
 * `{ "response": "<markdown>" }` (so the harness's JSON-extraction heuristics parse it losslessly);
 * a model that answered in plain text anyway is still its own words, and anything else is shown as
 * JSON rather than dropped — chat is interactive, so favor showing *something* over escalating.
 */
export function chatResponseText(output: unknown): string {
  if (output && typeof output === 'object' && typeof (output as { response?: unknown }).response === 'string') {
    return (output as { response: string }).response.trim();
  }
  if (typeof output === 'string') return output.trim();
  return JSON.stringify(output, null, 2);
}

/** The advisor's structured contract: a summary + 1–3 options, each a resume/revert control action. */
const adviceOptionSchema = z
  .object({
    label: z.string().min(1),
    rationale: z.string().min(1),
    action: z.enum(['resume', 'revert']),
    toState: z.string().min(1).optional(),
    suggestedNotes: z.string().optional(),
  })
  .strict();

const adviceSchema = z
  .object({
    summary: z.string().min(1),
    options: z.array(adviceOptionSchema).min(1).max(3),
  })
  .strict();

/** A graceful fallback shown when the advisor's output can't be parsed — advisory, never load-bearing:
 *  the escalation UX (and the free-text "Other" box) must never break on a malformed suggestion. */
const ADVICE_FALLBACK_SUMMARY =
  'The resolution advisor could not produce suggestions this time. Review the escalation details below and resume or revert the run manually, or try again.';

/**
 * Parse an advisor invocation's raw output into an {@link AdviceResult}. Accepts
 * `{ summary, options: AdviceOption[] }` with 1–3 options. Unlike {@link parseEnvelope} it never
 * signals failure to the caller: on malformed/empty output it returns a minimal
 * `{ summary: <fallback>, options: [] }` so the panel always renders something and the operator can
 * still resolve the escalation by hand. Pure and exported so the fallback is unit-tested directly.
 */
export function parseAdvice(raw: unknown): AdviceResult {
  const r = adviceSchema.safeParse(raw);
  if (r.success) return { summary: r.data.summary, options: r.data.options as AdviceOption[] };
  // Preserve a usable summary when the model at least produced one, otherwise the fallback prose.
  const summary =
    raw && typeof raw === 'object' && typeof (raw as { summary?: unknown }).summary === 'string' && (raw as { summary: string }).summary.trim()
      ? (raw as { summary: string }).summary.trim()
      : ADVICE_FALLBACK_SUMMARY;
  return { summary, options: [] };
}

/**
 * Overlay a triage `scheduling` declaration onto the issue's existing (carried) block: only the
 * fields the agent explicitly set replace the existing values, so a partial declaration — e.g. just
 * `priority` — never wipes a human-declared `depends_on` (M9 plan §3.4 "the issue owns them").
 */
function overlayScheduling(existing: SchedulingDecl, declared: TriageScheduling): SchedulingDecl {
  return {
    dependsOn: declared.depends_on ?? existing.dependsOn,
    priority: declared.priority ?? existing.priority,
    orderKey: declared.order_key ?? existing.orderKey,
  };
}

/**
 * The PR body. `tdd` opens the PR before the work exists, so it gets a placeholder body (issue link +
 * provenance). When `code_review` approves, it returns a rich `prDescription` (how the feature works,
 * architecture, tests, manual checks) that `description` slots in here, replacing the placeholder — see
 * {@link applyStageEffects}. Either way the machine framing is constant: `Closes #N` (the keyword that
 * links and closes the issue at merge — README §3.5) leads, and the provenance footer trails, so the
 * agent's prose can never drop the issue link.
 */
function prBody(run: Run, issue: Issue, description?: string): string {
  const provenance = [
    `🤖 Opened by **agent-fleet** (run ${run.id}) via the pipeline triage → plan → plan_review →`,
    'interface_design → tdd → frontend/backend → code_review. Merge-ready, not auto-merged: a human reviews and merges.',
  ];
  // The rich write-up is authored at `code_review` approval — the same moment the `.agent/` scratch is
  // stripped from the branch — so, unlike the placeholder, it must not point at `.agent/*` files.
  if (description) {
    return [`Closes #${issue.number}`, '', description.trim(), '', '---', '', ...provenance].join('\n');
  }
  return [
    `Closes #${issue.number}`,
    '',
    ...provenance,
    '',
    'The approach and design live on this branch as `.agent/plan.md` and `.agent/interface.md`.',
    'A fuller description of what changed and how to test it is added when the review approves this PR.',
  ].join('\n');
}

/** Add `extra` (branch + sha) to each artifact's locator, leaving non-object locators wrapped. */
function enrichArtifacts(artifacts: ArtifactRef[] | undefined, extra: Record<string, unknown>): ArtifactRef[] {
  return (artifacts ?? []).map((a) => ({
    kind: a.kind,
    locator:
      a.locator && typeof a.locator === 'object' && !Array.isArray(a.locator)
        ? { ...(a.locator as Record<string, unknown>), ...extra }
        : { value: a.locator, ...extra },
  }));
}

function appendArtifact(envelope: AgentEnvelope, artifact: ArtifactRef): AgentEnvelope {
  return { ...envelope, artifacts: [...(envelope.artifacts ?? []), artifact] };
}

/** A compact, serializable summary of a created issue, for the split escalation reason. */
function issueSummary(issue: Issue): { ref: string; number: number; title: string } {
  return { ref: issue.ref, number: issue.number, title: issue.title };
}

/** The human-facing sign-off comment triage posts when it proceeds. */
function signoffComment(message?: string): string {
  const lines = ['✅ **Triage sign-off** — this issue is clear and scoped; handing it to planning.'];
  if (message) lines.push('', message);
  return withBotMarker(lines);
}

/** The comment triage posts when it needs the human to answer before work can start. */
function clarifyComment(questions: string[], message?: string): string {
  const lines = ['🤖 **Triage needs more detail before work can start.** Reply on this issue and I’ll pick it back up.'];
  if (message) lines.push('', message);
  if (questions.length > 0) lines.push('', ...questions.map((q) => `- ${q}`));
  return withBotMarker(lines);
}

/** The comment triage posts on the original issue after splitting it into smaller ones. */
function splitComment(created: Issue[], message?: string): string {
  const lines = ['🤖 **Triage split this issue into smaller pieces:**'];
  if (message) lines.push('', message);
  lines.push('', ...created.map((c) => `- ${c.ref} — ${c.title}`));
  return withBotMarker(lines);
}

/** Append the invisible bot-comment marker so the Reply Poller can tell the fleet's own comments from a
 *  human reply by content — the daemon posts via the operator's `gh` account, so login alone can't. */
function withBotMarker(lines: string[]): string {
  return [...lines, '', BOT_COMMENT_MARKER].join('\n');
}

function malformed(phase: AgentPhase, error: string, raw: unknown): StageOutcome {
  // Never coerce malformed output into a transition (README §3.3 Layer 4). We retried a bounded
  // number of times (invokeParsed) and the output still failed validation; escalate with the raw.
  return { kind: 'escalate', trigger: 'malformed_output', reason: { kind: 'malformed_output', phase, error, raw } };
}

function gitError(run: Run, op: 'prepare' | 'effects' | 'sync_base', err: unknown): StageOutcome {
  // A git/GitHub failure (rejected push, auth, conflict) — escalate with a labeled reason rather
  // than crash, so the run parks in needs_human with the cause in the log (plans/milestone-4.md §3.10).
  return { kind: 'escalate', trigger: 'git_error', reason: { kind: 'git_error', op, stage: run.currentState, detail: String(err) } };
}

/**
 * Map an error thrown while applying a stage's side effects to an escalation. A
 * {@link AmbiguousSideEffectError} (the outbox found a 'pending' slot on replay) means a
 * non-idempotent call may have partly applied; we must NOT retry it, so we escalate
 * `partial_side_effect` for a human to verify GitHub state (README Milestone 7). Anything else is a
 * plain `git_error`.
 */
function effectsError(run: Run, err: unknown): StageOutcome {
  if (err instanceof AmbiguousSideEffectError) {
    return {
      kind: 'escalate',
      trigger: 'partial_side_effect',
      reason: {
        kind: 'partial_side_effect',
        key: err.key,
        stage: run.currentState,
        note: 'a comment or sub-issue may have been partly created before a crash — verify on GitHub and remove any partial artifact before resuming',
      },
    };
  }
  return gitError(run, 'effects', err);
}
