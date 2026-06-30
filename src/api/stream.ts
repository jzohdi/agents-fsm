/**
 * Live stream plumbing (Layer 6 — README §3.3 / Milestone 5).
 *
 * A tiny in-process pub/sub. The Event Loop's `onTransition` and the Agent Runner's `onActivity`
 * (the seams M2/M4 deliberately exposed) plus the Orchestrator's status changes publish a typed
 * {@link StreamEvent} here; the HTTP server's SSE endpoint subscribes and forwards each event to
 * connected dashboards. Keeping the pub/sub independent of the transport is what lets us unit-test
 * the broadcast/subscribe semantics without sockets, and lets the loop/runner stay unaware of HTTP.
 *
 * Notification is best-effort: a throwing subscriber is isolated so it can never wedge the loop that
 * is publishing (the same guarantee the loop already makes for `onTransition`).
 */

import type { PhaseActivity } from '../agent/runner';
import type { Run, RunStatus, Transition } from '../store/repository';

/**
 * Everything the dashboard watches, as one discriminated union:
 *  - `transition` — a committed FSM state change. Carries the full updated {@link Run}, so token/cost
 *    totals ride along (the "token usage" stream item, README §5) with no separate event.
 *  - `activity` — one live "what is the agent doing now" step from a running stage (also persisted to
 *    the `logs` table; this is the in-process push of the same data).
 *  - `status` — a run status change with no state transition: `pause` / `resume`-from-paused / `stop`.
 */
export type StreamEvent =
  | { type: 'transition'; runId: number; transition: Transition; run: Run }
  | { type: 'activity'; activity: PhaseActivity }
  | { type: 'status'; runId: number; status: RunStatus; run: Run };

export type StreamListener = (event: StreamEvent) => void;

export class Broadcaster {
  private readonly listeners = new Set<StreamListener>();

  /** Subscribe to every event. Returns an unsubscribe function (call it on SSE disconnect). */
  subscribe(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fan an event out to every subscriber. A throwing subscriber is isolated, never re-thrown. */
  publish(event: StreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Best-effort: a faulty subscriber must not break the publisher (the loop/runner/orchestrator).
      }
    }
  }

  /** Current subscriber count — handy for tests and operational visibility. */
  get size(): number {
    return this.listeners.size;
  }
}
