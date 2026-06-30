/**
 * Pure render-helper tests (Milestone 6). Run in Node under the root vitest suite (this file is a
 * plain `.test.ts` with no Svelte/DOM imports), exercising the same `render.ts` the browser bundles.
 */

import { describe, expect, it } from 'vitest';

import {
  escalationModel,
  escapeHtml,
  fmtCost,
  fmtDuration,
  fmtTokens,
  humanizeState,
  pipelineModel,
  stepperModel,
  telemetryModel,
  traversedBackEdges,
} from './render';
import type { FsmConfig, Run, Transition } from './types';

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
  prNumber: null, branch: null, tokensUsed: 10, costUsed: 0.5, agentRunsCount: 0, flags: {}, archivedAt: null, createdAt: '', updatedAt: '', ...over,
});

describe('formatting', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    expect(escapeHtml(null)).toBe('');
  });

  it('formats cost and duration', () => {
    expect(fmtCost(0.012345)).toBe('$0.0123');
    expect(fmtCost(undefined)).toBe('$0.0000');
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(820)).toBe('820ms');
    expect(fmtDuration(2400)).toBe('2.4s');
    expect(fmtDuration(64_000)).toBe('1m04s');
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

describe('stepperModel', () => {
  it('marks done / current / todo along the forward spine', () => {
    expect(stepperModel(FSM, 'plan').map((n) => n.status)).toEqual(['done', 'current', 'todo', 'todo']);
  });
  it('leaves nothing current when the state is off the spine (escalation)', () => {
    expect(stepperModel(FSM, 'needs_human').every((n) => n.status === 'todo')).toBe(true);
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

