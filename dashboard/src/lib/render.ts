/**
 * Pure rendering helpers for the dashboard (Milestone 6, Svelte rebuild).
 *
 * No DOM, no `fetch`, no Svelte — just data-in / value-out. Svelte components import these for the
 * FSM-graph SVG and the table/telemetry view-models, and `render.test.ts` imports the same module to
 * unit-test them in Node (vitest). Keeping the testable logic here (TS, first-class in the toolchain)
 * is what lets the reactive view layer stay thin.
 */

import type { AgentRunRecord, FsmConfig, Run } from './types';

// --- formatting ---------------------------------------------------------------

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

export interface RunRow {
  id: number;
  issue: string;
  state: string;
  status: string;
  statusClass: string;
  tokens: number;
  cost: number;
}

/** Display rows for the runs list, with a per-status CSS class for the status badge. */
export function runsTableModel(runs: Run[] | undefined): RunRow[] {
  return (runs ?? []).map((r) => ({
    id: r.id,
    issue: r.issueRef,
    state: r.currentState,
    status: r.status,
    statusClass: `af-status af-status-${r.status}`,
    tokens: r.tokensUsed ?? 0,
    cost: r.costUsed ?? 0,
  }));
}

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

// --- FSM graph (inline SVG) ---------------------------------------------------

const NODE_W = 116;
const NODE_H = 38;
const GAP_X = 34;
const MARGIN = 18;
const SPINE_Y = 78;
const OTHER_DY = 96; // vertical offset for states not on the forward spine (e.g. needs_human)

interface Point {
  x: number;
  y: number;
}

/**
 * Render the FSM as an inline SVG string: the `forwardOrder` states laid out as a left-to-right spine
 * (forward arrows between neighbors), any non-spine states (terminal/escalation) on a row below, and
 * every declared **back-edge** drawn as a labeled arc. The `currentState` node gets the
 * `af-node-current` class so the dashboard highlights where a run is. Colors come from CSS classes.
 */
export function fsmGraphSvg(fsm: Partial<FsmConfig> | null | undefined, currentState: string | undefined): string {
  const spine = fsm?.forwardOrder ?? [];
  const states = fsm?.states ?? {};
  const others = Object.keys(states).filter((s) => !spine.includes(s));

  const pos: Record<string, Point> = {};
  spine.forEach((s, i) => {
    pos[s] = { x: MARGIN + i * (NODE_W + GAP_X), y: SPINE_Y };
  });
  others.forEach((s, i) => {
    pos[s] = { x: MARGIN + i * (NODE_W + GAP_X), y: SPINE_Y + OTHER_DY };
  });

  const cols = Math.max(spine.length, others.length, 1);
  const width = MARGIN * 2 + cols * NODE_W + (cols - 1) * GAP_X;
  const height = SPINE_Y + (others.length ? OTHER_DY : 0) + NODE_H + MARGIN;

  const forwardEdges: string[] = [];
  for (let i = 0; i < spine.length - 1; i++) {
    const a = pos[spine[i]!];
    const b = pos[spine[i + 1]!];
    if (a && b) forwardEdges.push(forwardArrow(a, b));
  }

  const backEdges: string[] = [];
  for (const [name, def] of Object.entries(states)) {
    const from = pos[name];
    if (!from) continue;
    for (const [trigger, t] of Object.entries(def.transitions ?? {})) {
      if (!t.backEdge) continue; // forward path is the spine; escalate edges are omitted for clarity
      const targets = t.toOneOf ?? (t.to && t.to !== 'FORWARD' ? [t.to] : []);
      for (const target of targets) {
        const to = pos[target];
        if (to) backEdges.push(backArc(from, to, trigger));
      }
    }
  }

  const nodes = Object.entries(pos).map(([s, p]) => {
    const cls = ['af-node'];
    if (s === currentState) cls.push('af-node-current');
    if (states[s]?.terminal) cls.push('af-node-terminal');
    return (
      `<g class="${cls.join(' ')}" data-state="${escapeHtml(s)}">` +
      `<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="7"></rect>` +
      `<text x="${p.x + NODE_W / 2}" y="${p.y + NODE_H / 2}" text-anchor="middle" dominant-baseline="central">${escapeHtml(s)}</text>` +
      `</g>`
    );
  });

  return (
    `<svg viewBox="0 0 ${width} ${height}" class="af-fsm" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="FSM graph">` +
    `<defs><marker id="af-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z"></path></marker></defs>` +
    forwardEdges.join('') +
    backEdges.join('') +
    nodes.join('') +
    `</svg>`
  );
}

/** A straight forward arrow from the right edge of `a` to the left edge of `b` (same row). */
function forwardArrow(a: Point, b: Point): string {
  return `<line class="af-edge af-edge-forward" x1="${a.x + NODE_W}" y1="${a.y + NODE_H / 2}" x2="${b.x}" y2="${b.y + NODE_H / 2}" marker-end="url(#af-arrow)"></line>`;
}

/** A back-edge arc bowing above the spine from `a` to `b`, labeled with the trigger. */
function backArc(a: Point, b: Point, label: string): string {
  const x1 = a.x + NODE_W / 2;
  const x2 = b.x + NODE_W / 2;
  const lift = 34 + Math.abs((x2 - x1) / (NODE_W + GAP_X)) * 4; // longer hops arc higher
  const cx = (x1 + x2) / 2;
  const cy = a.y - lift;
  return (
    `<g class="af-edge af-edge-back">` +
    `<path d="M${x1},${a.y} Q${cx},${cy} ${x2},${b.y}" fill="none" marker-end="url(#af-arrow)"></path>` +
    `<text class="af-edge-label" x="${cx}" y="${cy + 12}" text-anchor="middle">${escapeHtml(label)}</text>` +
    `</g>`
  );
}
