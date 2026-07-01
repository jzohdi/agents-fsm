/**
 * Harness registry tests — per-run harness resolution (Layer 5 seam).
 *
 * Covers the id validation, the strict registry (routing + unknown-id throw), the single-harness
 * wrapper, and the resolver/executor discriminator the runner uses to normalize its constructor arg.
 */

import { describe, expect, it } from 'vitest';

import type { AgentRunRequest, AgentRunResult, StageExecutor } from './executor';
import {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  HarnessRegistry,
  isHarnessId,
  isHarnessResolver,
  singleHarness,
} from './harness';

/** A minimal executor that tags its output so tests can tell two executors apart. */
function labelledExecutor(label: string): StageExecutor {
  return {
    run: (_req: AgentRunRequest): Promise<AgentRunResult> =>
      Promise.resolve({ output: { from: label }, usage: { tokens: 1 } }),
  };
}

describe('isHarnessId', () => {
  it('accepts every known id and rejects anything else', () => {
    for (const id of HARNESS_IDS) expect(isHarnessId(id)).toBe(true);
    expect(isHarnessId('claude-code')).toBe(true); // the shipped default
    expect(isHarnessId('cursor')).toBe(true); // the second registered harness
    expect(isHarnessId('gemini')).toBe(false); // not a known harness
    expect(isHarnessId('')).toBe(false);
    expect(isHarnessId(undefined)).toBe(false);
    expect(isHarnessId(42)).toBe(false);
  });

  it('names claude-code as the default', () => {
    expect(DEFAULT_HARNESS).toBe('claude-code');
    expect(HARNESS_IDS).toContain(DEFAULT_HARNESS);
  });
});

describe('HarnessRegistry', () => {
  it('routes each id to its own executor', async () => {
    const registry = new HarnessRegistry({ 'claude-code': labelledExecutor('a'), other: labelledExecutor('b') });

    const a = await registry.for('claude-code').run({} as AgentRunRequest);
    const b = await registry.for('other').run({} as AgentRunRequest);

    expect(a.output).toEqual({ from: 'a' });
    expect(b.output).toEqual({ from: 'b' });
  });

  it('throws on an unregistered id instead of falling back — the runner turns this into a per-run escalation', () => {
    const registry = new HarnessRegistry({ 'claude-code': labelledExecutor('a') });
    expect(() => registry.for('cursor')).toThrowError(/no executor registered for harness "cursor"/);
    // The message lists what IS registered, so the operator sees the mismatch.
    expect(() => registry.for('cursor')).toThrowError(/registered: claude-code/);
  });

  it('reports its available harnesses', () => {
    expect(new HarnessRegistry({ 'claude-code': labelledExecutor('a'), other: labelledExecutor('b') }).available()).toEqual([
      'claude-code',
      'other',
    ]);
  });
});

describe('singleHarness', () => {
  it('returns the one executor for any id (the harness-never-varies case)', () => {
    const only = labelledExecutor('only');
    const resolver = singleHarness(only);
    expect(resolver.for('claude-code')).toBe(only);
    expect(resolver.for('anything-at-all')).toBe(only);
  });
});

describe('isHarnessResolver', () => {
  it('distinguishes a resolver (has `for`) from a bare executor (has `run`)', () => {
    expect(isHarnessResolver(singleHarness(labelledExecutor('x')))).toBe(true);
    expect(isHarnessResolver(new HarnessRegistry({ 'claude-code': labelledExecutor('x') }))).toBe(true);
    expect(isHarnessResolver(labelledExecutor('x'))).toBe(false);
  });
});
