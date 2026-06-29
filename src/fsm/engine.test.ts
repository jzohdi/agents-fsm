import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { loadDefaultConfig } from './config';
import {
  budgetExceeded,
  decideNext,
  IllegalTransitionError,
  TerminalStateError,
  UnknownStateError,
} from './engine';
import { FORWARD, type DecisionContext, type FsmConfig, type StageResult } from './types';

const { fsm: config } = loadDefaultConfig();

const BOTH = { needs_frontend: true, needs_backend: true };

function decide(current: string, result: StageResult, counters?: Record<string, number>) {
  const ctx: DecisionContext = { current, result, ...(counters ? { counters } : {}) };
  return decideNext(config, ctx);
}

describe('decideNext — forward path (README §2)', () => {
  const cases: Array<[string, string, StageResult, string]> = [
    ['triage proceeds to plan', 'triage', { requestedTransition: 'proceed' }, 'plan'],
    ['plan proceeds to plan_review', 'plan', { requestedTransition: 'proceed' }, 'plan_review'],
    ['plan_review approves to interface_design', 'plan_review', { requestedTransition: 'approve' }, 'interface_design'],
    ['interface_design proceeds to tdd', 'interface_design', { requestedTransition: 'proceed' }, 'tdd'],
    ['tdd proceeds to frontend', 'tdd', { requestedTransition: 'proceed', flags: BOTH }, 'frontend'],
    ['frontend proceeds to backend', 'frontend', { requestedTransition: 'proceed', flags: BOTH }, 'backend'],
    ['backend proceeds to code_review', 'backend', { requestedTransition: 'proceed', flags: BOTH }, 'code_review'],
    ['code_review approves to done', 'code_review', { requestedTransition: 'approve', flags: BOTH }, 'done'],
  ];

  it.each(cases)('%s', (_name, current, result, expected) => {
    const d = decide(current, result);
    expect(d.to).toBe(expected);
    expect(d.escalated).toBe(false);
  });
});

describe('decideNext — full golden-path walk (README §2)', () => {
  /** Walk forward from `initial` to a terminal, always taking the FORWARD trigger. */
  function walkForward(flags: Record<string, boolean>): string[] {
    const seq = [config.initial];
    let current = config.initial;
    for (let i = 0; i < 50; i++) {
      const state = config.states[current]!;
      if (state.terminal) return seq;
      const forwardTrigger = Object.entries(state.transitions!).find(([, def]) => def.to === FORWARD)?.[0];
      if (forwardTrigger === undefined) throw new Error(`no FORWARD trigger from ${current}`);
      const d = decide(current, { requestedTransition: forwardTrigger, flags });
      seq.push(d.to);
      current = d.to;
    }
    throw new Error('walk did not terminate');
  }

  it('reaches done through every stage when both flags are set', () => {
    expect(walkForward(BOTH)).toEqual([
      'triage',
      'plan',
      'plan_review',
      'interface_design',
      'tdd',
      'frontend',
      'backend',
      'code_review',
      'done',
    ]);
  });

  it('reaches done with frontend skipped', () => {
    expect(walkForward({ needs_frontend: false, needs_backend: true })).toEqual([
      'triage',
      'plan',
      'plan_review',
      'interface_design',
      'tdd',
      'backend',
      'code_review',
      'done',
    ]);
  });
});

describe('decideNext — skips (README §2 skipping frontend/backend)', () => {
  it('skips frontend when needs_frontend is false', () => {
    expect(decide('tdd', { requestedTransition: 'proceed', flags: { needs_frontend: false, needs_backend: true } }).to).toBe(
      'backend',
    );
  });

  it('skips backend when needs_backend is false (last impl stage → code_review)', () => {
    expect(
      decide('frontend', { requestedTransition: 'proceed', flags: { needs_frontend: true, needs_backend: false } }).to,
    ).toBe('code_review');
  });

  it('skips both → code_review (edge case)', () => {
    expect(
      decide('tdd', { requestedTransition: 'proceed', flags: { needs_frontend: false, needs_backend: false } }).to,
    ).toBe('code_review');
  });
});

describe('decideNext — back-edges (README §2)', () => {
  it('plan_review requests changes → plan', () => {
    const d = decide('plan_review', { requestedTransition: 'request_changes' });
    expect(d).toMatchObject({ to: 'plan', backEdge: true, counter: 'plan_review', escalated: false });
  });

  it('frontend reverts to interface_design', () => {
    const d = decide('frontend', { requestedTransition: 'interfaces_inadequate', flags: BOTH });
    expect(d).toMatchObject({ to: 'interface_design', backEdge: true, counter: 'interface_revision' });
  });

  it('backend reverts to interface_design', () => {
    const d = decide('backend', { requestedTransition: 'interfaces_inadequate', flags: BOTH });
    expect(d.to).toBe('interface_design');
  });

  it('code_review requests changes to a chosen target', () => {
    expect(decide('code_review', { requestedTransition: 'request_changes', target: 'backend', flags: BOTH }).to).toBe(
      'backend',
    );
    expect(decide('code_review', { requestedTransition: 'request_changes', target: 'frontend', flags: BOTH }).to).toBe(
      'frontend',
    );
  });
});

describe('decideNext — guards (README §2)', () => {
  it('allows the back-edge just under the limit', () => {
    const d = decide('plan_review', { requestedTransition: 'request_changes' }, { plan_review: 2 });
    expect(d.to).toBe('plan');
    expect(d.escalated).toBe(false);
  });

  it('escalates to needs_human exactly at the limit', () => {
    const d = decide('plan_review', { requestedTransition: 'request_changes' }, { plan_review: 3 });
    expect(d.to).toBe('needs_human');
    expect(d.escalated).toBe(true);
  });

  it('escalates the code_review loop at its limit', () => {
    const d = decide('code_review', { requestedTransition: 'request_changes', target: 'backend', flags: BOTH }, { code_review: 3 });
    expect(d).toMatchObject({ to: 'needs_human', escalated: true });
  });
});

describe('decideNext — escalate trigger', () => {
  it.each(['triage', 'plan', 'plan_review', 'interface_design', 'tdd', 'frontend', 'backend', 'code_review'])(
    '%s can escalate to needs_human',
    (state) => {
      expect(decide(state, { requestedTransition: 'escalate', flags: BOTH }).to).toBe('needs_human');
    },
  );
});

describe('decideNext — error cases', () => {
  it('throws on an undefined trigger', () => {
    expect(() => decide('plan', { requestedTransition: 'nope' })).toThrow(IllegalTransitionError);
  });

  it('throws on terminal states', () => {
    expect(() => decide('done', { requestedTransition: 'proceed' })).toThrow(TerminalStateError);
    expect(() => decide('needs_human', { requestedTransition: 'proceed' })).toThrow(TerminalStateError);
  });

  it('throws on an unknown current state', () => {
    expect(() => decide('ghost', { requestedTransition: 'proceed' })).toThrow(UnknownStateError);
  });

  it('throws when a toOneOf transition has no target', () => {
    expect(() => decide('code_review', { requestedTransition: 'request_changes', flags: BOTH })).toThrow(
      IllegalTransitionError,
    );
  });

  it('throws when the chosen target is not allowed', () => {
    expect(() => decide('code_review', { requestedTransition: 'request_changes', target: 'plan', flags: BOTH })).toThrow(
      IllegalTransitionError,
    );
  });

  it('throws when the chosen target is skipped for this run', () => {
    expect(() =>
      decide('code_review', {
        requestedTransition: 'request_changes',
        target: 'frontend',
        flags: { needs_frontend: false, needs_backend: true },
      }),
    ).toThrow(IllegalTransitionError);
  });
});

describe('budgetExceeded (README §2 run budget)', () => {
  it('is false when no budget is set', () => {
    expect(budgetExceeded(undefined, { tokens: 1e9 })).toBe(false);
  });

  it('trips on each ceiling independently', () => {
    expect(budgetExceeded({ maxTokens: 100 }, { tokens: 101 })).toBe(true);
    expect(budgetExceeded({ maxTokens: 100 }, { tokens: 100 })).toBe(false);
    expect(budgetExceeded({ maxAgentRuns: 5 }, { agentRuns: 6 })).toBe(true);
    expect(budgetExceeded({ maxWallClockMs: 1000 }, { wallClockMs: 1001 })).toBe(true);
  });
});

describe('decideNext — invariants (property-based, README Milestone 1)', () => {
  const config2: FsmConfig = config;
  const nonTerminal = Object.entries(config2.states)
    .filter(([, s]) => !s.terminal)
    .map(([name]) => name);

  it('always returns a known state, and always escalates at/over a guard limit', () => {
    fc.assert(
      fc.property(fc.constantFrom(...nonTerminal), fc.nat({ max: 8 }), (stateName, count) => {
        const transitions = config2.states[stateName]!.transitions!;
        for (const [trigger, def] of Object.entries(transitions)) {
          const result: StageResult = {
            requestedTransition: trigger,
            flags: BOTH,
            ...(def.toOneOf ? { target: def.toOneOf[0] } : {}),
          };
          const counters = def.counter ? { [def.counter]: count } : {};
          const d = decideNext(config2, { current: stateName, result, counters });

          // Invariant 1: the result is always a state that exists in the config.
          expect(config2.states[d.to]).toBeDefined();

          // Invariant 2: a guarded back-edge at/over its limit always escalates.
          if (def.backEdge && def.counter && count >= config2.guards[def.counter]!) {
            expect(d.to).toBe(config2.escalationState);
            expect(d.escalated).toBe(true);
          }
        }
      }),
    );
  });
});
