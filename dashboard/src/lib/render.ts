/**
 * Pure rendering helpers for the dashboard (Milestone 6, Svelte rebuild).
 *
 * No DOM, no `fetch`, no Svelte — just data-in / value-out. Svelte components import these for the
 * FSM-graph SVG and the table/telemetry view-models, and `render.test.ts` imports the same module to
 * unit-test them in Node (vitest). Keeping the testable logic here (TS, first-class in the toolchain)
 * is what lets the reactive view layer stay thin.
 */

import type { AgentRunRecord, FsmConfig, Run, RunStatus, Transition } from './types';

// --- formatting ---------------------------------------------------------------

/** Humanize an FSM state id for display (sentence case): `plan_review` → `Plan review`, `tdd` → `Tdd`. */
export function humanizeState(state: string): string {
  const spaced = state.replace(/_/g, ' ');
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : spaced;
}

/** A compact token count: `6234` → `6.2k`, `120000` → `120k`, `840` → `840`. */
export function fmtTokens(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n)));
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

/** Escape text for safe insertion into an SVG string (the one place we build markup by hand). */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A dollar amount to 4 dp, e.g. `$0.0123`. */
export function fmtCost(value: number | null | undefined): string {
  return `$${Number(value ?? 0).toFixed(4)}`;
}

/** A duration in ms as a compact human string (`820ms`, `2.4s`, `1m04s`). */
export function fmtDuration(ms: number | null | undefined): string {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

// --- view-models --------------------------------------------------------------

export interface StageTelemetry {
  stage: string;
  invocations: number;
  tokens: number;
  durationMs: number;
  phases: Record<string, number>;
}
export interface TelemetryModel {
  stages: StageTelemetry[];
  totals: { invocations: number; tokens: number; durationMs: number };
}

/**
 * Per-stage telemetry aggregated from the run's `agent_runs` rows (one row per phase/iteration):
 * invocations, summed tokens + duration, and a phase breakdown — plus run totals (README §3.3 L1/L4).
 */
export function telemetryModel(agentRuns: AgentRunRecord[] | undefined): TelemetryModel {
  const byStage = new Map<string, StageTelemetry>();
  for (const r of agentRuns ?? []) {
    const acc = byStage.get(r.stage) ?? { stage: r.stage, invocations: 0, tokens: 0, durationMs: 0, phases: {} };
    acc.invocations += 1;
    acc.tokens += r.tokens ?? 0;
    acc.durationMs += r.durationMs ?? 0;
    acc.phases[r.phase] = (acc.phases[r.phase] ?? 0) + 1;
    byStage.set(r.stage, acc);
  }
  const stages = [...byStage.values()];
  const totals = stages.reduce(
    (a, s) => ({ invocations: a.invocations + s.invocations, tokens: a.tokens + s.tokens, durationMs: a.durationMs + s.durationMs }),
    { invocations: 0, tokens: 0, durationMs: 0 },
  );
  return { stages, totals };
}

// --- pipeline board -----------------------------------------------------------

export interface PipelineRow {
  id: number;
  issue: string;
  repo: string;
  title: string; // first line of the issue ref's summary if we have one, else the ref
  state: string;
  status: RunStatus;
  statusClass: string;
  tokens: number;
  cost: number;
  resolved: boolean; // terminal (done/stopped) — eligible for archiving
  archived: boolean; // archived server-side (Run.archivedAt set)
}
export interface PipelineColumn {
  key: string;
  label: string;
  terminal: boolean; // needs_human / resolved lanes render after a divider
  runs: PipelineRow[];
}
export interface PipelineModel {
  columns: PipelineColumn[];
  archivedCount: number; // resolved runs hidden by the archive filter
}

const RESOLVED_KEY = '__resolved__';

function pipelineRow(r: Run): PipelineRow {
  const resolved = r.status === 'done' || r.status === 'stopped';
  return {
    id: r.id,
    issue: r.issueRef,
    repo: r.repoRef,
    title: r.issueRef,
    state: r.currentState,
    status: r.status,
    statusClass: `af-stat af-stat-${r.status}`,
    tokens: r.tokensUsed ?? 0,
    cost: r.costUsed ?? 0,
    resolved,
    archived: r.archivedAt != null,
  };
}

/**
 * Bucket runs into pipeline columns: the FSM's `forwardOrder` (minus terminal states) as flow lanes,
 * then a `needs_human` escalation lane and a single `Resolved` lane (done + stopped). A run sits in
 * the escalation lane if its status is `needs_human`, in Resolved if terminal, else in its
 * `currentState` lane. Server-archived runs (`Run.archivedAt` set) are dropped from Resolved unless
 * `showArchived` (their count is returned so the UI can offer to reveal them). Pure — the board
 * view-model the dashboard renders.
 */
export function pipelineModel(
  runs: Run[] | undefined,
  fsm: Partial<FsmConfig> | null | undefined,
  opts: { showArchived?: boolean } = {},
): PipelineModel {
  const states = fsm?.states ?? {};
  const escalation = fsm?.escalationState ?? 'needs_human';
  const flow = (fsm?.forwardOrder ?? []).filter((s) => !states[s]?.terminal);

  const columns: PipelineColumn[] = flow.map((s) => ({ key: s, label: humanizeState(s), terminal: false, runs: [] }));
  const needsHuman: PipelineColumn = { key: escalation, label: humanizeState(escalation), terminal: true, runs: [] };
  const resolved: PipelineColumn = { key: RESOLVED_KEY, label: 'Resolved', terminal: true, runs: [] };
  const byKey = new Map(columns.map((c) => [c.key, c]));

  let archivedCount = 0;
  for (const r of runs ?? []) {
    const row = pipelineRow(r);
    if (r.status === 'needs_human') {
      needsHuman.runs.push(row);
    } else if (row.resolved) {
      if (row.archived) {
        archivedCount += 1;
        if (opts.showArchived) resolved.runs.push(row);
      } else {
        resolved.runs.push(row);
      }
    } else {
      (byKey.get(r.currentState) ?? columns[0])?.runs.push(row);
    }
  }
  return { columns: [...columns, needsHuman, resolved], archivedCount };
}

// --- state-machine stepper ----------------------------------------------------

export interface StepperNode {
  state: string;
  label: string;
  status: 'done' | 'current' | 'todo';
}

/**
 * The forward-spine stepper for a run: each `forwardOrder` state marked done (before the current
 * state), current, or todo. `currentState` outside the spine (e.g. the `needs_human` escalation)
 * leaves no node current — pass the last forward state reached as `effectiveState` for those runs.
 */
export function stepperModel(fsm: Partial<FsmConfig> | null | undefined, currentState: string | undefined): StepperNode[] {
  const order = fsm?.forwardOrder ?? [];
  const idx = currentState ? order.indexOf(currentState) : -1;
  return order.map((state, i) => ({
    state,
    label: humanizeState(state),
    status: idx === -1 ? 'todo' : i < idx ? 'done' : i === idx ? 'current' : 'todo',
  }));
}

export interface BackEdge {
  from: string;
  to: string;
  label: string;
}

/**
 * Distinct back-edges actually traversed by a run (from its transitions, `backEdge === true`),
 * newest-wins on the trigger label — what the stepper draws as return arcs over the spine.
 */
export function traversedBackEdges(transitions: Transition[] | undefined): BackEdge[] {
  const seen = new Map<string, BackEdge>();
  for (const t of transitions ?? []) {
    if (!t.backEdge) continue;
    seen.set(`${t.fromState}→${t.toState}`, { from: t.fromState, to: t.toState, label: t.trigger });
  }
  return [...seen.values()];
}

