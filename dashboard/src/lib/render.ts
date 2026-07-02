/**
 * Pure rendering helpers for the dashboard (Milestone 6, Svelte rebuild).
 *
 * No DOM, no `fetch`, no Svelte — just data-in / value-out. Svelte components import these for the
 * FSM-graph SVG and the table/telemetry view-models, and `render.test.ts` imports the same module to
 * unit-test them in Node (vitest). Keeping the testable logic here (TS, first-class in the toolchain)
 * is what lets the reactive view layer stay thin.
 */

import type { AgentRunRecord, FsmConfig, Repo, Run, RunStatus, Transition } from './types';

// --- formatting ---------------------------------------------------------------

/** Humanize an FSM state id for display (sentence case): `plan_review` → `Plan review`, `tdd` → `Tdd`. */
export function humanizeState(state: string): string {
  const spaced = state.replace(/_/g, ' ');
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : spaced;
}

/** Humanize a harness id for display (title case each word): `claude-code` → `Claude Code`, `cursor` →
 *  `Cursor`. Null-safe: a missing harness (an older/mismatched daemon that doesn't report one) → `''`. */
export function humanizeHarness(harness: string | null | undefined): string {
  return (harness ?? '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
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

/**
 * Harnesses that don't report token/cost usage, so a run's `costUsed` comes back `0` regardless of real
 * spend (plan §8.2 — Cursor's result carries no usage; a cost estimator is deferred). The dashboard shows
 * "n/a" for these rather than a misleading "$0.00". Mirror of the harness side; keep in sync when a
 * harness gains real usage reporting.
 */
export const COST_BLIND_HARNESSES = new Set<string>(['cursor']);

/** Whether a harness reports cost/usage — false for a cost-blind harness (plan §8.2). */
export function tracksCost(harness: string | null | undefined): boolean {
  return !COST_BLIND_HARNESSES.has(harness ?? '');
}

/**
 * A run's cost for display: the dollar figure to `digits` dp, or `n/a` when its harness doesn't report
 * usage (plan §8.2) — so a Cursor run never looks deceptively free. Pure, so it is unit-tested.
 */
export function fmtRunCost(harness: string | null | undefined, costUsed: number | null | undefined, digits = 4): string {
  return tracksCost(harness) ? `$${Number(costUsed ?? 0).toFixed(digits)}` : 'n/a';
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

/**
 * A relative "last activity" label from an ISO timestamp: `just now`, `4m ago`, `2h ago`, `3d ago`,
 * then a short date for anything older than a week. `—` for a missing/unparseable stamp. Pure
 * (the caller passes `now`) so it is unit-tested without faking clocks.
 */
export function fmtRelTime(iso: string | null | undefined, now: number = Date.now()): string {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// --- routing (path-based SPA routes; the daemon serves index.html for all of them) ---

export type Route = 'home' | 'pipelines' | 'editor';

/** The pathname each route lives at (the home page owns `/`). */
export function routePath(route: Route): string {
  if (route === 'pipelines') return '/pipelines';
  if (route === 'editor') return '/editor';
  return '/';
}

/** Parse a location pathname into a route; anything unknown lands on home (never a blank screen). */
export function routeFromPath(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/pipelines') return 'pipelines';
  if (p === '/editor') return 'editor';
  return 'home';
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
  costLabel: string; // `$X.XX`, or `n/a` for a cost-blind harness (plan §8.2)
  harness: string; // which harness runs this (for the run-card badge when it isn't the default)
  resolved: boolean; // terminal (done/stopped) — eligible for archiving
  archived: boolean; // archived server-side (Run.archivedAt set)
  waitingOn: string; // "waiting on #42, #57" while dependency-blocked (M9); '' otherwise
  priority: number; // non-zero §3.5 priority renders a small badge; 0 (the default) renders nothing
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
    costLabel: fmtRunCost(r.harness, r.costUsed, 2),
    harness: r.harness ?? '', // a mismatched daemon may omit it; keep the row type-honest (never undefined)
    resolved,
    archived: r.archivedAt != null,
    waitingOn: waitingOnLabel(r),
    priority: r.priority ?? 0,
  };
}

/** "waiting on #42, #57" for a dependency-blocked run (M9); '' for every other status. */
export function waitingOnLabel(r: Run): string {
  if (r.status !== 'blocked' || !r.dependsOn?.length) return '';
  return `waiting on ${r.dependsOn.map((n) => `#${n}`).join(', ')}`;
}

/**
 * RunDetail's one-line scheduling summary (M9): dependencies + their verification state, priority,
 * order key. '' when the run declares nothing (the overwhelmingly common case renders nothing).
 * Read-only by design — declarations are edited on the issue (§3.5), not here.
 */
export function schedulingLabel(r: Run): string {
  const parts: string[] = [];
  if (r.dependsOn?.length) {
    const state = r.depsSatisfiedAt ? 'satisfied' : r.status === 'blocked' ? 'waiting' : 'unverified';
    parts.push(`depends on ${r.dependsOn.map((n) => `#${n}`).join(', ')} (${state})`);
  }
  if (r.priority) parts.push(`priority ${r.priority}`);
  if (r.orderKey) parts.push(`key ${r.orderKey}`);
  return parts.join(' · ');
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

// --- multi-repo overview (Milestone 8 Phase A) --------------------------------

/** Per-repo run counts for the repo-tabs strip: `active` = in-flight/waiting, `needsHuman` = escalated. */
export interface RepoSummary {
  repoRef: string;
  active: number;
  needsHuman: number;
}

/**
 * Group runs by repo into the tab-strip summaries — every repo with at least one run gets an entry
 * (even if all its runs are resolved), sorted by repo ref. `active` counts runs still moving through
 * the pipeline (anything not terminal and not escalated); `needsHuman` counts escalations. Resolved
 * runs are intentionally not surfaced on a tab — they live in the board's Resolved lane. Pure, so it
 * is unit-tested alongside the other view-models; the "All" tab is the caller summing these.
 */
export function repoOverviewModel(runs: Run[] | undefined): RepoSummary[] {
  const byRepo = new Map<string, RepoSummary>();
  for (const r of runs ?? []) {
    let s = byRepo.get(r.repoRef);
    if (!s) {
      s = { repoRef: r.repoRef, active: 0, needsHuman: 0 };
      byRepo.set(r.repoRef, s);
    }
    if (r.status === 'needs_human') s.needsHuman += 1;
    else if (r.status !== 'done' && r.status !== 'stopped') s.active += 1;
  }
  return [...byRepo.values()].sort((a, b) => a.repoRef.localeCompare(b.repoRef));
}

// --- fleet cost ceiling (Milestone 8 B3) --------------------------------------

export interface CostStatusModel {
  /** The configured global ceiling in dollars, or `null` when no ceiling is set. */
  ceiling: number | null;
  /** Aggregate `costUsed` across active (non-terminal) runs — the figure gated against the ceiling. */
  activeCost: number;
  /** Whether active spend has reached the ceiling, so new runs are refused and existing runs park. */
  overCeiling: boolean;
  /** `$active / $ceiling` (or just `$active` when no ceiling is configured), 2-decimal dollars. */
  label: string;
}

/**
 * The fleet's cost against the global ceiling (M8 B3). `activeCost` sums `costUsed` over non-terminal
 * runs — the same set the daemon gates — so it stays live from the runs already on screen; the
 * `ceiling` is fetched once (it's a daemon flag). Pure, so it is unit-tested with the other models.
 */
export function costStatusModel(runs: Run[] | undefined, ceiling: number | null): CostStatusModel {
  const activeCost = (runs ?? [])
    .filter((r) => r.status !== 'done' && r.status !== 'stopped')
    .reduce((sum, r) => sum + (r.costUsed ?? 0), 0);
  const overCeiling = ceiling !== null && activeCost >= ceiling;
  const dollars = (n: number): string => `$${n.toFixed(2)}`;
  const label = ceiling !== null ? `${dollars(activeCost)} / ${dollars(ceiling)}` : dollars(activeCost);
  return { ceiling, activeCost, overCeiling, label };
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

// --- GitHub deep links (open the issue / PR / branch in a new tab) -------------

/** `owner/repo` shape guard for building github.com URLs. */
const REPO_REF = /^[\w.-]+\/[\w.-]+$/;

/** The github.com URL for an issue ref (`owner/repo#N`), or `null` if it isn't a parseable ref. */
export function issueUrl(issueRef: string | null | undefined): string | null {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(issueRef ?? '');
  return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
}

/** The github.com URL for a run's PR, or `null` when there is no PR / the repo ref is unusable. */
export function prUrl(repoRef: string | null | undefined, prNumber: number | null | undefined): string | null {
  return prNumber != null && REPO_REF.test(repoRef ?? '') ? `https://github.com/${repoRef}/pull/${prNumber}` : null;
}

/**
 * Whether the orchestrator is watching this run's open PR for reviewer feedback: it is a finished run
 * (`done` / `needs_human`) that has a PR, isn't archived, and hasn't been flagged as merged/closed.
 * Mirrors the server's `PrFeedbackPoller.isWatchable`; the `pr_feedback_closed` flag is set once its PR
 * merges/closes. Pure, so it is unit-tested and the RunDetail badge stays a thin derivation.
 */
export function isWatchingPrFeedback(run: Run | null | undefined): boolean {
  if (!run) return false;
  return (
    (run.status === 'done' || run.status === 'needs_human') &&
    run.prNumber != null &&
    run.archivedAt == null &&
    run.flags?.pr_feedback_closed !== true
  );
}

/** The github.com URL for a run's branch, or `null` when there is no branch / the repo ref is unusable. */
export function branchUrl(repoRef: string | null | undefined, branch: string | null | undefined): string | null {
  if (!branch || !REPO_REF.test(repoRef ?? '')) return null;
  // Branch names contain `/` (e.g. agent/run-1-abc); keep those as path separators, encode within segments.
  return `https://github.com/${repoRef}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;
}

// --- scroll areas (auto-stick-to-bottom feeds) --------------------------------

/**
 * Whether a scroll container is at (or within `threshold` px of) its bottom — the test the auto-scroll
 * feeds use to decide if they should stay pinned to the latest item. A small threshold makes "scroll
 * back near the end" resume auto-scrolling, and absorbs sub-pixel rounding. Pure, so it is unit-tested.
 */
export function isAtBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 24): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

// --- activity routing (split the two RunDetail panels so they aren't redundant) ----

/**
 * Which RunDetail panel an activity line belongs to, so the two feeds show *different* things instead
 * of duplicating one stream: the agent's **words** (`thinking`/`assistant`) flow to the live "model
 * thinking" stream, its **actions** (`tool_use`/`tool_result`) to the activity wire. A line with an
 * unknown/missing kind defaults to the wire (the durable record), so nothing is silently lost.
 */
export function activityLane(kind: string | undefined): 'thinking' | 'wire' {
  return kind === 'thinking' || kind === 'assistant' ? 'thinking' : 'wire';
}

// --- escalation inspector (needs_human UX, README Milestone 7) -----------------

export interface EscalationModel {
  /** The escalation trigger, a first-class cause label in the log (e.g. `git_error`). */
  trigger: string;
  /** The state the run escalated *from* — where a resume sends it back to retry. */
  fromState: string;
  /** One-line operator guidance for this trigger: how to fix it and whether to resume or revert. */
  guidance: string;
  /** The structured reason payload, for the operator to inspect (the full cause). */
  reason: unknown;
}

/** Operator guidance per escalation trigger — the "fix" half of inspect → fix → resume/revert. */
const ESCALATION_GUIDANCE: Record<string, string> = {
  malformed_output: "The agent's output failed validation after retries. Resume to retry, or revert to the stage with a clarifying reason.",
  invalid_transition: 'The agent requested a transition the FSM does not allow. Revert to a valid state, or resume to retry.',
  missing_reason: 'A back-edge was requested without the required reason. Revert with a reason so the stage knows why it is re-running.',
  internal_review_cap: 'Self-review never converged within its round limit. Resume for a fresh round budget, or revert to the producing stage with notes.',
  git_error: 'A git/GitHub operation failed (auth, a rejected push, or a conflict). Fix the cause, then resume.',
  executor_error: 'The agent harness errored after its own retries. Check the harness and credentials, then resume.',
  budget_exceeded: 'The run hit its token / cost / time budget. Raise the budget and resume, or stop the run.',
  config_version_mismatch: 'The run was started under a different FSM config version. Resume to retry under the current rules.',
  should_split: 'Triage split this issue into smaller ones (see the reason). Start runs for the children; this run can be stopped.',
  partial_side_effect: 'A comment or sub-issue may have been partly created before a crash. Verify on GitHub and remove any partial artifact, then resume.',
  dependency_cycle:
    'The issues in the reason declare dependencies on each other, so none can ever start. Edit the depends_on blocks in the issues to break the cycle, then resume each member.',
};

/**
 * The escalation inspector for a `needs_human` run: the trigger, the stage it escalated from, the
 * structured reason, and a one-line operator guidance — the "inspect" half of the needs_human loop.
 * Returns `null` when the run has no escalation transition (so the panel renders only when relevant).
 */
export function escalationModel(
  transitions: Transition[] | undefined,
  escalationState = 'needs_human',
): EscalationModel | null {
  const esc = [...(transitions ?? [])].reverse().find((t) => t.toState === escalationState);
  if (!esc) return null;
  return {
    trigger: esc.trigger,
    fromState: esc.fromState,
    reason: esc.reason,
    guidance: ESCALATION_GUIDANCE[esc.trigger] ?? 'Inspect the reason below, fix the cause, then resume or revert.',
  };
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

