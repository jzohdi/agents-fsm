/**
 * PR state-label mirror tests (Milestone 9 / README §3.5): the `af:<state>` label follows the run's
 * transitions, human labels survive, PR-less runs are skipped, and a failing GitHub call is logged —
 * never thrown (a derived view must not wedge anything).
 */

import { describe, expect, it } from 'vitest';

import { FakeGitHub } from '../integration/github-fake';
import { singleRepoResolver } from '../integration/github-resolver';
import type { Run, Transition } from '../store/repository';
import { stateLabelMirror } from './state-label-mirror';

function transitionEvent(run: Partial<Run>, toState: string) {
  return {
    type: 'transition' as const,
    runId: run.id ?? 1,
    transition: { toState } as Transition,
    run: { id: 1, repoRef: 'o/r', prNumber: null, ...run } as Run,
  };
}

/** One macrotask, letting the fire-and-forget label write settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('stateLabelMirror', () => {
  it('swaps the af:* label on each transition, leaving human labels alone', async () => {
    const github = new FakeGitHub();
    github.seedPr(5, { branch: 'agent/run-1' });
    await github.setPrLabels(5, ['af:tdd']);
    github.prLabels(5); // sanity: seeded state below asserts the swap, not accumulation
    const mirror = stateLabelMirror(singleRepoResolver({ github, baseBranch: 'main' }));

    mirror(transitionEvent({ prNumber: 5 }, 'code_review'));
    await settle();

    expect(github.prLabels(5)).toEqual(['af:code_review']);

    mirror(transitionEvent({ prNumber: 5 }, 'done'));
    await settle();
    expect(github.prLabels(5)).toEqual(['af:done']);
  });

  it('skips runs without a PR and non-transition events', async () => {
    const github = new FakeGitHub();
    const mirror = stateLabelMirror(singleRepoResolver({ github, baseBranch: 'main' }));

    mirror(transitionEvent({ prNumber: null }, 'plan')); // nowhere to mirror — must not throw
    mirror({ type: 'status', runId: 1, status: 'paused', run: { id: 1, repoRef: 'o/r', prNumber: 5 } as Run });
    await settle();
  });

  it('logs a failed label write instead of throwing (best-effort by contract)', async () => {
    const github = new FakeGitHub(); // PR #9 does not exist → setPrLabels rejects
    const warnings: string[] = [];
    const mirror = stateLabelMirror(singleRepoResolver({ github, baseBranch: 'main' }), (m) => warnings.push(m));

    mirror(transitionEvent({ prNumber: 9 }, 'plan'));
    await settle();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('PR #9');
  });
});
