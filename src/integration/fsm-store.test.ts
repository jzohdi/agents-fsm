/**
 * Integration of the pure engine (Milestone 1) with the store (Milestone 0):
 * round counters derived from the transitions log feed the engine's guard, and a
 * looping back-edge escalates to `needs_human` after exactly `guards[key]` rounds.
 *
 * This is the contract the full event loop (Milestone 2) will rely on.
 */

import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from '../fsm/config';
import { decideNext } from '../fsm/engine';
import type { StageResult } from '../fsm/types';
import { openDb } from '../store/db';
import { Repository } from '../store/repository';

describe('plan_review ⇄ plan loop escalates after the guard limit', () => {
  it('records exactly `guards.plan_review` back-edges, then escalates', () => {
    const { fsm: config, version } = loadDefaultConfig();
    const limit = config.guards.plan_review!;
    const db = openDb(':memory:');
    const repo = new Repository(db);

    const run = repo.createRun({ issueRef: 'o/r#7', repoRef: 'o/r', initialState: config.initial, fsmConfigVersion: version });
    repo.setRunState(run.id, 'plan_review');

    const apply = (from: string, result: StageResult) => {
      const counters = repo.computeCounters(run.id);
      const d = decideNext(config, { current: from, result, counters });
      repo.commitTransition({
        runId: run.id,
        fromState: from,
        toState: d.to,
        trigger: result.requestedTransition,
        backEdge: d.backEdge,
        counterKey: d.counter ?? null,
        ...(d.escalated ? { status: 'needs_human' as const } : {}),
      });
      return d;
    };

    let escalated = false;
    for (let i = 0; i < limit + 5 && !escalated; i++) {
      const d = apply('plan_review', { requestedTransition: 'request_changes' });
      if (d.escalated) {
        escalated = true;
        break;
      }
      // reviewer sent it back to plan; plan reworks and proceeds forward again
      apply('plan', { requestedTransition: 'proceed' });
    }

    expect(escalated).toBe(true);

    const finalRun = repo.getRun(run.id)!;
    expect(finalRun.currentState).toBe('needs_human');
    expect(finalRun.status).toBe('needs_human');

    // Exactly `limit` counted back-edges were allowed before escalation.
    const backEdges = repo.listTransitions(run.id).filter((t) => t.backEdge && t.counterKey === 'plan_review');
    expect(backEdges).toHaveLength(limit);
  });
});
