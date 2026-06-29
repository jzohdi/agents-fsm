/**
 * Repository module (Layer 1 — see README §3.3).
 *
 * A thin, typed wrapper over SQLite. It is the only place that knows column names
 * and SQL. Higher layers work with the domain objects below, never raw rows.
 *
 * Round counters are intentionally NOT stored as columns; `computeCounters` derives
 * them from the append-only `transitions` log, so there is a single source of truth.
 */

import type { Db } from './db';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export type RunStatus = 'running' | 'paused' | 'blocked' | 'done' | 'needs_human';
export type AgentPhase = 'produce' | 'self_review' | 'simplify';

export interface Run {
  id: number;
  issueRef: string;
  repoRef: string;
  currentState: string;
  status: RunStatus;
  fsmConfigVersion: string;
  prNumber: number | null;
  branch: string | null;
  tokensUsed: number;
  costUsed: number;
  agentRunsCount: number;
  /** Skip flags (`needs_frontend`/`needs_backend`, …) emitted by `plan`, read on every FORWARD. */
  flags: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface Transition {
  id: number;
  runId: number;
  fromState: string;
  toState: string;
  trigger: string;
  reason: unknown;
  backEdge: boolean;
  counterKey: string | null;
  isReset: boolean;
  /** The event that caused this transition; null for manual transitions / counter resets. */
  eventId: number | null;
  createdAt: string;
}

export interface EventRow {
  id: number;
  runId: number;
  type: string;
  payload: unknown;
  status: 'pending' | 'processing' | 'done';
  createdAt: string;
  processedAt: string | null;
}

export interface Artifact {
  id: number;
  runId: number;
  kind: string;
  locator: unknown;
  createdAt: string;
}

export interface CreateRunInput {
  issueRef: string;
  repoRef: string;
  initialState: string;
  fsmConfigVersion: string;
}

export interface AppendTransitionInput {
  runId: number;
  fromState: string;
  toState: string;
  trigger: string;
  reason?: unknown;
  backEdge?: boolean;
  counterKey?: string | null;
  isReset?: boolean;
  /** The source event id, so a replayed event cannot write a second transition. */
  eventId?: number | null;
}

export interface CommitTransitionInput extends AppendTransitionInput {
  /** New run status to set alongside the state change (e.g. `needs_human` on escalation). */
  status?: RunStatus;
}

export interface RecordAgentRunInput {
  runId: number;
  stage: string;
  phase: AgentPhase;
  model?: string | null;
  input?: unknown;
  output?: unknown;
  tokens?: number;
  durationMs?: number | null;
  success?: boolean;
}

export interface AgentRunRecord {
  id: number;
  runId: number;
  stage: string;
  phase: AgentPhase;
  model: string | null;
  tokens: number;
  durationMs: number | null;
  success: boolean;
  createdAt: string;
}

// --- raw row shapes (snake_case, as stored) ------------------------------------

interface RunRow {
  id: number;
  issue_ref: string;
  repo_ref: string;
  current_state: string;
  status: RunStatus;
  fsm_config_version: string;
  pr_number: number | null;
  branch: string | null;
  tokens_used: number;
  cost_used: number;
  agent_runs_count: number;
  flags: string;
  created_at: string;
  updated_at: string;
}

interface TransitionRow {
  id: number;
  run_id: number;
  from_state: string;
  to_state: string;
  trigger: string;
  reason: string | null;
  back_edge: number;
  counter_key: string | null;
  is_reset: number;
  event_id: number | null;
  created_at: string;
}

interface EventRowRaw {
  id: number;
  run_id: number;
  type: string;
  payload: string | null;
  status: 'pending' | 'processing' | 'done';
  created_at: string;
  processed_at: string | null;
}

interface ArtifactRow {
  id: number;
  run_id: number;
  kind: string;
  locator: string | null;
  created_at: string;
}

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function mapRun(r: RunRow): Run {
  return {
    id: r.id,
    issueRef: r.issue_ref,
    repoRef: r.repo_ref,
    currentState: r.current_state,
    status: r.status,
    fsmConfigVersion: r.fsm_config_version,
    prNumber: r.pr_number,
    branch: r.branch,
    tokensUsed: r.tokens_used,
    costUsed: r.cost_used,
    agentRunsCount: r.agent_runs_count,
    flags: JSON.parse(r.flags) as Record<string, boolean>,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapTransition(r: TransitionRow): Transition {
  return {
    id: r.id,
    runId: r.run_id,
    fromState: r.from_state,
    toState: r.to_state,
    trigger: r.trigger,
    reason: parseJson(r.reason),
    backEdge: r.back_edge !== 0,
    counterKey: r.counter_key,
    isReset: r.is_reset !== 0,
    eventId: r.event_id,
    createdAt: r.created_at,
  };
}

function mapEvent(r: EventRowRaw): EventRow {
  return {
    id: r.id,
    runId: r.run_id,
    type: r.type,
    payload: parseJson(r.payload),
    status: r.status,
    createdAt: r.created_at,
    processedAt: r.processed_at,
  };
}

function mapArtifact(r: ArtifactRow): Artifact {
  return { id: r.id, runId: r.run_id, kind: r.kind, locator: parseJson(r.locator), createdAt: r.created_at };
}

export class Repository {
  constructor(private readonly db: Db) {}

  /**
   * Run `fn` in a single transaction. If it throws, every write inside is rolled
   * back — the primitive that keeps multi-step updates all-or-nothing.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- runs --------------------------------------------------------------------

  createRun(input: CreateRunInput): Run {
    const info = this.db
      .prepare(
        `INSERT INTO runs (issue_ref, repo_ref, current_state, status, fsm_config_version)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(input.issueRef, input.repoRef, input.initialState, input.fsmConfigVersion);
    const run = this.getRun(Number(info.lastInsertRowid));
    if (!run) throw new Error('createRun: row vanished immediately after insert');
    return run;
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  /**
   * All runs, newest first. The event loop is driven by the `events` queue, not by
   * scanning runs; this exists for the CLI/dashboard (list runs) and for operational
   * queries. Pass `status` to filter (e.g. list `needs_human` runs awaiting an operator).
   */
  listRuns(status?: RunStatus): Run[] {
    const rows = status
      ? (this.db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY id DESC').all(status) as RunRow[])
      : (this.db.prepare('SELECT * FROM runs ORDER BY id DESC').all() as RunRow[]);
    return rows.map(mapRun);
  }

  setRunState(id: number, state: string): void {
    this.db.prepare(`UPDATE runs SET current_state = ?, updated_at = ${NOW} WHERE id = ?`).run(state, id);
  }

  setRunStatus(id: number, status: RunStatus): void {
    this.db.prepare(`UPDATE runs SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(status, id);
  }

  /** Record the run's working branch, created when `plan` begins (README §3.1). */
  setRunBranch(id: number, branch: string): void {
    this.db.prepare(`UPDATE runs SET branch = ?, updated_at = ${NOW} WHERE id = ?`).run(branch, id);
  }

  /** Record the PR number, set when `tdd` opens the PR — separate from the branch, which exists earlier. */
  setRunPr(id: number, prNumber: number): void {
    this.db.prepare(`UPDATE runs SET pr_number = ?, updated_at = ${NOW} WHERE id = ?`).run(prNumber, id);
  }

  /**
   * Merge skip flags into the run (last write wins per key). `plan` emits
   * `needs_frontend`/`needs_backend`; persisting them on the run is what lets the
   * engine honor a skip at later FORWARD decisions, not just at the stage that set it.
   */
  mergeRunFlags(id: number, flags: Record<string, boolean>): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`mergeRunFlags: run ${id} not found`);
    const merged = { ...run.flags, ...flags };
    this.db.prepare(`UPDATE runs SET flags = ?, updated_at = ${NOW} WHERE id = ?`).run(JSON.stringify(merged), id);
    return { ...run, flags: merged };
  }

  /** Increment cumulative usage counters (for the run-budget guard). */
  addRunUsage(id: number, usage: { tokens?: number; cost?: number; agentRuns?: number }): void {
    this.db
      .prepare(
        `UPDATE runs
         SET tokens_used = tokens_used + ?,
             cost_used = cost_used + ?,
             agent_runs_count = agent_runs_count + ?,
             updated_at = ${NOW}
         WHERE id = ?`,
      )
      .run(usage.tokens ?? 0, usage.cost ?? 0, usage.agentRuns ?? 0, id);
  }

  // --- transitions -------------------------------------------------------------

  appendTransition(input: AppendTransitionInput): Transition {
    const info = this.db
      .prepare(
        `INSERT INTO transitions (run_id, from_state, to_state, trigger, reason, back_edge, counter_key, is_reset, event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.fromState,
        input.toState,
        input.trigger,
        toJson(input.reason),
        input.backEdge ? 1 : 0,
        input.counterKey ?? null,
        input.isReset ? 1 : 0,
        input.eventId ?? null,
      );
    const row = this.db.prepare('SELECT * FROM transitions WHERE id = ?').get(Number(info.lastInsertRowid)) as
      | TransitionRow
      | undefined;
    if (!row) throw new Error('appendTransition: row vanished immediately after insert');
    return mapTransition(row);
  }

  /**
   * Atomically record a transition AND advance the run's `current_state` (and
   * optionally its `status`). This is the unit of state change the event loop
   * uses, so the log and the run row can never disagree after a crash.
   */
  commitTransition(input: CommitTransitionInput): Transition {
    return this.transaction(() => {
      const transition = this.appendTransition(input);
      this.setRunState(input.runId, input.toState);
      if (input.status !== undefined) this.setRunStatus(input.runId, input.status);
      return transition;
    });
  }

  listTransitions(runId: number): Transition[] {
    const rows = this.db
      .prepare('SELECT * FROM transitions WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as TransitionRow[];
    return rows.map(mapTransition);
  }

  /**
   * The transition already recorded for an event, if any. The event loop calls
   * this before acting so a replayed event (at-least-once delivery) is a no-op
   * rather than a duplicate state change (README §3.3 Layer 3).
   */
  getTransitionByEventId(eventId: number): Transition | undefined {
    const row = this.db
      .prepare('SELECT * FROM transitions WHERE event_id = ?')
      .get(eventId) as TransitionRow | undefined;
    return row ? mapTransition(row) : undefined;
  }

  /**
   * Derive round counters from the transitions log: for each counter key, the
   * number of guarded back-edges recorded since its most recent reset. A reset row
   * with a `counter_key` resets just that key; a reset row without one resets all.
   */
  computeCounters(runId: number): Record<string, number> {
    const counters: Record<string, number> = {};
    for (const t of this.listTransitions(runId)) {
      if (t.isReset) {
        if (t.counterKey === null) {
          for (const key of Object.keys(counters)) counters[key] = 0;
        } else {
          counters[t.counterKey] = 0;
        }
        continue;
      }
      if (t.backEdge && t.counterKey !== null) {
        counters[t.counterKey] = (counters[t.counterKey] ?? 0) + 1;
      }
    }
    return counters;
  }

  // --- events ------------------------------------------------------------------

  enqueueEvent(input: { runId: number; type: string; payload?: unknown }): EventRow {
    const info = this.db
      .prepare(`INSERT INTO events (run_id, type, payload) VALUES (?, ?, ?)`)
      .run(input.runId, input.type, toJson(input.payload));
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(info.lastInsertRowid)) as EventRowRaw;
    return mapEvent(row);
  }

  /**
   * Atomically claim the oldest pending event whose run is dispatchable, marking it
   * `processing`, or return undefined if none. Single statement so two concurrent
   * claimers can never grab the same row (README §3.3 Layer 3 / Milestone 8 Phase B).
   *
   * Dispatch is gated on `runs.status = 'running'`: a `paused`, `blocked`, `done`,
   * or `needs_human` run "holds no executor" (README §3.3 Layer 3), so its events
   * wait — pending — until the run is `running` again. This is the MVP dispatch gate,
   * enforced at pickup time; the richer deterministic Scheduler (Milestone 9) slots
   * in at this same point. Without the gate the loop would dispatch a stage for an
   * escalated or paused run, and processing a stray event for a terminal run would
   * call the engine on a terminal state and throw.
   */
  claimNextEvent(): EventRow | undefined {
    const row = this.db
      .prepare(
        `UPDATE events SET status = 'processing'
         WHERE id = (
           SELECT events.id FROM events
           JOIN runs ON runs.id = events.run_id
           WHERE events.status = 'pending' AND runs.status = 'running'
           ORDER BY events.id ASC LIMIT 1
         )
         RETURNING *`,
      )
      .get() as EventRowRaw | undefined;
    return row ? mapEvent(row) : undefined;
  }

  markEventDone(id: number): void {
    this.db.prepare(`UPDATE events SET status = 'done', processed_at = ${NOW} WHERE id = ?`).run(id);
  }

  /**
   * Reclaim events stranded in `processing` by a crash, resetting them to `pending`
   * so they are re-picked-up. The event loop calls this once on startup; without it
   * `claimNextEvent` (which only selects `pending`) would never see them again,
   * silently violating at-least-once delivery (README §3.3 Layer 3). Returns the
   * number reclaimed. Idempotent transition application (see `getTransitionByEventId`)
   * keeps the re-processing safe even if the agent had already acted.
   */
  recoverProcessingEvents(): number {
    const info = this.db.prepare("UPDATE events SET status = 'pending' WHERE status = 'processing'").run();
    return info.changes;
  }

  // --- agent runs --------------------------------------------------------------

  recordAgentRun(input: RecordAgentRunInput): number {
    const info = this.db
      .prepare(
        `INSERT INTO agent_runs (run_id, stage, phase, model, input, output, tokens, duration_ms, success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.stage,
        input.phase,
        input.model ?? null,
        toJson(input.input),
        toJson(input.output),
        input.tokens ?? 0,
        input.durationMs ?? null,
        input.success === false ? 0 : 1,
      );
    return Number(info.lastInsertRowid);
  }

  /** All agent-run records for a run, oldest first — one row per phase/iteration (telemetry). */
  listAgentRuns(runId: number): AgentRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, stage, phase, model, tokens, duration_ms, success, created_at
         FROM agent_runs WHERE run_id = ? ORDER BY id ASC`,
      )
      .all(runId) as Array<{
      id: number;
      run_id: number;
      stage: string;
      phase: AgentPhase;
      model: string | null;
      tokens: number;
      duration_ms: number | null;
      success: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      stage: r.stage,
      phase: r.phase,
      model: r.model,
      tokens: r.tokens,
      durationMs: r.duration_ms,
      success: r.success !== 0,
      createdAt: r.created_at,
    }));
  }

  // --- artifacts ---------------------------------------------------------------

  recordArtifact(input: { runId: number; kind: string; locator: unknown }): Artifact {
    const info = this.db
      .prepare('INSERT INTO artifacts (run_id, kind, locator) VALUES (?, ?, ?)')
      .run(input.runId, input.kind, toJson(input.locator));
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(Number(info.lastInsertRowid)) as ArtifactRow;
    return mapArtifact(row);
  }

  listArtifacts(runId: number): Artifact[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }
}
