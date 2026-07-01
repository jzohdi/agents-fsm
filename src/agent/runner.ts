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

import { recipeFor, type AgentsConfig, type StageIo } from '../fsm/config';
import { ADDRESSING_PR_FEEDBACK_FLAG } from '../loop/event-loop';
import type { GitHub, Issue, IssueComment, PullRequest } from '../integration/github';
import { isRepoResolver, singleRepoResolver, type RepoContext, type RepoResolver } from '../integration/github-resolver';
import type { AgentPhase, Repository, Run } from '../store/repository';
import type { AgentActivity, AgentRunResult, StageExecutor } from './executor';
import {
  parseEnvelope,
  parseReviewVerdict,
  parseTriageOutput,
  type AgentEnvelope,
  type ArtifactRef,
  type Parsed,
  type TriageOutput,
} from './envelope';
import { AmbiguousSideEffectError, SideEffectLedger } from './side-effects';

/** Default logical model per phase (README §3.3: frontier to produce/critique, cheaper to simplify). */
export const DEFAULT_MODELS: Record<AgentPhase, string> = {
  produce: 'frontier',
  self_review: 'frontier',
  simplify: 'cheap',
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
  private readonly malformedRetryCap: number;
  private readonly onActivity?: (activity: PhaseActivity) => void;

  constructor(
    private readonly repo: Repository,
    private readonly executor: StageExecutor,
    private agents: AgentsConfig,
    // A single repo's adapter (single-repo / mock / tests) or a multi-repo {@link RepoResolver}; the
    // former is normalized to a one-repo resolver so the rest of the runner is repo-agnostic (M8).
    github: GitHub | RepoResolver,
    options: AgentRunnerOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
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
    const { github } = this.repoContext(run);
    let issue: Issue;
    let comments: IssueComment[];
    try {
      issue = await github.readIssue(run.issueRef);
      comments = await github.listIssueComments(issue.number);
    } catch (err) {
      return gitError(run, 'prepare', err);
    }
    // The comment thread is the human↔agent conversation; pass it so triage can read the latest reply.
    const prep: StagePrep = {
      issue,
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
    // spec. Editing to the same text is harmless, which keeps a back-edge re-run idempotent.
    let current = issue;
    if (output.issueUpdate) {
      current = await github.updateIssue({
        number: issue.number,
        ...(output.issueUpdate.title !== undefined ? { title: output.issueUpdate.title } : {}),
        body: output.issueUpdate.body,
      });
    }

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

  private async prepareStage(run: Run, io: StageIo): Promise<StagePrep> {
    const { github, baseBranch } = this.repoContext(run);
    const issue = await github.readIssue(run.issueRef);

    // produce/review: ensure the working tree exists, creating the branch the first time.
    const branch = run.branch ?? branchName(run);
    const tree = await github.prepareWorkingTree({ runId: run.id, branch, base: baseBranch });
    if (run.branch === null) this.repo.setRunBranch(run.id, branch);

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
    return { issue, workingDir: tree.path, branch, input };
  }

  // --- phase recipe (produce → bounded self-review → simplify) ----------------

  private async runPhases(run: Run, recipe: Recipe, prep: StagePrep): Promise<StageOutcome> {
    const produced = await this.invokeParsed(run, 'produce', recipe, prep, {}, parseEnvelope);
    if (!produced.ok) return malformed('produce', produced.error, produced.raw);
    let envelope = produced.value;

    // Pure review stages (no self-review configured): hand off the produced envelope.
    if (!recipe.phases.includes('self_review')) return { kind: 'handoff', envelope };

    let lastNotes: unknown;
    for (let round = 0; round < recipe.reviewCap; round++) {
      const verdict = await this.invokeParsed(run, 'self_review', recipe, prep, { producedEnvelope: envelope }, parseReviewVerdict);
      if (!verdict.ok) return malformed('self_review', verdict.error, verdict.raw);
      if (verdict.value.acceptable) return { kind: 'handoff', envelope };

      lastNotes = verdict.value.notes;
      if (recipe.phases.includes('simplify')) {
        const fixed = await this.invokeParsed(run, 'simplify', recipe, prep, { producedEnvelope: envelope, reviewNotes: lastNotes }, parseEnvelope);
        if (!fixed.ok) return malformed('simplify', fixed.error, fixed.raw);
        envelope = fixed.value;
      }
    }

    // Cap hit while the review still reports blocking issues: escalate (README §2 guards).
    return { kind: 'escalate', trigger: 'internal_review_cap', reason: { kind: 'internal_review_cap', cap: recipe.reviewCap, notes: lastNotes } };
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
    const model = phaseModel(recipe.models[phase] ?? DEFAULT_MODELS[phase], run.modelOverride);
    const input = {
      issueRef: run.issueRef,
      repoRef: run.repoRef,
      stage: run.currentState,
      phase,
      // Durable artifacts + minimal state slice — never prior transcripts (README §3.3 Layer 4).
      artifacts: this.repo.listArtifacts(run.id),
      ...prep.input,
      ...extra,
    };

    const startedAt = Date.now();
    let result: AgentRunResult;
    try {
      result = await this.executor.run({
        runId: run.id,
        stage: run.currentState,
        phase,
        model,
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
      // Post review comments to the PR (if any). plan_review has no PR — its feedback travels
      // back to `plan` via the envelope's `reason`, handled by the normal back-edge mechanism.
      const comments = envelope.comments ?? [];
      if (run.prNumber === null || comments.length === 0) return envelope;
      const prNumber = run.prNumber;
      // Each comment gets its own ledger slot, so a crash mid-post never double-posts on replay (M7).
      const ledger = this.ledgerFor(run);
      for (let i = 0; i < comments.length; i++) {
        const body = comments[i]!;
        await ledger.once(`comment:${i}`, () => github.postComment({ prNumber, body }));
      }
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

/**
 * The run's working-branch name, created once and persisted (so recovery reuses it). A short random
 * suffix keeps it globally unique even when the run id is reused — e.g. the operator wiped the local
 * db and ids restarted at 1 — so a fresh run never adopts a prior run's leftover remote branch + PR
 * (the collision that let a stale implementation slip onto a new run's branch).
 */
function branchName(run: Run): string {
  return `agent/run-${run.id}-${randomBytes(3).toString('hex')}`;
}

function commitMessage(run: Run, issue: Issue): string {
  return `[agent] ${run.currentState}: ${issue.title || `issue #${issue.number}`} (#${issue.number})`;
}

/** A descriptive PR body: closes the issue, explains provenance, and points at the run's artifacts. */
function prBody(run: Run, issue: Issue): string {
  return [
    `Closes #${issue.number}`,
    '',
    `🤖 Opened by **agent-fleet** (run ${run.id}) — produced by the pipeline triage → plan → plan_review`,
    '→ interface_design → tdd → frontend/backend → code_review.',
    '',
    'The approach and design live on this branch as `.agent/plan.md` and `.agent/interface.md`.',
    'This PR is merge-ready, not auto-merged: a human reviews and merges.',
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
  return lines.join('\n');
}

/** The comment triage posts when it needs the human to answer before work can start. */
function clarifyComment(questions: string[], message?: string): string {
  const lines = ['🤖 **Triage needs more detail before work can start.** Reply on this issue and I’ll pick it back up.'];
  if (message) lines.push('', message);
  if (questions.length > 0) lines.push('', ...questions.map((q) => `- ${q}`));
  return lines.join('\n');
}

/** The comment triage posts on the original issue after splitting it into smaller ones. */
function splitComment(created: Issue[], message?: string): string {
  const lines = ['🤖 **Triage split this issue into smaller pieces:**'];
  if (message) lines.push('', message);
  lines.push('', ...created.map((c) => `- ${c.ref} — ${c.title}`));
  return lines.join('\n');
}

function malformed(phase: AgentPhase, error: string, raw: unknown): StageOutcome {
  // Never coerce malformed output into a transition (README §3.3 Layer 4). We retried a bounded
  // number of times (invokeParsed) and the output still failed validation; escalate with the raw.
  return { kind: 'escalate', trigger: 'malformed_output', reason: { kind: 'malformed_output', phase, error, raw } };
}

function gitError(run: Run, op: 'prepare' | 'effects', err: unknown): StageOutcome {
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
