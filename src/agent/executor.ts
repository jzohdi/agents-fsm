/**
 * The Stage Executor boundary (Layer 5 — see README §3.3).
 *
 * `StageExecutor` is the single seam between the orchestrator and the agent **harness**.
 * It is deliberately dumb: given a system prompt and a structured input, run one agent
 * work session and return the structured JSON output plus token usage. It knows nothing
 * about FSM transitions, phases, or envelopes — the Agent Runner (runner.ts) owns that
 * interpretation.
 *
 * Crucially, we do NOT hand-roll a tool-use loop here. The whole within-stage agentic
 * loop — taking tool-use turns, editing files, running tests, managing the agent's own
 * context as it works — is owned by the harness behind this interface. "One work session
 * in, structured result out" is the contract that hides which harness is running it:
 *   - the MVP executor wraps the **Claude Code CLI as a headless subprocess** (Milestone 3),
 *   - a post-MVP executor wraps the **Claude Agent SDK** in-process (Milestone 10),
 *   - and this in-memory stub stands in for both during Milestones 1–2.
 * All three implement the same one method, so swapping harnesses never touches the engine,
 * loop, runner, or store.
 *
 * Model selection is by *logical* name (e.g. `frontier`, `cheap`); each executor maps
 * those to concrete model ids (a `--model` flag for the CLI, an SDK option for the SDK),
 * so changing models or harnesses is an executor change, not an orchestrator change.
 *
 * Milestone 3 extends {@link AgentRunRequest} additively with the run's working tree and
 * the per-stage tool allow-list, which the real executors pass through to the harness.
 * They are omitted here because the stub needs neither.
 */

import type { AgentPhase } from '../store/repository';

/**
 * A live, human-readable snapshot of what the harness is doing mid-work-session.
 *
 * The harness streams its progress (assistant turns, tool calls, …) while it works; an executor
 * that streams turns each event into one of these and pushes it to {@link AgentRunRequest.onActivity}.
 * This is what powers a "what is the agent doing *right now*" view — the Agent Runner persists them
 * to the live log stream and forwards them to the CLI/dashboard (README §3.3 Layer 6). It is
 * deliberately a *summary*, not the raw transcript: cross-stage context still flows only through
 * durable artifacts (README §3.3 "Artifacts are the shared memory, not transcripts").
 */
/**
 * The streamed steps we surface, split by how the dashboard renders them: `thinking`/`assistant` are
 * the agent's *words* (the live "model thinking" stream), `tool_use`/`tool_result` are its *actions*
 * (the activity wire). Harness-session lifecycle events (session init, per-phase run-complete) are
 * deliberately NOT surfaced — they are infrastructure noise, not "what the agent is doing".
 */
export type AgentActivityKind = 'thinking' | 'assistant' | 'tool_use' | 'tool_result';

export interface AgentActivity {
  /** Coarse classification of the streamed step, for routing/iconography in a UI. */
  kind: AgentActivityKind;
  /** A concise, human-readable description, e.g. `tool: Edit src/foo.ts` or `assistant: Looks good`. */
  summary: string;
  /** The parsed harness event, for a richer dashboard view. Omitted for synthesized activities. */
  detail?: unknown;
}

/** Everything the harness needs to run one phase of one stage. */
export interface AgentRunRequest {
  runId: number;
  /** The FSM stage being executed (also the agent's role). */
  stage: string;
  phase: AgentPhase;
  /** Logical model name for this phase; the executor resolves it to a concrete model id. */
  model: string;
  /** The phase/stage-specific system prompt. */
  system: string;
  /** Structured input: artifact refs + minimal state slice (never prior transcripts). */
  input: unknown;
  /**
   * The run's local working tree the harness runs in (Milestone 3). Real executors spawn
   * the harness here; the in-memory stub ignores it. Absent means "use the process cwd".
   */
  workingDir?: string;
  /**
   * Per-stage tool allow-list passed through to the harness (Milestone 3), e.g. review
   * stages get read-only tools. Part of the agent recipe (Layer 4). Absent means the
   * harness's own default policy applies; the stub ignores it.
   */
  allowedTools?: string[];
  /**
   * Optional live-progress sink. When set, a *streaming* executor calls it as the harness works,
   * with a concise {@link AgentActivity} per step — the data behind a "what is the agent doing right
   * now" view. It is best-effort observability and must never change the result; the in-memory stub
   * does not stream, so it ignores this. Absent means "do not stream progress".
   */
  onActivity?: (activity: AgentActivity) => void;
}

export interface AgentUsage {
  tokens: number;
  /** Dollar cost the harness reported for this phase, if any; summed onto the run's `cost_used`. */
  cost?: number;
}

export interface AgentRunResult {
  /** Structured JSON output, validated by the Agent Runner against the phase's schema. */
  output: unknown;
  usage: AgentUsage;
}

/** The executor interface. Implement this to wrap a harness (Claude Code CLI, Agent SDK, …). */
export interface StageExecutor {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

/**
 * A condition that **no run can recover from on its own** — e.g. the harness is not authenticated.
 * Escalating one run to `needs_human` would be wrong (every run would hit it), so the Event Loop
 * propagates this instead of swallowing it: the drain aborts and the entry point (CLI/API) surfaces
 * the `remedy` and shuts down, so the operator fixes the root cause and re-runs.
 *
 * It lives on the seam (not in any one harness) so the loop can recognize it without depending on a
 * specific executor; a concrete executor subclasses it with a harness-specific `remedy`.
 */
export class FatalExecutorError extends Error {
  constructor(
    message: string,
    /** Operator-facing instructions to fix the cause (printed by the CLI on shutdown). */
    public readonly remedy: string,
  ) {
    super(message);
    this.name = 'FatalExecutorError';
  }
}

/** What a stub handler returns for one request: the canned output and optional token/dollar cost. */
export interface StubReply {
  output: unknown;
  tokens?: number;
  cost?: number;
}

export type StubHandler = (req: AgentRunRequest) => StubReply;

/**
 * In-memory executor used by Milestones 1–2: no harness, no network, no cost. The handler
 * decides the output per request, so tests and the demo CLI script whatever behavior they
 * need (golden path, a reviewer that requests changes N times, malformed output, …).
 */
export class StubExecutor implements StageExecutor {
  constructor(private readonly handler: StubHandler) {}

  run(req: AgentRunRequest): Promise<AgentRunResult> {
    const reply = this.handler(req);
    const usage: AgentUsage = { tokens: reply.tokens ?? 1 };
    if (reply.cost !== undefined) usage.cost = reply.cost;
    return Promise.resolve({ output: reply.output, usage });
  }
}

/**
 * A reusable stub handler that drives the default pipeline (README §2) straight to
 * `done`: producing stages proceed, review stages approve, `plan` declares both
 * frontend and backend needed, and every self-review accepts on the first pass. Used by
 * the demo CLI and as a baseline in tests (which can wrap or override it).
 */
export function goldenPathHandler(req: AgentRunRequest): StubReply {
  if (req.phase === 'self_review') return { output: { acceptable: true }, tokens: 5 };
  // produce and simplify both yield the stage's envelope.
  return { output: producedEnvelopeFor(req.stage), tokens: 10 };
}

function producedEnvelopeFor(stage: string): unknown {
  switch (stage) {
    case 'plan':
      return {
        requestedTransition: 'proceed',
        flags: { needs_frontend: true, needs_backend: true },
        artifacts: [{ kind: 'plan', locator: { branch: 'agent/run', path: '.agent/plan.md' } }],
      };
    case 'interface_design':
      return {
        requestedTransition: 'proceed',
        artifacts: [{ kind: 'interface', locator: { branch: 'agent/run', path: '.agent/interface.md' } }],
      };
    case 'tdd':
      // The runner opens the PR and records the `pr` artifact (Milestone 4); the agent only
      // commits the failing tests here.
      return { requestedTransition: 'proceed' };
    case 'plan_review':
    case 'code_review':
      return { requestedTransition: 'approve' };
    case 'triage':
      // triage has its own decision contract (not the work envelope); the golden path signs off.
      return { decision: 'proceed' };
    default:
      // frontend, backend.
      return { requestedTransition: 'proceed' };
  }
}
