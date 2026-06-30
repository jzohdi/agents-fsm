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
import type { GitHub, Issue, PullRequest } from '../integration/github';
import type { AgentPhase, Repository, Run } from '../store/repository';
import type { AgentRunResult, StageExecutor } from './executor';
import { parseEnvelope, parseReviewVerdict, type AgentEnvelope, type ArtifactRef, type Parsed } from './envelope';

/** Default logical model per phase (README §3.3: frontier to produce/critique, cheaper to simplify). */
export const DEFAULT_MODELS: Record<AgentPhase, string> = {
  produce: 'frontier',
  self_review: 'frontier',
  simplify: 'cheap',
};

/** Default base branch a run's working branch is cut from and diffed against. */
export const DEFAULT_BASE_BRANCH = 'main';
/** Default number of extra attempts on malformed output before escalating (plans/milestone-4.md §3.5). */
export const DEFAULT_MALFORMED_RETRY_CAP = 1;

/** The result of running a stage: hand the envelope to the engine, or escalate. */
export type StageOutcome =
  | { kind: 'handoff'; envelope: AgentEnvelope }
  | { kind: 'escalate'; trigger: string; reason: unknown };

/** Builds the per-phase system prompt. The real implementation is `createSystemPromptFn`
 * (agent/prompts.ts); injected via {@link AgentRunnerOptions.systemPrompt} for real runs. */
export type SystemPromptFn = (stage: string, phase: AgentPhase) => string;

/** Default used by stub/fake runs that don't inject real prompts (the demo CLI, most unit tests). */
const defaultSystemPrompt: SystemPromptFn = (stage, phase) => `[${stage}:${phase}] system prompt (stub — inject createSystemPromptFn for real runs)`;

export interface AgentRunnerOptions {
  systemPrompt?: SystemPromptFn;
  /** Base branch new working branches are cut from. Default {@link DEFAULT_BASE_BRANCH}. */
  baseBranch?: string;
  /** Extra attempts on malformed output before escalating. Default {@link DEFAULT_MALFORMED_RETRY_CAP}. */
  malformedRetryCap?: number;
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
  private readonly baseBranch: string;
  private readonly malformedRetryCap: number;

  constructor(
    private readonly repo: Repository,
    private readonly executor: StageExecutor,
    private readonly agents: AgentsConfig,
    private readonly github: GitHub,
    options: AgentRunnerOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.baseBranch = options.baseBranch ?? DEFAULT_BASE_BRANCH;
    this.malformedRetryCap = options.malformedRetryCap ?? DEFAULT_MALFORMED_RETRY_CAP;
  }

  /** Run the run's current stage to completion and return its outcome. */
  async runStage(run: Run): Promise<StageOutcome> {
    const recipe = recipeFor(run.currentState, this.agents);

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
      return gitError(run, 'effects', err);
    }
  }

  // --- stage preparation ------------------------------------------------------

  private async prepareStage(run: Run, io: StageIo): Promise<StagePrep> {
    const issue = await this.github.readIssue(run.issueRef);
    if (io.kind === 'triage') return { issue, input: { issue } };

    // produce/review: ensure the working tree exists, creating the branch the first time.
    const branch = run.branch ?? branchName(run);
    const tree = await this.github.prepareWorkingTree({ runId: run.id, branch, base: this.baseBranch });
    if (run.branch === null) this.repo.setRunBranch(run.id, branch);

    const input: Record<string, unknown> = { issue };
    // code_review (a review stage with a PR) inspects the branch diff itself via its git tools, so
    // we give it the base branch to diff against rather than injecting a (possibly huge) diff — the
    // harness manages its own context (plans/milestone-4.md §3.6). plan_review has no PR and reads
    // `.agent/plan.md` from the tree, so it needs neither.
    if (io.kind === 'review' && run.prNumber !== null) {
      input.base = this.baseBranch;
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
    const model = recipe.models[phase] ?? DEFAULT_MODELS[phase];
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

  // --- git/GitHub side effects ------------------------------------------------

  private async applyStageEffects(run: Run, io: StageIo, prep: StagePrep, envelope: AgentEnvelope): Promise<AgentEnvelope> {
    if (io.kind === 'triage') return envelope;

    if (io.kind === 'review') {
      // Post review comments to the PR (if any). plan_review has no PR — its feedback travels
      // back to `plan` via the envelope's `reason`, handled by the normal back-edge mechanism.
      const comments = envelope.comments ?? [];
      if (run.prNumber === null || comments.length === 0) return envelope;
      for (const body of comments) await this.github.postComment({ prNumber: run.prNumber, body });
      return appendArtifact(envelope, { kind: 'review', locator: { prNumber: run.prNumber, comments: comments.length } });
    }

    // produce: commit the agent's work, enrich its artifacts with the real branch + sha, and
    // (for `tdd`) find-or-open the PR.
    const branch = prep.branch!;
    const commit = await this.github.commitAndPush({ workingDir: prep.workingDir!, branch, message: commitMessage(run, prep.issue) });
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
    const existing = await this.github.findOpenPrForBranch(branch);
    if (existing) {
      if (run.prNumber === null) this.repo.setRunPr(run.id, existing.number);
      return existing;
    }
    const pr = await this.github.openPr({
      branch,
      base: this.baseBranch,
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
