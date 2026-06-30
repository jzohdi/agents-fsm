/**
 * Pure render-helper tests (Milestone 6). Run in Node under the root vitest suite (this file is a
 * plain `.test.ts` with no Svelte/DOM imports), exercising the same `render.ts` the browser bundles.
 */

import { describe, expect, it } from 'vitest';

import { escapeHtml, fmtCost, fmtDuration, fsmGraphSvg, runsTableModel, telemetryModel } from './render';
import type { FsmConfig, Run } from './types';

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
  prNumber: null, branch: null, tokensUsed: 10, costUsed: 0.5, agentRunsCount: 0, flags: {}, createdAt: '', updatedAt: '', ...over,
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

describe('runsTableModel', () => {
  it('maps run rows with a per-status class', () => {
    expect(runsTableModel([run({ id: 2, status: 'done', tokensUsed: 3, costUsed: 0 })])).toEqual([
      { id: 2, issue: 'o/r#1', state: 'plan', status: 'done', statusClass: 'af-status af-status-done', tokens: 3, cost: 0 },
    ]);
  });

  it('tolerates an absent list', () => {
    expect(runsTableModel(undefined)).toEqual([]);
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

describe('fsmGraphSvg', () => {
  it('renders a node per state and marks the current + terminal nodes', () => {
    const svg = fsmGraphSvg(FSM, 'plan');
    expect(svg.startsWith('<svg')).toBe(true);
    for (const state of Object.keys(FSM.states)) expect(svg).toContain(`data-state="${state}"`);
    expect(svg).toMatch(/class="af-node af-node-current"[^>]*data-state="plan"/);
    expect(svg).toMatch(/af-node-terminal"[^>]*data-state="done"/);
  });

  it('draws forward spine arrows and a labeled back-edge arc', () => {
    const svg = fsmGraphSvg(FSM, 'triage');
    expect(svg).toContain('af-edge-forward');
    expect(svg).toContain('af-edge-back');
    expect(svg).toContain('>request_changes</text>');
    expect(svg).toContain('marker id="af-arrow"');
  });

  it('does not throw on an empty config', () => {
    expect(fsmGraphSvg({}, undefined)).toContain('<svg');
  });
});
