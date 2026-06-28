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

  setRunState(id: number, state: string): void {
    this.db.prepare(`UPDATE runs SET current_state = ?, updated_at = ${NOW} WHERE id = ?`).run(state, id);
  }

  setRunStatus(id: number, status: RunStatus): void {
    this.db.prepare(`UPDATE runs SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(status, id);
  }

  setRunPr(id: number, prNumber: number, branch: string): void {
    this.db
      .prepare(`UPDATE runs SET pr_number = ?, branch = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(prNumber, branch, id);
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
        `INSERT INTO transitions (run_id, from_state, to_state, trigger, reason, back_edge, counter_key, is_reset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
   * Atomically claim the oldest pending event (pending -> processing) and return
   * it, or undefined if none. Single statement so two concurrent claimers can
   * never grab the same row (README §3.3 Layer 3 / Milestone 8 Phase B).
   */
  claimNextEvent(): EventRow | undefined {
    const row = this.db
      .prepare(
        `UPDATE events SET status = 'processing'
         WHERE id = (SELECT id FROM events WHERE status = 'pending' ORDER BY id ASC LIMIT 1)
         RETURNING *`,
      )
      .get() as EventRowRaw | undefined;
    return row ? mapEvent(row) : undefined;
  }

  markEventDone(id: number): void {
    this.db.prepare(`UPDATE events SET status = 'done', processed_at = ${NOW} WHERE id = ?`).run(id);
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
