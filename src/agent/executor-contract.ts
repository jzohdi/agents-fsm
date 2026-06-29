/**
 * Shared Stage Executor contract suite (Layer 5 — README §3.3, Milestone 3).
 *
 * Every `StageExecutor` must satisfy the same observable contract: "one work session in,
 * structured JSON output + token usage out." This suite encodes that contract once and is
 * run against each executor — the in-memory stub, the subprocess executor over a fake
 * harness, and (behind a flag) the subprocess executor over the real Claude Code CLI. Running
 * the *same* assertions against all of them is what stops the stub from silently drifting from
 * real harness behavior (README Milestone 3 tests).
 *
 * A participant supplies a `setup(expected)` that returns an executor plus a request
 * engineered so the agent yields `expected` — for the stub a canned handler, for the
 * subprocess a fake/real harness whose final message is `expected` as JSON.
 */

import { describe, expect, it } from 'vitest';

import type { AgentRunRequest, StageExecutor } from './executor';

export interface ContractParticipant {
  name: string;
  /** Build an executor + a request rigged so `executor.run(req)` yields `expected` as output. */
  setup(expected: unknown): { executor: StageExecutor; req: AgentRunRequest };
}

/** Register the contract `describe` block for one participant. */
export function stageExecutorContract(participant: ContractParticipant): void {
  describe(`StageExecutor contract — ${participant.name}`, () => {
    it('returns the agent\'s structured JSON output unchanged', async () => {
      const expected = { requestedTransition: 'proceed', flags: { needs_backend: true } };
      const { executor, req } = participant.setup(expected);
      const result = await executor.run(req);
      expect(result.output).toEqual(expected);
    });

    it('reports finite, non-negative token usage', async () => {
      const { executor, req } = participant.setup({ requestedTransition: 'approve' });
      const result = await executor.run(req);
      expect(Number.isFinite(result.usage.tokens)).toBe(true);
      expect(result.usage.tokens).toBeGreaterThanOrEqual(0);
    });
  });
}

/** A minimal request the contract participants can extend. */
export function contractRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: 1,
    stage: 'plan',
    phase: 'produce',
    model: 'frontier',
    system: 'You are a test agent.',
    input: 'Respond now.',
    ...overrides,
  };
}
