import { describe, expect, it } from 'vitest';

import { ConfigValidationError, hashConfig, loadDefaultFsmConfig, parseFsmConfig } from './config';
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
    const { config, version } = loadDefaultFsmConfig();
    expect(config.initial).toBe('triage');
    expect(version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes deterministically and is order-independent', () => {
    const { config } = loadDefaultFsmConfig();
    expect(hashConfig(config)).toBe(hashConfig(config));
    // Reordering top-level keys must not change the hash.
    const reordered: FsmConfig = {
      states: config.states,
      guards: config.guards,
      forwardOrder: config.forwardOrder,
      escalationState: config.escalationState,
      initial: config.initial,
      ...(config.budget ? { budget: config.budget } : {}),
    };
    expect(hashConfig(reordered)).toBe(hashConfig(config));
  });

  it('changes the hash when the config changes', () => {
    const { config } = loadDefaultFsmConfig();
    const changed: FsmConfig = { ...config, guards: { ...config.guards, code_review: 99 } };
    expect(hashConfig(changed)).not.toBe(hashConfig(config));
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
