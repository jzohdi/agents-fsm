/**
 * Pure render-helper tests (Milestone 6). Run in Node under the root vitest suite (this file is a
 * plain `.test.ts` with no Svelte/DOM imports), exercising the same `render.ts` the browser bundles.
 */

import { describe, expect, it } from 'vitest';

import {
  adviceCards,
  chatSchedulingHint,
  chatWriteRunsNow,
  formatChatReply,
  activityLane,
  branchUrl,
  escalationDetail,
  escalationModel,
  escapeHtml,
  isAtBottom,
  isWatchingPrFeedback,
  issueUrl,
  prUrl,
  costStatusModel,
  fmtRunCost,
  tracksCost,
  fmtDuration,
  fmtRelTime,
  fmtTokens,
  fleetStatsModel,
  repoLedgerModel,
  attentionModel,
  recentRunsModel,
  routeFromPath,
  routePath,
  humanizeHarness,
  humanizeState,
  pipelineModel,
  repoOverviewModel,
  schedulingLabel,
  stepperModel,
  telemetryModel,
  traversedBackEdges,
  waitingOnLabel,
} from './render';
import type { FsmConfig, Repo, Run, Transition } from './types';

const FSM: FsmConfig = {
  initial: 'triage',
  escalationState: 'needs_human',
  forwardOrder: ['triage', 'plan', 'plan_review', 'done'],
  states: {
    triage: { transitions: { proceed: { to: 'FORWARD' }, escalate: { to: 'needs_human' } } },
    plan: { transitions: { proceed: { to: 'FORWARD' } } },
    plan_review: { transitions: { approve: { to: 'FORWARD' }, request_changes: { to: 'plan', backEdge: true, counter: 'plan_review' } } },
    done: { terminal: true },
    needs_human: { terminal: true },
  },
};

const run = (over: Partial<Run> = {}): Run => ({
  id: 1, issueRef: 'o/r#1', repoRef: 'o/r', currentState: 'plan', status: 'running', fsmConfigVersion: 'v',
  prNumber: null, branch: null, tokensUsed: 10, costUsed: 0.5, agentRunsCount: 0, flags: {}, archivedAt: null, modelOverride: null,
  effortOverride: null, harness: 'claude-code', issueContext: null, createdAt: '', updatedAt: '', ...over,
});

describe('formatting', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(escapeHtml(null)).toBe('');
  });

  it('formats duration', () => {
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(820)).toBe('820ms');
    expect(fmtDuration(2400)).toBe('2.4s');
    expect(fmtDuration(64_000)).toBe('1m04s');
  });

  it('humanizes harness ids and is null-safe for a mismatched daemon that omits one', () => {
    expect(humanizeHarness('claude-code')).toBe('Claude Code');
    expect(humanizeHarness('cursor')).toBe('Cursor');
    expect(humanizeHarness('')).toBe('');
    // A daemon that predates / diverges from the harness column can omit it — must not throw (a crash
    // here would take out the whole RunDetail, hiding the Resume button on a needs_human run).
    expect(humanizeHarness(undefined)).toBe('');
    expect(humanizeHarness(null)).toBe('');
  });
});

describe('fmtRunCost / tracksCost (cursor cost blindness, §8.2)', () => {
  it('shows a dollar figure for a cost-reporting harness and n/a for a cost-blind one', () => {
    expect(tracksCost('claude-code')).toBe(true);
    expect(tracksCost('cursor')).toBe(false);
    // Claude Code: real dollars at the requested precision (4dp default, 2dp for the compact card).
    expect(fmtRunCost('claude-code', 0.012345)).toBe('$0.0123');
    expect(fmtRunCost('claude-code', 1.5, 2)).toBe('$1.50');
    expect(fmtRunCost('claude-code', undefined)).toBe('$0.0000');
    // Cursor: n/a regardless of the (unreliable, always-0) figure — never a deceptive "$0.00".
    expect(fmtRunCost('cursor', 0)).toBe('n/a');
    expect(fmtRunCost('cursor', 0, 2)).toBe('n/a');
  });
});

describe('telemetryModel', () => {
  it('aggregates per stage with a phase breakdown and run totals', () => {
    const model = telemetryModel([
      { stage: 'plan', phase: 'produce', model: null, tokens: 10, durationMs: 100, success: true },
      { stage: 'plan', phase: 'self_review', model: null, tokens: 5, durationMs: 50, success: true },
      { stage: 'plan', phase: 'produce', model: null, tokens: 7, durationMs: 30, success: true },
      { stage: 'code_review', phase: 'produce', model: null, tokens: 8, durationMs: 40, success: true },
    ]);
    const plan = model.stages.find((s) => s.stage === 'plan');
    expect(plan).toMatchObject({ invocations: 3, tokens: 22, durationMs: 180, phases: { produce: 2, self_review: 1 } });
    expect(model.totals).toEqual({ invocations: 4, tokens: 30, durationMs: 220 });
  });

  it('tolerates an empty list', () => {
    expect(telemetryModel([])).toEqual({ stages: [], totals: { invocations: 0, tokens: 0, durationMs: 0 } });
  });
});

describe('humanizeState / fmtTokens', () => {
  it('humanizes state ids', () => {
    expect(humanizeState('plan_review')).toBe('Plan review');
    expect(humanizeState('tdd')).toBe('Tdd');
  });
  it('compacts token counts', () => {
    expect(fmtTokens(840)).toBe('840');
    expect(fmtTokens(6234)).toBe('6.2k');
    expect(fmtTokens(120_000)).toBe('120k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
    expect(fmtTokens(621_071_000)).toBe('621M');
    expect(fmtTokens(undefined)).toBe('0');
  });
});

describe('pipelineModel', () => {
  it('buckets runs into flow lanes, an escalation lane and a resolved lane', () => {
    const runs = [
      run({ id: 1, currentState: 'plan', status: 'running' }),
      run({ id: 2, currentState: 'plan_review', status: 'needs_human' }), // → escalation lane
      run({ id: 3, currentState: 'done', status: 'done' }), // → resolved
      run({ id: 4, currentState: 'plan', status: 'stopped' }), // → resolved (terminal status wins)
    ];
    const m = pipelineModel(runs, FSM);
    const keys = m.columns.map((c) => c.key);
    expect(keys).toEqual(['triage', 'plan', 'plan_review', 'needs_human', '__resolved__']); // 'done' (terminal) is not a flow lane
    expect(m.columns.find((c) => c.key === 'plan')!.runs.map((r) => r.id)).toEqual([1]);
    expect(m.columns.find((c) => c.key === 'needs_human')!.runs.map((r) => r.id)).toEqual([2]);
    expect(m.columns.find((c) => c.key === '__resolved__')!.runs.map((r) => r.id)).toEqual([3, 4]);
  });

  it('carries each row\'s harness and a cost label that reads n/a for a cost-blind harness (§8.2)', () => {
    const rows = pipelineModel(
      [
        run({ id: 1, harness: 'claude-code', costUsed: 1.5 }),
        run({ id: 2, harness: 'cursor', costUsed: 0 }),
      ],
      FSM,
    ).columns.find((c) => c.key === 'plan')!.runs;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(1)).toMatchObject({ harness: 'claude-code', costLabel: '$1.50' });
    expect(byId.get(2)).toMatchObject({ harness: 'cursor', costLabel: 'n/a' }); // never a deceptive $0.00
  });

  it('hides server-archived resolved runs unless showArchived, reporting the hidden count', () => {
    const runs = [
      run({ id: 3, currentState: 'done', status: 'done' }),
      run({ id: 5, currentState: 'done', status: 'done', archivedAt: '2026-06-30T00:00:00Z' }),
    ];
    expect(pipelineModel(runs, FSM).columns.at(-1)!.runs.map((r) => r.id)).toEqual([3]);
    expect(pipelineModel(runs, FSM).archivedCount).toBe(1);
    const shown = pipelineModel(runs, FSM, { showArchived: true }).columns.at(-1)!.runs;
    expect(shown.map((r) => r.id)).toEqual([3, 5]);
    expect(shown.find((r) => r.id === 5)!.archived).toBe(true);
  });
});

describe('repoOverviewModel', () => {
  it('groups by repo (sorted) with active vs needs-human counts; resolved runs are not surfaced', () => {
    const runs = [
      run({ id: 1, repoRef: 'acme/web', status: 'running' }),
      run({ id: 2, repoRef: 'acme/web', status: 'awaiting_input' }),
      run({ id: 3, repoRef: 'acme/web', status: 'needs_human' }),
      run({ id: 4, repoRef: 'acme/web', status: 'done' }), // resolved → not counted as active
      run({ id: 5, repoRef: 'acme/api', status: 'running' }),
    ];
    expect(repoOverviewModel(runs)).toEqual([
      { repoRef: 'acme/api', active: 1, needsHuman: 0 },
      { repoRef: 'acme/web', active: 2, needsHuman: 1 },
    ]);
  });

  it('still lists a repo whose runs are all resolved (active 0), and handles empty input', () => {
    expect(repoOverviewModel([run({ repoRef: 'old/done', status: 'done' })])).toEqual([
      { repoRef: 'old/done', active: 0, needsHuman: 0 },
    ]);
    expect(repoOverviewModel(undefined)).toEqual([]);
  });
});

describe('routing (home page paths)', () => {
  it('maps routes to paths and back, round-tripping each route', () => {
    expect(routePath('home')).toBe('/');
    expect(routePath('pipelines')).toBe('/pipelines');
    expect(routePath('editor')).toBe('/editor');
    for (const r of ['home', 'pipelines', 'editor'] as const) expect(routeFromPath(routePath(r))).toBe(r);
  });
  it('tolerates trailing slashes and lands unknown paths on home', () => {
    expect(routeFromPath('/pipelines/')).toBe('pipelines');
    expect(routeFromPath('')).toBe('home');
    expect(routeFromPath('/what-is-this')).toBe('home');
  });
});

describe('fmtRelTime', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');
  it('buckets ages into just now / minutes / hours / days', () => {
    expect(fmtRelTime('2026-07-01T11:59:30Z', now)).toBe('just now');
    expect(fmtRelTime('2026-07-01T11:47:00Z', now)).toBe('13m ago');
    expect(fmtRelTime('2026-07-01T07:00:00Z', now)).toBe('5h ago');
    expect(fmtRelTime('2026-06-28T12:00:00Z', now)).toBe('3d ago');
  });
  it('falls back to a short date beyond a week, and — for a missing stamp', () => {
    expect(fmtRelTime('2026-05-15T12:00:00Z', now)).toMatch(/May/);
    expect(fmtRelTime(null, now)).toBe('—');
    expect(fmtRelTime('not a date', now)).toBe('—');
  });
});

describe('fleetStatsModel (home masthead + stat band)', () => {
  it('aggregates active / awaiting / resolved, tokens, and cost across all runs', () => {
    const m = fleetStatsModel([
      run({ id: 1, status: 'running', tokensUsed: 1000, costUsed: 1 }),
      run({ id: 2, status: 'paused', tokensUsed: 500, costUsed: 0.5 }),
      run({ id: 3, status: 'needs_human', tokensUsed: 200, costUsed: 0.2 }),
      run({ id: 4, status: 'awaiting_input', tokensUsed: 100, costUsed: 0.1 }),
      run({ id: 5, status: 'blocked', tokensUsed: 0, costUsed: 0 }),
      run({ id: 6, status: 'done', repoRef: 'acme/api', tokensUsed: 3000, costUsed: 3 }),
      run({ id: 7, status: 'stopped', tokensUsed: 50, costUsed: 0.05 }),
    ]);
    expect(m).toMatchObject({ totalRuns: 7, active: 2, awaiting: 3, resolved: 2, repos: 2, tokens: 4850, untrackedRuns: 0 });
    expect(m.cost).toBeCloseTo(4.85);
    expect(m.headline).toBe('2 agents at work — 3 runs need you.');
  });

  it('excludes cost-blind harness spend from the total but counts those runs as untracked', () => {
    const m = fleetStatsModel([
      run({ id: 1, harness: 'claude-code', costUsed: 2 }),
      run({ id: 2, harness: 'cursor', costUsed: 99 }), // cursor reports no usage — never counted
    ]);
    expect(m.cost).toBe(2);
    expect(m.untrackedRuns).toBe(1);
  });

  it('writes a fitting headline for each fleet state', () => {
    expect(fleetStatsModel([run({ status: 'running' })]).headline).toBe('1 agent at work across 1 repository.');
    expect(fleetStatsModel([run({ status: 'needs_human' })]).headline).toBe('1 run awaits your attention.');
    expect(fleetStatsModel([run({ status: 'done' }), run({ id: 2, status: 'done' })]).headline).toBe('All quiet — 2 runs resolved to date.');
    expect(fleetStatsModel([]).headline).toBe('Ready when you are. Enroll a repository to begin.');
    expect(fleetStatsModel(undefined).totalRuns).toBe(0);
  });
});

describe('repoLedgerModel (home repositories ledger)', () => {
  const repo = (over: Partial<Repo> = {}): Repo => ({
    repoRef: 'acme/web', cloneUrl: null, localRepo: null, workingRoot: '/tmp', baseBranch: 'main', watch: false, watchLabel: null, watchFilterLabel: null, watchFilterMilestone: null, sourceMode: 'clone', conflictPolicy: 'manual', ...over,
  });

  it('carries the enrolled repo\'s watch flag onto the ledger row (Milestone 11)', () => {
    const rows = repoLedgerModel([repo({ repoRef: 'acme/web', watch: true })], []);
    expect(rows[0]).toMatchObject({ enrolled: true, watch: true });
  });

  it('surfaces the watch scope filter onto the ledger row (issue #11)', () => {
    const rows = repoLedgerModel(
      [repo({ repoRef: 'acme/web', watch: true, watchFilterLabel: 'bug', watchFilterMilestone: 'v2' })],
      [],
    );
    expect(rows[0]).toMatchObject({ watchFilterLabel: 'bug', watchFilterMilestone: 'v2' });
  });

  it('defaults the scope filter to null when the repo has none set (issue #11)', () => {
    const rows = repoLedgerModel([repo({ repoRef: 'acme/web', watch: true })], []);
    expect(rows[0]).toMatchObject({ watchFilterLabel: null, watchFilterMilestone: null });
  });

  it('surfaces the in-flight cap onto the ledger row, defaulting to 1 (agents-fsm#10)', () => {
    const withCap = repoLedgerModel([repo({ repoRef: 'acme/web', watch: true, watchInFlightCap: 5 })], []);
    expect(withCap[0]).toMatchObject({ watchInFlightCap: 5 });

    // An older daemon that predates the column omits it → the row defaults to 1 (matches the store default).
    const legacy = repoLedgerModel([repo({ repoRef: 'acme/idle', watch: true })], []);
    expect(legacy[0]).toMatchObject({ watchInFlightCap: 1 });
  });

  it('maps the working-directory source onto the row: clone, local, and unconfigured (Milestone 12)', () => {
    const rows = repoLedgerModel(
      [
        repo({ repoRef: 'acme/clone', sourceMode: 'clone' }),
        repo({ repoRef: 'acme/local', sourceMode: 'local', localRepo: '/home/me/acme' }),
        repo({ repoRef: 'acme/new', sourceMode: null }),
      ],
      [],
    );
    const byRef = Object.fromEntries(rows.map((r) => [r.repoRef, r]));
    expect(byRef['acme/clone']).toMatchObject({ sourceMode: 'clone', configured: true });
    expect(byRef['acme/local']).toMatchObject({ sourceMode: 'local', localRepo: '/home/me/acme', configured: true });
    expect(byRef['acme/new']).toMatchObject({ sourceMode: null, configured: false });
  });

  it('merges enrolled repos with run aggregates and sorts by most recent activity', () => {
    const rows = repoLedgerModel(
      [repo({ repoRef: 'acme/web' }), repo({ repoRef: 'acme/idle', baseBranch: 'develop' })],
      [
        run({ id: 1, repoRef: 'acme/web', status: 'running', tokensUsed: 100, costUsed: 1, updatedAt: '2026-07-01T10:00:00Z' }),
        run({ id: 2, repoRef: 'acme/web', status: 'needs_human', tokensUsed: 50, costUsed: 0.5, updatedAt: '2026-07-01T11:00:00Z' }),
        run({ id: 3, repoRef: 'acme/web', status: 'done', tokensUsed: 10, costUsed: 0.1, updatedAt: '2026-07-01T09:00:00Z' }),
      ],
    );
    expect(rows.map((r) => r.repoRef)).toEqual(['acme/web', 'acme/idle']); // active repo first, idle last
    expect(rows[0]).toMatchObject({
      enrolled: true, baseBranch: 'main', runs: 3, active: 1, awaiting: 1, needsHuman: 1, resolved: 1,
      tokens: 160, costLabel: '$1.60', lastActivity: '2026-07-01T11:00:00Z',
    });
    expect(rows[1]).toMatchObject({ enrolled: true, baseBranch: 'develop', runs: 0, lastActivity: null });
  });

  it('lists a repo seen only via runs (not enrolled) so history is never hidden', () => {
    const rows = repoLedgerModel([], [run({ repoRef: 'ghost/repo', status: 'done' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repoRef: 'ghost/repo', enrolled: false, runs: 1 });
  });

  it('is empty-safe', () => {
    expect(repoLedgerModel(undefined, undefined)).toEqual([]);
  });
});

describe('attentionModel (home attention queue)', () => {
  it('lists only operator-blocked runs, newest first, with a why-it-waits label', () => {
    const rows = attentionModel([
      run({ id: 1, status: 'running', updatedAt: '2026-07-01T12:00:00Z' }), // not waiting → excluded
      run({ id: 2, status: 'needs_human', currentState: 'code_review', updatedAt: '2026-07-01T10:00:00Z' }),
      run({ id: 3, status: 'awaiting_input', updatedAt: '2026-07-01T11:00:00Z' }),
      run({ id: 4, status: 'blocked', dependsOn: [7], updatedAt: '2026-07-01T09:00:00Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([3, 2, 4]);
    expect(rows.find((r) => r.id === 2)!.label).toContain('Escalated');
    expect(rows.find((r) => r.id === 3)!.label).toContain('reply');
    expect(rows.find((r) => r.id === 4)!.label).toBe('waiting on #7');
    expect(attentionModel(undefined)).toEqual([]);
  });
});

describe('recentRunsModel (home activity feed)', () => {
  it('returns the most recently touched runs first, capped at the limit', () => {
    const rows = recentRunsModel(
      [
        run({ id: 1, updatedAt: '2026-07-01T09:00:00Z' }),
        run({ id: 2, updatedAt: '2026-07-01T11:00:00Z', harness: 'cursor' }),
        run({ id: 3, updatedAt: '2026-07-01T10:00:00Z' }),
      ],
      2,
    );
    expect(rows.map((r) => r.id)).toEqual([2, 3]);
    expect(rows[0]!.costLabel).toBe('n/a'); // cost-blind harness stays honest here too
    expect(recentRunsModel(undefined)).toEqual([]);
  });
});

describe('costStatusModel', () => {
  it('sums active (non-terminal) cost, excludes terminal runs, and flags over-ceiling', () => {
    const runs = [
      run({ id: 1, status: 'running', costUsed: 2 }),
      run({ id: 2, status: 'needs_human', costUsed: 3 }),
      run({ id: 3, status: 'done', costUsed: 10 }), // terminal → excluded
      run({ id: 4, status: 'stopped', costUsed: 20 }), // terminal → excluded
    ];
    const m = costStatusModel(runs, 5);
    expect(m).toEqual({ ceiling: 5, activeCost: 5, overCeiling: true, label: '$5.00 / $5.00' });
  });

  it('is under-ceiling when active spend is below it', () => {
    expect(costStatusModel([run({ status: 'running', costUsed: 1 })], 5)).toMatchObject({ overCeiling: false, label: '$1.00 / $5.00' });
  });

  it('shows active spend only, ungated, when no ceiling is configured', () => {
    expect(costStatusModel([run({ status: 'running', costUsed: 2.5 })], null)).toEqual({
      ceiling: null, activeCost: 2.5, overCeiling: false, label: '$2.50',
    });
  });

  it('is empty-safe', () => {
    expect(costStatusModel(undefined, 5)).toMatchObject({ activeCost: 0, overCeiling: false });
  });
});

describe('stepperModel', () => {
  it('marks done / current / todo along the forward spine', () => {
    expect(stepperModel(FSM, 'plan').map((n) => n.status)).toEqual(['done', 'current', 'todo', 'todo']);
  });
  it('leaves nothing current when the state is off the spine (escalation)', () => {
    expect(stepperModel(FSM, 'needs_human').every((n) => n.status === 'todo')).toBe(true);
  });
});

describe('GitHub deep links', () => {
  it('builds an issue URL from owner/repo#N', () => {
    expect(issueUrl('jzohdi/tmux-speedrun#31')).toBe('https://github.com/jzohdi/tmux-speedrun/issues/31');
    expect(issueUrl('bad ref')).toBeNull();
    expect(issueUrl(undefined)).toBeNull();
  });
  it('builds a PR URL from the repo ref + number, or null without one', () => {
    expect(prUrl('jzohdi/tmux-speedrun', 33)).toBe('https://github.com/jzohdi/tmux-speedrun/pull/33');
    expect(prUrl('jzohdi/tmux-speedrun', null)).toBeNull();
    expect(prUrl('', 5)).toBeNull();
  });
  it('builds a branch URL, preserving slashes in the branch name', () => {
    expect(branchUrl('o/r', 'agent/run-1-abc')).toBe('https://github.com/o/r/tree/agent/run-1-abc');
    expect(branchUrl('o/r', null)).toBeNull();
    expect(branchUrl(undefined, 'main')).toBeNull();
  });
});

describe('isWatchingPrFeedback', () => {
  it('is true for a finished run with an open PR, false otherwise', () => {
    // done / needs_human with a PR and no closed flag → being watched.
    expect(isWatchingPrFeedback(run({ status: 'done', prNumber: 36 }))).toBe(true);
    expect(isWatchingPrFeedback(run({ status: 'needs_human', prNumber: 36 }))).toBe(true);
    // Not finished, no PR, or the PR already merged/closed → not watched.
    expect(isWatchingPrFeedback(run({ status: 'running', prNumber: 36 }))).toBe(false);
    expect(isWatchingPrFeedback(run({ status: 'done', prNumber: null }))).toBe(false);
    expect(isWatchingPrFeedback(run({ status: 'done', prNumber: 36, flags: { pr_feedback_closed: true } }))).toBe(false);
    expect(isWatchingPrFeedback(run({ status: 'done', prNumber: 36, archivedAt: '2026-07-01T00:00:00Z' }))).toBe(false); // archived → filed away
    expect(isWatchingPrFeedback(null)).toBe(false);
  });
});

describe('isAtBottom', () => {
  it('is true exactly at the bottom and within the threshold', () => {
    expect(isAtBottom(900, 100, 1000)).toBe(true); // 900 + 100 === 1000
    expect(isAtBottom(880, 100, 1000)).toBe(true); // 20px from bottom, within default 24
  });
  it('is false when scrolled up beyond the threshold', () => {
    expect(isAtBottom(700, 100, 1000)).toBe(false); // 200px from bottom
    expect(isAtBottom(0, 100, 1000)).toBe(false);
  });
  it('honors a custom threshold', () => {
    expect(isAtBottom(880, 100, 1000, 10)).toBe(false); // 20px from bottom, threshold 10
    expect(isAtBottom(880, 100, 1000, 30)).toBe(true);
  });
});

describe('activityLane', () => {
  it('routes the agent\'s words to the thinking stream', () => {
    expect(activityLane('thinking')).toBe('thinking');
    expect(activityLane('assistant')).toBe('thinking');
  });
  it('routes the agent\'s actions to the activity wire', () => {
    expect(activityLane('tool_use')).toBe('wire');
    expect(activityLane('tool_result')).toBe('wire');
  });
  it('defaults an unknown/missing kind to the wire (so nothing is lost)', () => {
    expect(activityLane(undefined)).toBe('wire');
    expect(activityLane('mystery')).toBe('wire');
  });
});

describe('escalationModel', () => {
  const t = (over: Partial<Transition>): Transition => ({
    id: 1, fromState: 'plan', toState: 'plan_review', trigger: 'proceed', reason: null, backEdge: false, createdAt: '', ...over,
  });

  it('returns null when there is no escalation transition', () => {
    expect(escalationModel([t({})], 'needs_human')).toBeNull();
    expect(escalationModel(undefined)).toBeNull();
  });

  it('reports the latest escalation with its trigger, from-state, reason, and guidance', () => {
    const model = escalationModel(
      [
        t({ id: 1 }),
        t({ id: 2, fromState: 'code_review', toState: 'needs_human', trigger: 'git_error', reason: { detail: 'push rejected' } }),
      ],
      'needs_human',
    );
    expect(model).toMatchObject({ trigger: 'git_error', fromState: 'code_review', reason: { detail: 'push rejected' } });
    expect(model!.guidance).toMatch(/resume/i);
  });

  it('gives partial_side_effect guidance that points the operator at GitHub cleanup', () => {
    const model = escalationModel([t({ toState: 'needs_human', trigger: 'partial_side_effect' })], 'needs_human');
    expect(model!.guidance).toMatch(/verify on GitHub/i);
  });

  it('falls back to generic guidance for an unknown trigger', () => {
    const model = escalationModel([t({ toState: 'needs_human', trigger: 'mystery' })], 'needs_human');
    expect(model!.guidance).toMatch(/fix the cause/i);
  });

  it('honors a custom escalation state', () => {
    const model = escalationModel([t({ toState: 'parked', trigger: 'budget_exceeded' })], 'parked');
    expect(model).toMatchObject({ trigger: 'budget_exceeded' });
  });

  it('embeds the human-first detail rendering of the reason', () => {
    const model = escalationModel(
      [t({ toState: 'needs_human', fromState: 'interface_design', trigger: 'internal_review_cap', reason: { kind: 'internal_review_cap', cap: 2, notes: { issues: ['a'] } } })],
      'needs_human',
    );
    expect(model!.detail.headline).toContain('2 rounds');
    expect(model!.detail.bullets).toEqual(['a']);
  });
});

describe('escalationDetail', () => {
  it('renders internal_review_cap as a headline plus the unresolved review findings', () => {
    const d = escalationDetail('internal_review_cap', {
      kind: 'internal_review_cap',
      cap: 2,
      notes: { kind: 'interface_review', issues: ['seriesRequired enforcement is broken', 'metadata contract is contradictory'] },
    });
    expect(d.headline).toContain('2 rounds');
    expect(d.headline).toMatch(/unresolved findings/i);
    expect(d.bullets).toEqual(['seriesRequired enforcement is broken', 'metadata contract is contradictory']);
  });

  it('tolerates an internal_review_cap payload without the expected notes shape', () => {
    const d = escalationDetail('internal_review_cap', { cap: 'x', notes: 'free text' });
    expect(d.headline).not.toBe('');
    expect(d.bullets).toEqual([]);
  });

  it('renders the error-carrying triggers with their error text as bullets', () => {
    expect(escalationDetail('malformed_output', { phase: 'produce', error: 'unexpected key "foo"' })).toEqual({
      headline: 'The produce phase produced output that failed validation, even after a retry.',
      bullets: ['unexpected key "foo"'],
    });
    expect(escalationDetail('git_error', { op: 'effects', detail: 'push rejected' }).bullets).toEqual(['push rejected']);
    expect(escalationDetail('executor_error', { error: 'harness exited 1' }).bullets).toEqual(['harness exited 1']);
  });

  it('renders budget_exceeded with used-vs-allowed lines for the configured ceilings only', () => {
    const d = escalationDetail('budget_exceeded', {
      budget: { maxTokens: 1000 },
      usage: { tokens: 1200, agentRuns: 9, wallClockMs: 5 },
    });
    expect(d.bullets).toEqual(['tokens: 1200 used of 1000 allowed']);
  });

  it('lists created sub-issues for should_split and members for dependency_cycle', () => {
    expect(escalationDetail('should_split', { created: [{ ref: 'o/r#7', number: 7, title: 'Part one' }] }).bullets).toEqual(['#7 Part one']);
    expect(
      escalationDetail('dependency_cycle', { runs: [1, 2], issues: [{ number: 4, title: 'A' }, { number: 5, title: 'B' }] }).bullets,
    ).toEqual(['#4 A', '#5 B']);
  });

  it('renders empty for an unknown trigger or a null reason payload, so the panel falls back to raw JSON', () => {
    expect(escalationDetail('mystery', { any: 'thing' })).toEqual({ headline: '', bullets: [] });
    expect(escalationDetail('mystery', null)).toEqual({ headline: '', bullets: [] });
  });
});

describe('traversedBackEdges', () => {
  it('returns distinct traversed back-edges, newest trigger wins', () => {
    const t = (over: Partial<Transition>): Transition => ({
      id: 1, fromState: 'plan_review', toState: 'plan', trigger: 'request_changes', reason: null, backEdge: true, createdAt: '', ...over,
    });
    const edges = traversedBackEdges([
      t({ id: 1 }),
      t({ id: 2, fromState: 'plan', toState: 'plan_review', trigger: 'proceed', backEdge: false }), // forward, ignored
      t({ id: 3, trigger: 'request_changes_again' }), // same from→to, overrides label
    ]);
    expect(edges).toEqual([{ from: 'plan_review', to: 'plan', label: 'request_changes_again' }]);
  });
});


describe('scheduling surfaces (Milestone 9)', () => {
  it('waitingOnLabel: only a dependency-blocked run shows a waiting line', () => {
    expect(waitingOnLabel(run({ status: 'blocked', dependsOn: [42, 57] }))).toBe('waiting on #42, #57');
    expect(waitingOnLabel(run({ status: 'running', dependsOn: [42] }))).toBe('');
    expect(waitingOnLabel(run({ status: 'blocked', dependsOn: [] }))).toBe('');
    expect(waitingOnLabel(run({ status: 'blocked' }))).toBe(''); // a mismatched daemon may omit the field
  });

  it('schedulingLabel: deps + verification state, priority, and key — empty when nothing is declared', () => {
    expect(schedulingLabel(run({}))).toBe('');
    expect(schedulingLabel(run({ dependsOn: [4], status: 'blocked' }))).toBe('depends on #4 (waiting)');
    expect(schedulingLabel(run({ dependsOn: [4], depsSatisfiedAt: '2026-07-01T00:00:00Z' }))).toBe('depends on #4 (satisfied)');
    expect(schedulingLabel(run({ dependsOn: [4] }))).toBe('depends on #4 (unverified)');
    expect(schedulingLabel(run({ priority: 10, orderKey: 'q3' }))).toBe('priority 10 · key q3');
  });

  it('pipelineModel rows carry the blocked badge fields', () => {
    const m = pipelineModel([run({ id: 1, currentState: 'plan', status: 'blocked', dependsOn: [7], priority: 3 })], FSM);
    const row = m.columns.find((c) => c.key === 'plan')!.runs[0]!;
    expect(row.waitingOn).toBe('waiting on #7');
    expect(row.priority).toBe(3);
  });

  it('escalationModel knows the dependency_cycle trigger', () => {
    const model = escalationModel([
      { id: 1, runId: 1, fromState: 'plan', toState: 'needs_human', trigger: 'dependency_cycle', reason: { issues: [1, 2] }, backEdge: false, counterKey: null, isReset: false, eventId: null, createdAt: '' } as Transition,
    ], 'needs_human');
    expect(model?.guidance).toContain('break the cycle');
  });
});

describe('run chat helpers', () => {
  it('chatWriteRunsNow: paused-like statuses only (mirrors the daemon gate)', () => {
    for (const s of ['paused', 'needs_human', 'awaiting_input', 'done', 'stopped']) expect(chatWriteRunsNow(s), s).toBe(true);
    for (const s of ['running', 'blocked', undefined]) expect(chatWriteRunsNow(s), String(s)).toBe(false);
  });

  it('chatSchedulingHint: read always answers now; write depends on where the run is parked', () => {
    expect(chatSchedulingHint('read', 'running')).toContain('answers now');
    expect(chatSchedulingHint('write', 'running')).toContain('held until the pipeline pauses');
    expect(chatSchedulingHint('write', 'needs_human')).toContain('runs now');
  });

  it('formatChatReply: escapes everything, promotes code blocks / inline code / bold / paragraphs', () => {
    expect(formatChatReply('a <script> tag')).toBe('<p>a &lt;script&gt; tag</p>');
    expect(formatChatReply('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
    expect(formatChatReply('use `npm test` — it is **green**')).toBe('<p>use <code>npm test</code> — it is <strong>green</strong></p>');
    expect(formatChatReply('fix:\n```ts\nconst a = 1 < 2;\n```\ndone')).toBe(
      '<p>fix:</p><pre><code>const a = 1 &lt; 2;</code></pre><p>done</p>',
    );
    // Inline rules never reach inside a fenced block.
    expect(formatChatReply('```\n**not bold** `not code`\n```')).toBe('<pre><code>**not bold** `not code`</code></pre>');
  });
});

describe('adviceCards (escalation-resolution option cards)', () => {
  const advice = (options: unknown[]) =>
    ({ id: 1, runId: 1, summary: 'stuck', options, tokens: 0, createdAt: '' }) as never;

  it('marks the first option recommended and the rest not, carrying label/action/notes through', () => {
    const cards = adviceCards(
      advice([
        { label: 'Accept and retry', rationale: 'r1', action: 'resume', suggestedNotes: 'n1' },
        { label: 'Revert to plan', rationale: 'r2', action: 'revert', toState: 'plan', suggestedNotes: 'n2' },
      ]),
    );
    expect(cards.map((c) => c.recommended)).toEqual([true, false]);
    expect(cards[0]).toMatchObject({ label: 'Accept and retry', rationale: 'r1', action: 'resume', suggestedNotes: 'n1', recommended: true });
  });

  it('humanizes a revert target state and keeps the raw state for pre-selecting the revert form', () => {
    const card = adviceCards(advice([{ label: 'Back', rationale: 'r', action: 'revert', toState: 'plan_review' }]))[0]!;
    expect(card.action).toBe('revert');
    expect(card.toState).toBe('plan_review');
    expect(card.toStateLabel).toBe(humanizeState('plan_review'));
    expect(card.suggestedNotes).toBe(''); // omitted → empty, so selecting it clears the box
  });

  it('returns [] for absent or empty advice', () => {
    expect(adviceCards(undefined)).toEqual([]);
    expect(adviceCards(advice([]))).toEqual([]);
  });
});
