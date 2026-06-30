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
  createdAt: string;
  updatedAt: string;
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
}

/** An open issue suggested by the daemon for the new-run autocomplete (`GET /suggestions`). */
export interface IssueSuggestion {
  ref: string;
  repo: string;
  number: number;
  title: string;
}
