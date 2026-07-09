/** Shapes mirrored from the Layer 6 API (kept loose — the dashboard only reads these). */

export type RunStatus = 'running' | 'paused' | 'blocked' | 'awaiting_input' | 'done' | 'needs_human' | 'stopped';

export interface Run {
  id: number;
  issueRef: string;
  repoRef: string;
  currentState: string;
  status: RunStatus;
  fsmConfigVersion: string;
  prNumber: number | null;
  branch: string | null;
  tokensUsed: number;
  costUsed: number;
  agentRunsCount: number;
  flags: Record<string, boolean>;
  /** When the run was archived out of the Resolved lane (ISO), or `null`. */
  archivedAt: string | null;
  /** Operator override of the global cost ceiling (M8 B3): one more stage, the whole run, or none. */
  costOverride?: 'next_step' | 'full' | null;
  /** Per-run harness model override (the model picker); null = the daemon default. Takes effect next stage. */
  modelOverride: string | null;
  /** Per-run reasoning-effort override (Claude Code's `--effort`); null = the model default. Takes effect next stage. */
  effortOverride: string | null;
  /** Which agent harness runs this, pinned at start (e.g. `claude-code` | `cursor`). */
  harness: string;
  /** Per-run (Layer 3) operator context appended to this run's agents; null = none. Takes effect next stage. */
  issueContext: string | null;
  /** Cached §3.5 scheduling (M9): same-repo issue numbers that must close before later stages run. */
  dependsOn?: number[];
  /** Cached §3.5 scheduling (M9): higher dispatches first. */
  priority?: number;
  /** Cached §3.5 scheduling (M9): lexicographic tiebreaker after priority. */
  orderKey?: string;
  /** When every dependency was verified closed (the latch), or `null` while blocked/unverified. */
  depsSatisfiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The daemon's default harness + selectable set + the operator's sticky pre-run pick (`GET /settings`). */
export interface Settings {
  defaultHarness: string;
  harnesses: string[];
  /** The persisted pre-run model selection the new-run bar pre-fills (null = none). */
  defaultModel: string | null;
  /** The persisted pre-run reasoning-effort selection (null = none). */
  defaultEffort: string | null;
  /** Layer 1 — the global base operator context applied to every agent invocation (null = unset). */
  contextGlobal: string | null;
  /** Layer 2 — per-stage operator context, keyed by stage; only stages with a non-empty value appear. */
  contextStages: Record<string, string>;
}

/** One selectable harness model (the model picker), from `GET /models`. */
export interface HarnessModel {
  id: string;
  label: string;
  group?: string;
  /** Provider slug for the picker's brand mark (`anthropic`, `openai`, `google`, `xai`, `deepseek`, `moonshot`). */
  provider?: string;
  /** Relative cost tier 1–4, rendered as dollar signs (1 = cheapest). */
  cost?: number;
  /** Whether to surface this model in the picker's "Recommended" shortlist. */
  recommended?: boolean;
  /** Reasoning-effort levels this model accepts (empty/absent → the effort control is hidden). */
  efforts?: string[];
}

/** The active harness's model catalog + the daemon default (`GET /models`). */
export interface ModelCatalog {
  harness: string | null;
  models: HarnessModel[];
  defaultModel: string | null;
}

export interface Transition {
  id: number;
  fromState: string;
  toState: string;
  trigger: string;
  reason: unknown;
  backEdge: boolean;
  createdAt: string;
}

export interface AgentRunRecord {
  stage: string;
  phase: string;
  model: string | null;
  tokens: number;
  durationMs: number | null;
  success: boolean;
}

export interface Artifact {
  kind: string;
  locator: unknown;
}

export interface LogRecord {
  level: string;
  message: string;
  data: unknown;
}

/** Permission grant for a run-chat prompt: `read` runs immediately with read-only tools; `write`
 *  holds until the pipeline pauses, then runs with edit tools and commits + pushes its changes. */
export type ChatMode = 'read' | 'write';

export type ChatStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** One operator ↔ agent exchange on a run's chat side channel (`POST/GET /runs/:id/chat`). */
export interface ChatExchange {
  id: number;
  runId: number;
  prompt: string;
  mode: ChatMode;
  status: ChatStatus;
  /** The agent's reply (markdown), set when the exchange completes. */
  response: string | null;
  error: string | null;
  /** Write mode: the commit pushed after the agent worked. */
  commitSha: string | null;
  tokens: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One suggested resolution the escalation-resolution advisor (Layer 3) proposes for a stuck run. */
export interface AdviceOption {
  /** Short imperative label for the card, e.g. "Accept the reviewer's findings and retry". */
  label: string;
  /** Why this option resolves the escalation — one or two sentences. */
  rationale: string;
  /** The control action this card maps to: `resume` retries the escalated-from state; `revert`
   *  sends the run back to an earlier state. */
  action: 'resume' | 'revert';
  /** For `revert`, the target state to revert to. Omitted for `resume`. */
  toState?: string;
  /** Operator guidance pre-filled into the guidance box when this card is selected. */
  suggestedNotes?: string;
}

/** A persisted advisor result for a run (`POST /runs/:id/advise`). */
export interface Advice {
  id: number;
  runId: number;
  summary: string;
  options: AdviceOption[];
  tokens: number;
  createdAt: string;
}

export interface RunDetail {
  run: Run;
  transitions: Transition[];
  agentRuns: AgentRunRecord[];
  artifacts: Artifact[];
  logs: LogRecord[];
  /** The run's chat thread, oldest first. Absent on an older daemon without the chat routes. */
  chat?: ChatExchange[];
  /** The latest escalation-resolution advice for this run, or undefined if none requested yet. */
  advice?: Advice;
}

export interface TransitionDef {
  to?: string;
  toOneOf?: string[];
  backEdge?: boolean;
  counter?: string;
}

export interface StateDef {
  transitions?: Record<string, TransitionDef>;
  optionalFlag?: string;
  terminal?: boolean;
}

export interface FsmConfig {
  initial: string;
  escalationState: string;
  forwardOrder: string[];
  states: Record<string, StateDef>;
  guards?: Record<string, number>;
}

export interface LoadedConfig {
  fsm: FsmConfig;
  agents: Record<string, unknown>;
  version: string;
}

/** A line in the live activity log (from `logs` rows or streamed `activity` events). */
export interface LogLine {
  message: string;
  stage?: string;
  level: string;
  /** Activity kind (`thinking`/`assistant`/`tool_use`/`tool_result`), used to route it to a panel. */
  kind?: string;
}

/**
 * A repo or issue suggested by the daemon for the new-run autocomplete (`GET /suggestions`). `kind`
 * discriminates: an `issue` has a full `owner/repo#N` ref; a `repo` has a bare `owner/repo` ref
 * (picking it narrows the type-ahead to that repo's issues).
 */
export interface Suggestion {
  kind: 'repo' | 'issue';
  ref: string;
  repo: string;
  number: number;
  title: string;
}

/** An enrolled repository the fleet can run (`GET/POST /repos`, Milestone 8 Phase A). */
export interface Repo {
  repoRef: string;
  cloneUrl: string | null;
  localRepo: string | null;
  workingRoot: string;
  baseBranch: string;
  /** Continuous mode (Milestone 11): the fleet auto-picks this repo's eligible open issues when true. */
  watch: boolean;
  /** The label that bypasses the intake guards; `null` → the default `agent help wanted`. */
  watchLabel: string | null;
  /** Continuous mode scope filter (issue #11): only pick up open issues with this label; `null` = no
   *  label filter. Distinct from {@link watchLabel} (the guard-bypass override). */
  watchFilterLabel: string | null;
  /** Continuous mode scope filter (issue #11): only pick up open issues in this milestone; `null` = none. */
  watchFilterMilestone: string | null;
  /** Continuous mode (agents-fsm#10): max runs this watched repo admits in flight at once. Default 1
   *  (sequential). Only meaningful while {@link watch} is on; actual concurrency is still bounded by the
   *  drain pool's FLEET_CONCURRENCY regardless. Optional on the wire: an older daemon that predates the
   *  column omits it, so consumers default it to 1 (see `repoLedgerModel`). */
  watchInFlightCap?: number;
  /** Working-directory source (Milestone 12): `null` = unconfigured (runs blocked until chosen),
   *  `'clone'` = clone a fresh per-run tree from GitHub, `'local'` = use {@link localRepo} via git worktree. */
  sourceMode: 'clone' | 'local' | null;
  /** Merge-conflict policy: `'manual'` parks a conflicted run needs_human for the operator; `'auto'`
   *  lets a verified resolver agent handle it (between-stage base sync + PR conflict re-open). */
  conflictPolicy: 'manual' | 'auto';
}
