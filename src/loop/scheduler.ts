/**
 * Scheduler (Layer 3 — README §3.3 / Milestone 9). Pure, deterministic, no I/O.
 *
 * "The Scheduler decides *which* run advances; the FSM decides *how* a run advances." This module
 * is the deciding half's brain: dependency satisfaction, cycle detection, and the total dispatch
 * order. It knows nothing about GitHub, SQL, or time — the Scheduler Poller feeds it parsed issue
 * declarations ({@link ../integration/issue-markers}) and the closed-issue set it read from the
 * adapter, and the claim's SQL `ORDER BY` mirrors {@link compareRuns} (a cross-check test keeps
 * the two encodings from drifting).
 *
 * Everything here is **per-repo**: dependencies are bare issue numbers (§3.5), which collide
 * across repos, so callers partition runs by `repoRef` and never feed two repos' runs into one
 * call. Like the FSM engine, same inputs ⇒ same outputs — which is what makes it table-testable.
 */

/** The ordering inputs (README §3.3): `priority` desc, then `order_key` asc, then issue number asc. */
export interface SchedulingKey {
  priority: number;
  orderKey: string;
  issueNumber: number;
}

/** One active run as the cycle detector sees it: its issue, and the issues it declared it needs. */
export interface SchedulerRun {
  runId: number;
  issueNumber: number;
  dependsOn: readonly number[];
}

/**
 * Every declared dependency closed? (Issue-closed is the satisfaction signal — plan §2: a fleet
 * PR's `Closes #N` closes the issue at merge, a human closes human-managed ones.) The caller
 * supplies the closed set it read for *this run's repo*.
 */
export function isSatisfied(dependsOn: readonly number[], closedIssues: ReadonlySet<number>): boolean {
  return dependsOn.every((issue) => closedIssues.has(issue));
}

/**
 * The total dispatch order among dispatchable runs: `priority` desc → `order_key` asc → issue
 * number asc. Total and antisymmetric over distinct issues, so the schedule is reproducible from
 * its inputs. `order_key` compares as **UTF-8 bytes** (`Buffer.compare`) — exactly SQLite's BINARY
 * collation — so this comparator and the claim's `ORDER BY` can never disagree on the same keys.
 */
export function compareRuns(a: SchedulingKey, b: SchedulingKey): number {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  const byKey = Buffer.compare(Buffer.from(a.orderKey, 'utf8'), Buffer.from(b.orderKey, 'utf8'));
  if (byKey !== 0) {
    return byKey;
  }
  return a.issueNumber - b.issueNumber;
}

/**
 * Dependency cycles among active runs' issues. A run's dependency contributes an edge only when
 * the depended-on issue itself has a run in the given set — a dep on an issue with *no* active run
 * is a leaf (that run just stays blocked until a human closes the issue), never a cycle. A
 * self-dependency is a one-node cycle.
 *
 * Returns each cycle as its members' run ids, deterministically: members ascending, cycles ordered
 * by their smallest member. The poller escalates every member to `needs_human` (README §3.3 —
 * "a cycle escalates every run in it rather than deadlocking forever").
 *
 * Implementation: Tarjan's strongly-connected components. A cycle is an SCC of size > 1, or a
 * single node with a self-edge. Iterative-enough for real fleets (recursion depth = longest
 * dependency chain among *active* runs).
 */
export function detectCycles(runs: readonly SchedulerRun[]): number[][] {
  const byIssue = new Map<number, SchedulerRun>();
  for (const run of runs) {
    // Two active runs on one issue can't happen upstream (the duplicate-issue 409); if fed one
    // anyway, first wins — deterministic, and the duplicate still participates via its own edges.
    if (!byIssue.has(run.issueNumber)) {
      byIssue.set(run.issueNumber, run);
    }
  }

  // Tarjan state, keyed by issue number.
  const index = new Map<number, number>();
  const lowLink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  let nextIndex = 0;
  const cycles: number[][] = [];

  function strongConnect(issue: number): void {
    index.set(issue, nextIndex);
    lowLink.set(issue, nextIndex);
    nextIndex += 1;
    stack.push(issue);
    onStack.add(issue);

    const run = byIssue.get(issue)!;
    for (const dep of run.dependsOn) {
      if (!byIssue.has(dep)) {
        continue; // dep has no active run — a leaf, not an edge (see doc comment)
      }
      if (!index.has(dep)) {
        strongConnect(dep);
        lowLink.set(issue, Math.min(lowLink.get(issue)!, lowLink.get(dep)!));
      } else if (onStack.has(dep)) {
        lowLink.set(issue, Math.min(lowLink.get(issue)!, index.get(dep)!));
      }
    }

    if (lowLink.get(issue) === index.get(issue)) {
      const component: number[] = [];
      let popped: number;
      do {
        popped = stack.pop()!;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== issue);

      // A single-node component is a cycle only when the node depends on itself; the root of a
      // just-popped SCC is always `issue`, so `run` is the right node to ask.
      const isCycle = component.length > 1 || run.dependsOn.includes(issue);
      if (isCycle) {
        cycles.push(component.map((i) => byIssue.get(i)!.runId).sort((a, b) => a - b));
      }
    }
  }

  // Deterministic visit order (ascending issue number) ⇒ deterministic output order.
  for (const issue of [...byIssue.keys()].sort((a, b) => a - b)) {
    if (!index.has(issue)) {
      strongConnect(issue);
    }
  }

  return cycles.sort((a, b) => a[0]! - b[0]!);
}
