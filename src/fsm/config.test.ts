import { describe, expect, it } from 'vitest';

import {
  ConfigValidationError,
  hashConfig,
  loadDefaultConfig,
  parseConfigFile,
  parseFsmConfig,
  recipeFor,
} from './config';
import type { FsmConfig } from './types';

/** A minimal valid config used as a base for negative tests. */
function baseRaw(): Record<string, unknown> {
  return {
    initial: 'a',
    escalationState: 'stop',
    forwardOrder: ['a', 'b'],
    guards: { loop: 2 },
    states: {
      a: { transitions: { proceed: { to: 'FORWARD' } } },
      b: { transitions: { back: { to: 'a', backEdge: true, counter: 'loop' }, escalate: { to: 'stop' } } },
      stop: { terminal: true },
    },
  };
}

describe('default config', () => {
  it('loads, validates, and produces a 16-char version', () => {
    const { fsm, version } = loadDefaultConfig();
    expect(fsm.initial).toBe('triage');
    expect(version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('splits the agent recipe out of the FSM rules', () => {
    const { fsm, agents } = loadDefaultConfig();
    // The agents section is parsed separately and never leaks into the FSM config.
    expect('agents' in fsm).toBe(false);
    // Pure review stages are configured to produce-only.
    expect(recipeFor('code_review', agents).phases).toEqual(['produce']);
    // Producing stages fall back to the full default recipe.
    expect(recipeFor('plan', agents).phases).toEqual(['produce', 'self_review', 'simplify']);
    expect(recipeFor('plan', agents).reviewCap).toBe(2);
  });

  it('declares the per-stage io for the default pipeline', () => {
    const { agents } = loadDefaultConfig();
    expect(recipeFor('triage', agents).io).toEqual({ kind: 'triage' });
    expect(recipeFor('tdd', agents).io).toEqual({ kind: 'produce', opensPr: true });
    expect(recipeFor('plan_review', agents).io).toEqual({ kind: 'review' });
    expect(recipeFor('code_review', agents).io).toEqual({ kind: 'review' });
    expect(recipeFor('plan', agents).io).toEqual({ kind: 'produce' }); // default for producing stages
  });

  it('hashes deterministically and is order-independent', () => {
    const { fsm } = loadDefaultConfig();
    expect(hashConfig(fsm)).toBe(hashConfig(fsm));
    // Reordering top-level keys must not change the hash.
    const reordered: FsmConfig = {
      states: fsm.states,
      guards: fsm.guards,
      forwardOrder: fsm.forwardOrder,
      escalationState: fsm.escalationState,
      initial: fsm.initial,
      ...(fsm.budget ? { budget: fsm.budget } : {}),
    };
    expect(hashConfig(reordered)).toBe(hashConfig(fsm));
  });

  it('changes the hash when the config changes', () => {
    const { fsm } = loadDefaultConfig();
    const changed: FsmConfig = { ...fsm, guards: { ...fsm.guards, code_review: 99 } };
    expect(hashConfig(changed)).not.toBe(hashConfig(fsm));
  });
});

describe('parseConfigFile — agent recipe', () => {
  function withAgents(agents: unknown): Record<string, unknown> {
    return { ...baseRaw(), agents };
  }

  it('parses a valid per-stage recipe', () => {
    const { agents } = parseConfigFile(withAgents({ a: { phases: ['produce'], reviewCap: 3 } }));
    expect(recipeFor('a', agents)).toMatchObject({ phases: ['produce'], reviewCap: 3 });
  });

  it('rejects an agent recipe for an unknown state', () => {
    expect(() => parseConfigFile(withAgents({ ghost: { phases: ['produce'] } }))).toThrow(/unknown state/);
  });

  it('rejects an agent recipe for a terminal state', () => {
    expect(() => parseConfigFile(withAgents({ stop: { phases: ['produce'] } }))).toThrow(/terminal state/);
  });

  it('rejects an empty phase list', () => {
    expect(() => parseConfigFile(withAgents({ a: { phases: [] } }))).toThrow(ConfigValidationError);
  });

  it('rejects an unknown phase name', () => {
    expect(() => parseConfigFile(withAgents({ a: { phases: ['compile'] } }))).toThrow(ConfigValidationError);
  });

  it('accepts the canonical prefixes the runner understands', () => {
    expect(() => parseConfigFile(withAgents({ a: { phases: ['produce'] } }))).not.toThrow();
    expect(() => parseConfigFile(withAgents({ a: { phases: ['produce', 'self_review'] } }))).not.toThrow();
    expect(() => parseConfigFile(withAgents({ a: { phases: ['produce', 'self_review', 'simplify'] } }))).not.toThrow();
  });

  it('rejects non-canonical recipes the runner would silently misinterpret', () => {
    // simplify without self_review (the runner only simplifies inside the review loop).
    expect(() => parseConfigFile(withAgents({ a: { phases: ['produce', 'simplify'] } }))).toThrow(/prefix/);
    // self_review without a preceding produce.
    expect(() => parseConfigFile(withAgents({ a: { phases: ['self_review'] } }))).toThrow(/prefix/);
    // out of order.
    expect(() => parseConfigFile(withAgents({ a: { phases: ['self_review', 'produce'] } }))).toThrow(/prefix/);
  });

  it('treats an absent agents section as no overrides', () => {
    const { agents } = parseConfigFile(baseRaw());
    expect(agents).toEqual({});
    expect(recipeFor('a', agents).phases).toEqual(['produce', 'self_review', 'simplify']);
  });

  it('allows a recipe with no phases (defaults apply) and an allow-list', () => {
    const { agents } = parseConfigFile(withAgents({ a: { allowedTools: ['Read', 'Bash'] } }));
    expect(recipeFor('a', agents)).toMatchObject({ phases: ['produce', 'self_review', 'simplify'], allowedTools: ['Read', 'Bash'] });
  });

  it('reads the per-stage io descriptor, defaulting to a produce stage', () => {
    const { agents } = parseConfigFile(withAgents({ a: { io: { kind: 'review' } } }));
    expect(recipeFor('a', agents).io).toEqual({ kind: 'review' });
    expect(recipeFor('missing', agents).io).toEqual({ kind: 'produce' }); // default
  });

  it('rejects opensPr on a non-produce stage', () => {
    expect(() => parseConfigFile(withAgents({ a: { io: { kind: 'review', opensPr: true } } }))).toThrow(/opensPr/);
    expect(() => parseConfigFile(withAgents({ a: { io: { kind: 'produce', opensPr: true } } }))).not.toThrow();
  });
});

describe('parseFsmConfig — accepts valid', () => {
  it('parses the minimal base config', () => {
    expect(() => parseFsmConfig(baseRaw())).not.toThrow();
  });
});

describe('parseFsmConfig — rejects invalid', () => {
  it('unknown initial state', () => {
    const raw = baseRaw();
    raw.initial = 'missing';
    expect(() => parseFsmConfig(raw)).toThrow(ConfigValidationError);
  });

  it('transition with both `to` and `toOneOf`', () => {
    const raw = baseRaw();
    (raw.states as any).a.transitions.proceed = { to: 'b', toOneOf: ['b'] };
    expect(() => parseFsmConfig(raw)).toThrow(/exactly one of/);
  });

  it('counter without a matching guard limit', () => {
    const raw = baseRaw();
    (raw.states as any).b.transitions.back.counter = 'undeclared';
    expect(() => parseFsmConfig(raw)).toThrow(/no matching guard limit/);
  });

  it('counter on a non-back-edge', () => {
    const raw = baseRaw();
    (raw.states as any).a.transitions.proceed = { to: 'b', counter: 'loop' };
    expect(() => parseFsmConfig(raw)).toThrow(/not a backEdge/);
  });

  it('terminal state with transitions', () => {
    const raw = baseRaw();
    (raw.states as any).stop = { terminal: true, transitions: { x: { to: 'a' } } };
    expect(() => parseFsmConfig(raw)).toThrow(/must have no transitions/);
  });

  it('non-terminal state with no transitions', () => {
    const raw = baseRaw();
    (raw.states as any).a = {};
    expect(() => parseFsmConfig(raw)).toThrow(/at least one transition/);
  });

  it('FORWARD from a state not in forwardOrder', () => {
    const raw = baseRaw();
    raw.forwardOrder = ['b']; // 'a' no longer in forwardOrder but uses FORWARD
    expect(() => parseFsmConfig(raw)).toThrow(/not in forwardOrder/);
  });

  it('FORWARD from the last state in forwardOrder (no successor)', () => {
    const raw = baseRaw();
    raw.forwardOrder = ['a']; // 'a' uses FORWARD but is now last → no successor
    expect(() => parseFsmConfig(raw)).toThrow(/last in forwardOrder/);
  });

  it('transition targeting an unknown state', () => {
    const raw = baseRaw();
    (raw.states as any).b.transitions.back.to = 'nowhere';
    expect(() => parseFsmConfig(raw)).toThrow(/unknown state/);
  });

  it('unknown top-level key (strict schema)', () => {
    const raw = baseRaw();
    (raw as any).extra = true;
    expect(() => parseFsmConfig(raw)).toThrow(ConfigValidationError);
  });
});
