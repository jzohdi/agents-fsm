/**
 * Agent Runner (Layer 4 — see README §3.3).
 *
 * Runs one stage as an agent *work session*: it executes the stage's configured phase
 * recipe — produce, then a bounded self-review → fix loop — calling the swappable
 * `StageExecutor` (the harness) once per phase, recording an `agent_runs` row and run
 * usage each time.
 * It returns either the validated envelope to hand to the engine, or an escalation when
 * the internal loop exhausts its cap or the agent emits malformed output.
 *
 * It depends on the store (to record telemetry/usage) and the agent config (the recipe),
 * but NOT on the FSM engine — the engine decides the *next* stage from the envelope; the
 * runner only produces the envelope.
 */

import { recipeFor, type AgentsConfig } from '../fsm/config';
import type { AgentPhase, Repository, Run } from '../store/repository';
import type { AgentRunResult, StageExecutor } from './executor';
import { parseEnvelope, parseReviewVerdict, type AgentEnvelope } from './envelope';

/** Default logical model per phase (README §3.3: frontier to produce/critique, cheaper to simplify). */
export const DEFAULT_MODELS: Record<AgentPhase, string> = {
  produce: 'frontier',
  self_review: 'frontier',
  simplify: 'cheap',
};

/** The result of running a stage: hand the envelope to the engine, or escalate. */
export type StageOutcome =
  | { kind: 'handoff'; envelope: AgentEnvelope }
  | { kind: 'escalate'; reason: unknown };

/** Builds the per-phase system prompt. Real prompts arrive in Milestone 4; this is a placeholder. */
export type SystemPromptFn = (stage: string, phase: AgentPhase) => string;

const defaultSystemPrompt: SystemPromptFn = (stage, phase) => `[${stage}:${phase}] system prompt (placeholder — Milestone 4)`;

export interface AgentRunnerOptions {
  systemPrompt?: SystemPromptFn;
  /**
   * Resolve the run's local working tree, passed to the executor as `workingDir` (Milestone 3).
   * Real executors run the harness there; the stub ignores it. Absent → the executor's default
   * (its own cwd). Wiring the working-tree *lifecycle* into the loop lands with real-agent
   * integration (Milestone 4); this seam lets it flow through without a runner change then.
   */
  resolveWorkingDir?: (run: Run) => string | undefined;
}

export class AgentRunner {
  private readonly systemPrompt: SystemPromptFn;
  private readonly resolveWorkingDir?: (run: Run) => string | undefined;

  constructor(
    private readonly repo: Repository,
    private readonly executor: StageExecutor,
    private readonly agents: AgentsConfig,
    options: AgentRunnerOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.resolveWorkingDir = options.resolveWorkingDir;
  }

  /** Run the run's current stage to completion (all phases) and return its outcome. */
  async runStage(run: Run): Promise<StageOutcome> {
    const recipe = recipeFor(run.currentState, this.agents);

    // Phase 1: produce.
    const producedRaw = await this.invoke(run, 'produce', recipe);
    const produced = parseEnvelope(producedRaw);
    if (!produced.ok) return malformed('produce', produced.error, producedRaw);
    let envelope = produced.value;

    // No self-review configured (pure review stages): hand off the produced envelope.
    if (!recipe.phases.includes('self_review')) return { kind: 'handoff', envelope };

    // Phases 2–3: bounded self-review → fix loop (README §3.3 Layer 4).
    let lastNotes: unknown;
    for (let round = 0; round < recipe.reviewCap; round++) {
      const verdictRaw = await this.invoke(run, 'self_review', recipe, { producedEnvelope: envelope });
      const verdict = parseReviewVerdict(verdictRaw);
      if (!verdict.ok) return malformed('self_review', verdict.error, verdictRaw);
      if (verdict.value.acceptable) return { kind: 'handoff', envelope };

      lastNotes = verdict.value.notes;
      if (recipe.phases.includes('simplify')) {
        const fixedRaw = await this.invoke(run, 'simplify', recipe, {
          producedEnvelope: envelope,
          reviewNotes: lastNotes,
        });
        const fixed = parseEnvelope(fixedRaw);
        if (!fixed.ok) return malformed('simplify', fixed.error, fixedRaw);
        envelope = fixed.value;
      }
    }

    // Cap hit while the review still reports blocking issues: escalate (README §2 guards).
    return { kind: 'escalate', reason: { kind: 'internal_review_cap', cap: recipe.reviewCap, notes: lastNotes } };
  }

  /** One phase invocation: call the executor (harness), record telemetry + usage, return the raw output. */
  private async invoke(
    run: Run,
    phase: AgentPhase,
    recipe: { models: Partial<Record<AgentPhase, string>>; allowedTools?: string[] },
    extra: { producedEnvelope?: AgentEnvelope; reviewNotes?: unknown } = {},
  ): Promise<unknown> {
    const model = recipe.models[phase] ?? DEFAULT_MODELS[phase];
    const input = {
      issueRef: run.issueRef,
      repoRef: run.repoRef,
      stage: run.currentState,
      phase,
      // Durable artifacts + minimal state slice — never prior transcripts (README §3.3 Layer 4).
      artifacts: this.repo.listArtifacts(run.id),
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
        ...(this.resolveWorkingDir ? { workingDir: this.resolveWorkingDir(run) } : {}),
        ...(recipe.allowedTools ? { allowedTools: recipe.allowedTools } : {}),
      });
    } catch (err) {
      // The executor threw after exhausting its own retries (Layer 5). Record the failed
      // invocation for telemetry — so the `success/failure` field is meaningful and the
      // operator can see which phase/model failed — then propagate so the loop escalates.
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
}

function malformed(phase: AgentPhase, error: string, raw: unknown): StageOutcome {
  // Never coerce malformed output into a transition (README §3.3 Layer 4). Bounded retry
  // is the Layer 5 executor/harness's job (Milestone 3); here the deterministic stub means
  // we escalate straight away.
  return { kind: 'escalate', reason: { kind: 'malformed_output', phase, error, raw } };
}
