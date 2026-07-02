/**
 * PR state-label mirror (Milestone 9 / README §3.5): mirror each run's current FSM state onto its
 * PR as an `af:<state>` label — at-a-glance visibility on GitHub and a disaster-recovery breadcrumb.
 *
 * A **derived view**, never load-bearing: this is a fire-and-forget Broadcaster subscriber the
 * daemon composes beside the SSE stream (serve.ts). SQLite stays the owner of runtime state; a
 * failed label write is logged and forgotten (the next transition retries naturally), and by the
 * Broadcaster's contract a throwing subscriber can never wedge the loop. Runs without a PR yet
 * (before `tdd`) have nowhere to mirror and are skipped.
 */

import type { RepoResolver } from '../integration/github-resolver';
import type { StreamListener } from './stream';

/** Build the subscriber. `onError` defaults to a console warning (the daemon's pattern). */
export function stateLabelMirror(resolver: RepoResolver, onError?: (message: string) => void): StreamListener {
  const warn = onError ?? ((message) => console.warn(`[state-label-mirror] ${message}`));
  return (event) => {
    if (event.type !== 'transition' || event.run.prNumber === null) return;
    const { github } = resolver.for(event.run.repoRef);
    void github.setPrLabels(event.run.prNumber, [`af:${event.transition.toState}`]).catch((err) => {
      warn(`label mirror failed for PR #${event.run.prNumber} (run ${event.runId}): ${String(err)}`);
    });
  };
}
