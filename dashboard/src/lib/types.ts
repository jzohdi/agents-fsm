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
  /** Per-run harness model override (the model dropdown); null = the daemon default. Takes effect next stage. */
  modelOverride: string | null;
  /** Which agent harness runs this, pinned at start (e.g. `claude-code` | `cursor`). */
  harness: string;
  createdAt: string;
  updatedAt: string;
}

/** The daemon's default harness + the selectable set (`GET /settings`; the harness selector). */
export interface Settings {
  defaultHarness: string;
  harnesses: string[];
}

/** One selectable harness model (the model dropdown), from `GET /models`. */
export interface HarnessModel {
  id: string;
  label: string;
  group?: string;
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

export interface RunDetail {
  run: Run;
  transitions: Transition[];
  agentRuns: AgentRunRecord[];
  artifacts: Artifact[];
  logs: LogRecord[];
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
}
