/**
 * Repository module (Layer 1 — see README §3.3).
 *
 * A thin, typed wrapper over SQLite. It is the only place that knows column names
 * and SQL. Higher layers work with the domain objects below, never raw rows.
 *
 * Round counters are intentionally NOT stored as columns; `computeCounters` derives
 * them from the append-only `transitions` log, so there is a single source of truth.
 */

import type { AdviceOption } from '../agent/runner';
import type { Db } from './db';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export type RunStatus = 'running' | 'paused' | 'blocked' | 'awaiting_input' | 'done' | 'needs_human' | 'stopped';
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
  /** When an operator archived this (terminal) run out of the dashboard's Resolved lane; `null` = not archived. */
  archivedAt: string | null;
  /** Operator override of the global cost ceiling (M8 B3): `next_step` = one more stage, `full` = the whole run, `null` = none. */
  costOverride: CostOverride | null;
  /** Per-run harness model override (the dashboard's model picker); `null` = the daemon default. Read by the runner at each stage, so a change takes effect on the next stage. */
  modelOverride: string | null;
  /** Per-run reasoning-effort override (Claude Code's `--effort`); `null` = the model default. Read by the runner at each stage. */
  effortOverride: string | null;
  /** Which agent harness runs this, pinned at start (a {@link HarnessId} from the agent layer; kept as a
   *  plain string here so the store never depends upward on the agent layer). Defaults to `claude-code`. */
  harness: string;
  /** Cached §3.5 scheduling: same-repo issue numbers that must close before this run dispatches (M9).
   *  The issue owns the declaration; this cache is refreshed post-triage and by the Scheduler Poller. */
  dependsOn: number[];
  /** Cached §3.5 scheduling: higher dispatches first (the claim's ORDER BY). Default 0. */
  priority: number;
  /** Cached §3.5 scheduling: lexicographic tiebreaker after priority. Default `''`. */
  orderKey: string;
  /** Dependency-satisfaction latch: stamped when every `dependsOn` issue was seen closed; cleared when
   *  the declaration changes. The claim dispatches only when `dependsOn` is empty or this is set. */
  depsSatisfiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Cached scheduling-declaration shape ({@link Repository.setRunScheduling}). Mirrors the §3.5 marker's
 *  `SchedulingDecl` (integration/issue-markers) — redeclared here so the store stays layer-clean. */
export interface RunScheduling {
  dependsOn: number[];
  priority: number;
  orderKey: string;
}

/** How an operator lets a run cross the global cost ceiling: one more stage, or the whole run. */
export type CostOverride = 'next_step' | 'full';

/** The permission grant a chat prompt runs under: `read` = read-only tools, dispatches immediately
 *  (safe alongside an in-flight stage); `write` = edit tools, held until the run is parked. */
export type ChatMode = 'read' | 'write';

export type ChatStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/**
 * One operator ↔ agent chat exchange on a run (the "general chat" side channel): the operator's
 * prompt plus the agent's eventual reply. Lifecycle: `queued` → `running` → `done`/`error`, or
 * `queued` → `cancelled` (an operator withdrawal; only a not-yet-claimed prompt can be cancelled).
 */
export interface ChatExchange {
  id: number;
  runId: number;
  prompt: string;
  mode: ChatMode;
  status: ChatStatus;
  /** The agent's reply (markdown), set when the exchange completes. */
  response: string | null;
  /** Why the exchange failed, set when status is `error`. */
  error: string | null;
  /** Write mode: the commit pushed after the agent worked (HEAD after commit-if-dirty + push). */
  commitSha: string | null;
  tokens: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A persisted advisor result for a run (the escalation-resolution advisor, Layer 3). */
export interface Advice {
  id: number;
  runId: number;
  summary: string;
  /** Parsed from the stored JSON — 1–3 resume/revert options, first = recommended. */
  options: AdviceOption[];
  tokens: number;
  createdAt: string;
}

/**
 * Run statuses a `write`-mode chat may execute under: the run is parked with no executor of its own
 * (paused-like), so an agent editing its working tree cannot race an in-flight stage. Deliberately
 * excludes `running` (the pipeline is advancing) and `blocked` (the Scheduler Poller may wake the run
 * and *drop its working tree* at any tick — never edit a tree that can vanish underneath the agent).
 */
export const CHAT_WRITE_SAFE_STATUSES: readonly RunStatus[] = ['paused', 'needs_human', 'awaiting_input', 'done', 'stopped'];

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
  /** Which harness runs this ({@link HarnessId}). Omit → the column default (`claude-code`). */
  harness?: string;
  /** Optional harness model to start the run on (the pre-start model picker); omit/`null` → daemon default. */
  model?: string | null;
  /** Optional reasoning effort to start the run on (Claude Code's `--effort`); omit/`null` → model default. */
  effort?: string | null;
}

/** Optional filters for {@link Repository.listRuns}; omit a field to not filter on it. */
export interface ListRunsFilter {
  status?: RunStatus;
  /** Canonical `owner/name`; matched case-insensitively against `runs.repo_ref`. */
  repo?: string;
}

/** An enrolled repository the fleet can run (Milestone 8 Phase A). Columns map 1:1 onto the adapter config. */
export interface Repo {
  id: number;
  repoRef: string;
  cloneUrl: string | null;
  localRepo: string | null;
  workingRoot: string;
  baseBranch: string;
  /** Continuous mode (Milestone 11): when true the Issue Intake Poller auto-picks this repo's eligible
   *  open issues. Off unless explicitly enabled — enrolling a repo doesn't imply watching it. */
  watch: boolean;
  /** The label that bypasses the intake eligibility guards (issue #3); `null` → the default `agent help
   *  wanted`. Only meaningful while {@link watch} is on. */
  watchLabel: string | null;
  /** Working-directory source binding (Milestone 12): `null` = unconfigured (runs blocked until a
   *  directory is chosen), `'clone'` = clone a fresh per-run tree from the GitHub remote, `'local'` =
   *  use {@link localRepo} as a validated local checkout via `git worktree`. */
  sourceMode: RepoSourceMode | null;
  /** What a run does when merging the latest base into its branch conflicts (the between-stage base
   *  sync): `'manual'` = park the run `needs_human` for the operator; `'auto'` = a harness invocation
   *  resolves the conflicts (mechanically verified) before any escalation. Default `'manual'`. */
  conflictPolicy: ConflictPolicy;
  /** Continuous mode scope filter (issue #11): only consider open issues carrying this label.
   *  `null` = no label filter. Distinct from {@link watchLabel} (the guard-bypass override); this
   *  *scopes* the backlog rather than bypassing the guards. Only meaningful while {@link watch} is on. */
  watchFilterLabel: string | null;
  /** Continuous mode scope filter (issue #11): only consider open issues in this milestone.
   *  `null` = no milestone filter. Only meaningful while {@link watch} is on. */
  watchFilterMilestone: string | null;
  createdAt: string;
}

/** How a repo's per-run working tree is sourced ({@link Repo.sourceMode}). */
export type RepoSourceMode = 'clone' | 'local';

/** Merge-conflict handling for a repo's runs ({@link Repo.conflictPolicy}). */
export type ConflictPolicy = 'manual' | 'auto';

export interface UpsertRepoInput {
  repoRef: string;
  workingRoot: string;
  /** Defaults to `main` when omitted. */
  baseBranch?: string;
  cloneUrl?: string | null;
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

export interface LogRecord {
  id: number;
  runId: number | null;
  level: string;
  message: string;
  data: unknown;
  createdAt: string;
}

/**
 * The state of a side-effect ledger slot (the transactional outbox, README Milestone 7), returned by
 * {@link Repository.beginSideEffect}:
 *  - `fresh`   — no row existed; this caller just claimed it and must perform the external call.
 *  - `done`    — a prior attempt completed it; reuse `result`, do NOT call the external service again.
 *  - `pending` — a prior attempt claimed but never completed it (a crash mid-call): the call may or
 *                may not have applied, so the caller must escalate rather than blindly retry.
 */
export type SideEffectClaim =
  | { state: 'fresh' }
  | { state: 'pending' }
  | { state: 'done'; result: unknown };

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
  archived_at: string | null;
  cost_override: CostOverride | null;
  model_override: string | null;
  effort_override: string | null;
  harness: string;
  depends_on: string;
  priority: number;
  order_key: string;
  deps_satisfied_at: string | null;
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

interface ChatRow {
  id: number;
  run_id: number;
  prompt: string;
  mode: ChatMode;
  status: ChatStatus;
  response: string | null;
  error: string | null;
  commit_sha: string | null;
  tokens: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface AdviceRow {
  id: number;
  run_id: number;
  summary: string;
  options: string;
  tokens: number;
  created_at: string;
}

interface RepoRow {
  id: number;
  repo_ref: string;
  clone_url: string | null;
  local_repo: string | null;
  working_root: string;
  base_branch: string;
  watch: number;
  watch_label: string | null;
  source_mode: RepoSourceMode | null;
  conflict_policy: ConflictPolicy;
  watch_filter_label: string | null;
  watch_filter_milestone: string | null;
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
    archivedAt: r.archived_at,
    costOverride: r.cost_override,
    modelOverride: r.model_override,
    effortOverride: r.effort_override,
    harness: r.harness,
    dependsOn: JSON.parse(r.depends_on) as number[],
    priority: r.priority,
    orderKey: r.order_key,
    depsSatisfiedAt: r.deps_satisfied_at,
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

function mapChat(r: ChatRow): ChatExchange {
  return {
    id: r.id,
    runId: r.run_id,
    prompt: r.prompt,
    mode: r.mode,
    status: r.status,
    response: r.response,
    error: r.error,
    commitSha: r.commit_sha,
    tokens: r.tokens,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function mapAdvice(r: AdviceRow): Advice {
  return {
    id: r.id,
    runId: r.run_id,
    summary: r.summary,
    options: JSON.parse(r.options) as AdviceOption[],
    tokens: r.tokens,
    createdAt: r.created_at,
  };
}

function mapRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    repoRef: r.repo_ref,
    cloneUrl: r.clone_url,
    localRepo: r.local_repo,
    workingRoot: r.working_root,
    baseBranch: r.base_branch,
    watch: r.watch !== 0,
    watchLabel: r.watch_label,
    sourceMode: r.source_mode,
    conflictPolicy: r.conflict_policy,
    watchFilterLabel: r.watch_filter_label,
    watchFilterMilestone: r.watch_filter_milestone,
    createdAt: r.created_at,
  };
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

  // --- repos (Milestone 8 Phase A) ---------------------------------------------

  /**
   * Enroll a repo (or update an already-enrolled one), keyed on `repo_ref`. Idempotent on purpose so
   * the daemon can re-enroll its bound repo on every boot and the `POST /repos` command can be retried
   * safely. The conflict update re-points the adapter config (working root, base, remote) to the latest
   * values but deliberately does **not** touch `source_mode`/`local_repo` (owned by {@link setRepoSource})
   * or the watch columns — so a re-enroll can never silently reset a repo's chosen working directory or
   * its continuous-mode opt-in (Milestone 12, mirroring the watch-column carve-out).
   */
  upsertRepo(input: UpsertRepoInput): Repo {
    this.db
      .prepare(
        `INSERT INTO repos (repo_ref, clone_url, working_root, base_branch)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_ref) DO UPDATE SET
           clone_url = excluded.clone_url,
           working_root = excluded.working_root,
           base_branch = excluded.base_branch`,
      )
      .run(input.repoRef, input.cloneUrl ?? null, input.workingRoot, input.baseBranch ?? 'main');
    const repo = this.getRepo(input.repoRef);
    if (!repo) throw new Error('upsertRepo: row vanished immediately after insert');
    return repo;
  }

  /**
   * Bind (or clear) a repo's working-directory source (Milestone 12), independent of its adapter config —
   * so a re-enroll (`upsertRepo`, which never touches these columns) can't reset the operator's choice.
   * `'clone'` clears `local_repo` (a fresh per-run tree is cloned from the GitHub remote); `'local'` stores
   * the validated checkout path used for `git worktree`; `null` returns the repo to unconfigured (clearing
   * the path). No-op on an unenrolled repo (0 rows updated).
   */
  setRepoSource(repoRef: string, mode: RepoSourceMode | null, localRepo: string | null): void {
    this.db
      .prepare('UPDATE repos SET source_mode = ?, local_repo = ? WHERE repo_ref = ? COLLATE NOCASE')
      .run(mode, mode === 'local' ? localRepo : null, repoRef);
  }

  /** Look up an enrolled repo by its canonical `owner/name` ref (case-insensitive). */
  getRepo(repoRef: string): Repo | undefined {
    const row = this.db
      .prepare('SELECT * FROM repos WHERE repo_ref = ? COLLATE NOCASE')
      .get(repoRef) as RepoRow | undefined;
    return row ? mapRepo(row) : undefined;
  }

  /** Every enrolled repo, oldest first (enrollment order — stable for the dashboard's repo selector). */
  listRepos(): Repo[] {
    const rows = this.db.prepare('SELECT * FROM repos ORDER BY id ASC').all() as RepoRow[];
    return rows.map(mapRepo);
  }

  /**
   * Turn continuous mode on/off for a repo (Milestone 11), independent of its adapter config — so a
   * re-enroll (`upsertRepo`, which never touches these columns) can't accidentally reset the watch. When
   * `label` is omitted the override label is left as-is; pass `null` to reset it to the default, or a
   * string to set a custom one. No-op on an unenrolled repo (0 rows updated).
   */
  /** Set a repo's merge-conflict policy ({@link Repo.conflictPolicy}). Persisted independently of
   *  enrollment, like watch/source: a re-enroll (`upsertRepo`) never resets the operator's choice. */
  setRepoConflictPolicy(repoRef: string, policy: ConflictPolicy): void {
    this.db.prepare('UPDATE repos SET conflict_policy = ? WHERE repo_ref = ? COLLATE NOCASE').run(policy, repoRef);
  }

  /**
   * Turn continuous mode on/off, and optionally set the override label and/or the scope filter columns
   * (issue #11), in one write. Each optional column follows the same convention: **key absent → leave
   * the column as-is; `null` → clear it; a string → set it**. `watch` is always written. The scope
   * filter (`watch_filter_label`/`watch_filter_milestone`) *narrows* which issues intake considers —
   * distinct from `watch_label`, the guard-bypass override. The SET-list is built dynamically from which
   * of the optional columns are present, so a plain toggle (`setRepoWatch(ref, watch)`) never clobbers a
   * previously-set label or filter. No-op on an unenrolled repo (0 rows updated).
   */
  setRepoWatch(
    repoRef: string,
    watch: boolean,
    label?: string | null,
    filter?: { filterLabel?: string | null; filterMilestone?: string | null },
  ): void {
    const sets = ['watch = ?'];
    const params: Array<string | number | null> = [watch ? 1 : 0];
    if (label !== undefined) {
      sets.push('watch_label = ?');
      params.push(label);
    }
    if (filter?.filterLabel !== undefined) {
      sets.push('watch_filter_label = ?');
      params.push(filter.filterLabel);
    }
    if (filter?.filterMilestone !== undefined) {
      sets.push('watch_filter_milestone = ?');
      params.push(filter.filterMilestone);
    }
    params.push(repoRef);
    this.db.prepare(`UPDATE repos SET ${sets.join(', ')} WHERE repo_ref = ? COLLATE NOCASE`).run(...params);
  }

  // --- settings (a tiny key/value store) ---------------------------------------

  /** Read a daemon setting by key (e.g. `default_harness`), or `undefined` if it was never set. */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Set (upsert) a daemon setting, or clear it with `null` (deletes the row, so {@link getSetting}
   *  reads back `undefined`) — e.g. the persisted default harness/model/effort the dashboard writes. */
  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // --- runs --------------------------------------------------------------------

  createRun(input: CreateRunInput): Run {
    // `harness` is COALESCEd so an omitted one lands on the column default ('claude-code') — one source
    // of truth for the default, and forward-ready for per-run harness selection.
    const info = this.db
      .prepare(
        `INSERT INTO runs (issue_ref, repo_ref, current_state, status, fsm_config_version, harness, model_override, effort_override)
         VALUES (?, ?, ?, 'running', ?, COALESCE(?, 'claude-code'), ?, ?)`,
      )
      .run(input.issueRef, input.repoRef, input.initialState, input.fsmConfigVersion, input.harness ?? null, input.model ?? null, input.effort ?? null);
    const run = this.getRun(Number(info.lastInsertRowid));
    if (!run) throw new Error('createRun: row vanished immediately after insert');
    return run;
  }

  getRun(id: number): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  /**
   * Runs, newest first. The event loop is driven by the `events` queue, not by scanning runs; this
   * exists for the CLI/dashboard (list runs) and for operational queries. Pass `status` and/or `repo`
   * to filter (e.g. `needs_human` runs awaiting an operator, or every run in one repo — Milestone 8).
   */
  listRuns(filter: ListRunsFilter = {}): Run[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.repo) {
      where.push('repo_ref = ? COLLATE NOCASE');
      params.push(filter.repo);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM runs${clause} ORDER BY id DESC`).all(...params) as RunRow[];
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

  /**
   * Retarget the run to a different issue. Used when `triage` splits a too-large issue and hands
   * this run off to continue on one of the smaller children (README §0 triage): from here on the run
   * reads and closes that child issue. Only safe before any branch/PR exists (i.e. still in triage),
   * which is the only place that calls it. The cached scheduling resets to defaults with it — the
   * old issue's declarations don't apply to the child; the Scheduler Poller re-reads the child's
   * own marker block on its next tick (M9 plan §3.4).
   */
  setRunIssueRef(id: number, issueRef: string): void {
    this.db
      .prepare(
        `UPDATE runs SET issue_ref = ?, depends_on = '[]', priority = 0, order_key = '',
                deps_satisfied_at = NULL, updated_at = ${NOW} WHERE id = ?`,
      )
      .run(issueRef, id);
  }

  /**
   * Refresh the run's cached §3.5 scheduling declarations (M9). `depends_on` is stored canonically
   * (sorted-unique JSON) so the claim's `= '[]'` no-deps test is reliable. The satisfaction latch
   * (`deps_satisfied_at`) is **cleared when the dependency set changes** — a human adding a dep to a
   * satisfied run re-blocks it until the Scheduler Poller re-verifies — and kept when it doesn't, all
   * in one atomic statement so a concurrent claim never sees a changed set with a stale latch.
   */
  setRunScheduling(id: number, scheduling: RunScheduling): void {
    const deps = JSON.stringify([...new Set(scheduling.dependsOn)].sort((a, b) => a - b));
    this.db
      .prepare(
        `UPDATE runs SET
           deps_satisfied_at = CASE WHEN depends_on = ? THEN deps_satisfied_at ELSE NULL END,
           depends_on = ?, priority = ?, order_key = ?, updated_at = ${NOW}
         WHERE id = ?`,
      )
      .run(deps, deps, Math.trunc(scheduling.priority), scheduling.orderKey, id);
  }

  /**
   * Stamp the dependency-satisfaction latch (M9): the Scheduler Poller verified every `dependsOn`
   * issue closed. From here the run is dispatchable until the declaration changes (which clears the
   * stamp — see {@link setRunScheduling}); satisfaction is never re-checked otherwise, because a
   * merged/closed dependency stays merged/closed.
   */
  stampDepsSatisfied(id: number): void {
    this.db.prepare(`UPDATE runs SET deps_satisfied_at = ${NOW}, updated_at = ${NOW} WHERE id = ?`).run(id);
  }

  /**
   * The newest **active** (non-terminal, non-archived) run for an issue, if any — the duplicate-run
   * guard `Orchestrator.start` consults (M9): two concurrent runs on one issue would fight over the
   * branch and the marker block. Case-insensitive on the ref's repo half, matching the repo lookups.
   */
  findActiveRunByIssue(issueRef: string): Run | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs
         WHERE issue_ref = ? COLLATE NOCASE AND status NOT IN ('done', 'stopped') AND archived_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(issueRef) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  /** Record the PR number, set when `tdd` opens the PR — separate from the branch, which exists earlier. */
  setRunPr(id: number, prNumber: number): void {
    this.db.prepare(`UPDATE runs SET pr_number = ?, updated_at = ${NOW} WHERE id = ?`).run(prNumber, id);
  }

  /** Archive (stamp `archived_at`) or unarchive (clear it) a run — the dashboard's Resolved-lane tidy-up. */
  setRunArchived(id: number, archived: boolean): void {
    const value = archived ? `${NOW}` : 'NULL';
    this.db.prepare(`UPDATE runs SET archived_at = ${value}, updated_at = ${NOW} WHERE id = ?`).run(id);
  }

  /** Set (or clear, with `null`) a run's cost-ceiling override (M8 B3). See {@link CostOverride}. */
  setCostOverride(id: number, mode: CostOverride | null): void {
    this.db.prepare(`UPDATE runs SET cost_override = ?, updated_at = ${NOW} WHERE id = ?`).run(mode, id);
  }

  /**
   * Set (or clear, with `null`) a run's harness model override — the dashboard's model dropdown. The
   * runner reads it fresh at each stage, so a change takes effect on the run's next stage (the current
   * stage keeps the model it started with).
   */
  setRunModelOverride(id: number, model: string | null): void {
    this.db.prepare(`UPDATE runs SET model_override = ?, updated_at = ${NOW} WHERE id = ?`).run(model, id);
  }

  /**
   * Set (or clear, with `null`) a run's reasoning-effort override (Claude Code's `--effort`). Like the
   * model override, the runner reads it fresh at each stage, so a change takes effect on the next stage.
   */
  setRunEffortOverride(id: number, effort: string | null): void {
    this.db.prepare(`UPDATE runs SET effort_override = ?, updated_at = ${NOW} WHERE id = ?`).run(effort, id);
  }

  /**
   * Re-point a run at another harness (the dashboard's per-run harness selector). Like the model
   * override, the loop loads the run fresh for each stage dispatch, so a change takes effect on the
   * run's next stage — an in-flight stage finishes on the executor it started with.
   */
  setRunHarness(id: number, harness: string): void {
    this.db.prepare(`UPDATE runs SET harness = ?, updated_at = ${NOW} WHERE id = ?`).run(harness, id);
  }

  /**
   * Total `cost_used` across **active** (non-terminal) runs — the input to the global cost ceiling
   * (M8 B3). Terminal runs (`done`/`stopped`) are excluded, so finishing/stopping a run frees ceiling
   * headroom. Returns 0 when there are no active runs.
   */
  sumActiveCost(): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_used), 0) AS total FROM runs WHERE status NOT IN ('done', 'stopped')`)
      .get() as { total: number };
    return row.total;
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

  /**
   * How many times this run has transitioned *into* `state` — the "visit index" the side-effect
   * ledger keys on (README Milestone 7). It is stable while a stage runs (the stage's own outgoing
   * transition has not committed yet), so a crash/replay of the same visit computes the same key and
   * reuses the ledger; a legitimate re-entry (a back-edge or an operator resume into the state) adds a
   * transition, so the next visit gets fresh keys and performs its side effects anew.
   */
  stateVisitCount(runId: number, state: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM transitions WHERE run_id = ? AND to_state = ?')
      .get(runId, state) as { n: number };
    return row.n;
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
   *
   * Within-run serialization (Milestone 8 Phase B): the `NOT EXISTS … status =
   * 'processing'` guard skips any run that already has a stage in flight, so under the
   * worker pool the loop is **parallel across runs but serial within a run** — two
   * stages of one run never overlap (they share a working tree and a state cursor).
   * A run's follow-up event is enqueued inside the stage's commit transaction, before
   * `markEventDone`, so this guard holds it back until the in-flight stage finalizes.
   * Same predicate as {@link hasProcessingEvent}, enforced atomically at pickup.
   *
   * Cost-ceiling gate (M8 B3): when `onlyOverrides` is set (the loop is over the global cost ceiling),
   * only a run carrying a `cost_override` is dispatchable — every other run parks until the aggregate
   * clears or an operator overrides it. Off by default, so the ungated claim is unchanged.
   *
   * Chat mutual exclusion: a run with a `write`-mode chat exchange mid-flight is not dispatchable —
   * the chat agent is editing the run's working tree, and a stage starting under it would race the
   * same tree (the mirror of {@link claimNextChatExchange}'s no-stage-in-flight predicate). Enforced
   * here, inside the one atomic claim, so a `resume` landing while a chat works simply parks the
   * pending event until the chat finishes (the Orchestrator re-kicks the pump then).
   *
   * Dependency gate + dispatch order (Milestone 9 — the Scheduler slotting into this same point, as
   * promised above): a run with cached unsatisfied dependencies (`depends_on` non-empty and the
   * satisfaction latch unstamped) is never claimable — the correctness gate lives *here*, inside the
   * one atomic statement, so it is airtight under the worker pool regardless of whether the Scheduler
   * Poller has flipped the run's visible status to `blocked` yet. Among dispatchable runs, pickup
   * follows the Scheduler's total order — `priority` desc, `order_key` asc (BINARY collation, matching
   * `compareRuns`'s UTF-8 byte compare), issue number asc (computed from the canonical
   * `owner/repo#N` ref, never cached — a split handoff retarget can't leave it stale) — then event id
   * as the final FIFO tiebreaker. `compareRuns` (loop/scheduler.ts) is the single source of truth for
   * that order; a cross-check test keeps this SQL from drifting.
   */
  claimNextEvent(opts: { onlyOverrides?: boolean } = {}): EventRow | undefined {
    const costGate = opts.onlyOverrides ? 'AND runs.cost_override IS NOT NULL' : '';
    const row = this.db
      .prepare(
        `UPDATE events SET status = 'processing'
         WHERE id = (
           SELECT events.id FROM events
           JOIN runs ON runs.id = events.run_id
           WHERE events.status = 'pending' AND runs.status = 'running'
             AND (runs.depends_on = '[]' OR runs.deps_satisfied_at IS NOT NULL)
             AND NOT EXISTS (
               SELECT 1 FROM events p WHERE p.run_id = events.run_id AND p.status = 'processing'
             )
             AND NOT EXISTS (
               SELECT 1 FROM run_chat c WHERE c.run_id = events.run_id AND c.status = 'running' AND c.mode = 'write'
             )
             ${costGate}
           ORDER BY runs.priority DESC,
                    runs.order_key ASC,
                    CAST(substr(runs.issue_ref, instr(runs.issue_ref, '#') + 1) AS INTEGER) ASC,
                    events.id ASC
           LIMIT 1
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
   * Whether the run has an event mid-flight (`processing`) — i.e. a stage is currently executing for
   * it. An operator state-mutation that would race that stage's commit (e.g. `revert`) checks this
   * first and refuses, since the serial loop will clobber whichever of the two writes lands second.
   */
  hasProcessingEvent(runId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM events WHERE run_id = ? AND status = 'processing' LIMIT 1")
      .get(runId);
    return row !== undefined;
  }

  /**
   * Cancel a run's not-yet-claimed events by finalizing them (`pending` → `done`), so the claim never
   * picks them up. Used by an operator `revert` (Layer 6): a reverted run gets a single fresh advance
   * event, never a stale follow-up left over from the state it was parked in. Returns how many were
   * cancelled. Only `pending` rows are touched — an in-flight (`processing`) event is left to finish.
   */
  discardPendingEvents(runId: number): number {
    const info = this.db
      .prepare(`UPDATE events SET status = 'done', processed_at = ${NOW} WHERE run_id = ? AND status = 'pending'`)
      .run(runId);
    return info.changes;
  }

  /**
   * The run ids whose event is stranded `processing` — after a graceful shutdown's drain settles,
   * these are exactly the runs whose in-flight stage was interrupted (a finished stage marks its
   * event done; an unstarted one is still `pending`). The Orchestrator savepoints their working
   * trees before exit; `recoverProcessingEvents` re-queues them on the next start.
   */
  listProcessingRunIds(): number[] {
    const rows = this.db.prepare("SELECT DISTINCT run_id FROM events WHERE status = 'processing'").all() as Array<{ run_id: number }>;
    return rows.map((r) => r.run_id);
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

  // --- run chat (the per-run operator ↔ agent side channel) ---------------------

  /** Enqueue a chat prompt on a run. Every exchange starts `queued`; the chat pump claims it when
   *  its mode's safety conditions hold (see {@link claimNextChatExchange}). */
  createChatExchange(input: { runId: number; prompt: string; mode: ChatMode }): ChatExchange {
    const info = this.db
      .prepare(`INSERT INTO run_chat (run_id, prompt, mode) VALUES (?, ?, ?)`)
      .run(input.runId, input.prompt, input.mode);
    return this.getChatExchange(Number(info.lastInsertRowid))!;
  }

  getChatExchange(id: number): ChatExchange | undefined {
    const row = this.db.prepare('SELECT * FROM run_chat WHERE id = ?').get(id) as ChatRow | undefined;
    return row ? mapChat(row) : undefined;
  }

  /** A run's chat exchanges, oldest first (the thread the dashboard renders). */
  listChatExchanges(runId: number): ChatExchange[] {
    const rows = this.db.prepare('SELECT * FROM run_chat WHERE run_id = ? ORDER BY id ASC').all(runId) as ChatRow[];
    return rows.map(mapChat);
  }

  /**
   * Atomically claim the oldest chat exchange that is **safe to run right now**, marking it
   * `running`, or return undefined if none. One statement, like {@link claimNextEvent}, so the
   * permission gate can never race a status change:
   *
   *  - One chat at a time per run (any mode) — the thread stays coherent and two chat agents never
   *    share a working tree.
   *  - `read` exchanges are always claimable: read-only tools cannot disturb an in-flight stage.
   *  - `write` exchanges are claimable only while the run is parked in a paused-like status
   *    ({@link CHAT_WRITE_SAFE_STATUSES}) **and** no stage event is `processing` — the exact mirror
   *    of the claim gate that then refuses to dispatch a stage while this exchange runs.
   */
  claimNextChatExchange(): ChatExchange | undefined {
    const writeSafe = CHAT_WRITE_SAFE_STATUSES.map((s) => `'${s}'`).join(', ');
    const row = this.db
      .prepare(
        `UPDATE run_chat SET status = 'running', started_at = ${NOW}
         WHERE id = (
           SELECT c.id FROM run_chat c
           JOIN runs ON runs.id = c.run_id
           WHERE c.status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM run_chat r WHERE r.run_id = c.run_id AND r.status = 'running')
             AND (
               c.mode = 'read'
               OR (
                 runs.status IN (${writeSafe})
                 AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = c.run_id AND e.status = 'processing')
               )
             )
           ORDER BY c.id ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get() as ChatRow | undefined;
    return row ? mapChat(row) : undefined;
  }

  /** Record a claimed exchange's reply (and usage / pushed commit) and mark it `done`. */
  completeChatExchange(id: number, result: { response: string; tokens?: number; commitSha?: string | null }): void {
    this.db
      .prepare(`UPDATE run_chat SET status = 'done', response = ?, tokens = ?, commit_sha = ?, finished_at = ${NOW} WHERE id = ?`)
      .run(result.response, result.tokens ?? 0, result.commitSha ?? null, id);
  }

  /** Mark a claimed exchange failed, with the cause the dashboard shows. */
  failChatExchange(id: number, error: string): void {
    this.db.prepare(`UPDATE run_chat SET status = 'error', error = ?, finished_at = ${NOW} WHERE id = ?`).run(error, id);
  }

  /** Cancel a still-`queued` exchange (an operator withdrawal). Returns false when it was already
   *  claimed/finished — a running agent cannot be recalled, so only a parked prompt is cancellable. */
  cancelChatExchange(id: number): boolean {
    const info = this.db
      .prepare(`UPDATE run_chat SET status = 'cancelled', finished_at = ${NOW} WHERE id = ? AND status = 'queued'`)
      .run(id);
    return info.changes === 1;
  }

  /**
   * Re-queue chat exchanges stranded `running` by a crash/shutdown, mirroring
   * {@link recoverProcessingEvents}: on the next start they are claimed and re-run from scratch —
   * safe because a chat's side effects (tree edits + commit-if-dirty + push) are idempotent the same
   * way a stage's are. Returns the number re-queued.
   */
  recoverRunningChats(): number {
    const info = this.db
      .prepare(`UPDATE run_chat SET status = 'queued', started_at = NULL WHERE status = 'running'`)
      .run();
    return info.changes;
  }

  // --- run advice (the escalation-resolution advisor, Layer 3) -------------------

  /** Insert one advisor result; returns the stored row (options round-tripped through JSON). */
  insertAdvice(input: { runId: number; summary: string; options: AdviceOption[]; tokens: number }): Advice {
    const info = this.db
      .prepare(`INSERT INTO run_advice (run_id, summary, options, tokens) VALUES (?, ?, ?, ?)`)
      .run(input.runId, input.summary, JSON.stringify(input.options), input.tokens);
    const row = this.db.prepare('SELECT * FROM run_advice WHERE id = ?').get(Number(info.lastInsertRowid)) as AdviceRow;
    return mapAdvice(row);
  }

  /** The most recent advisor result for a run, or undefined if none. Powers `getRunDetail.advice` so a
   *  page reload keeps the last advice. */
  getLatestAdvice(runId: number): Advice | undefined {
    const row = this.db.prepare('SELECT * FROM run_advice WHERE run_id = ? ORDER BY id DESC LIMIT 1').get(runId) as AdviceRow | undefined;
    return row ? mapAdvice(row) : undefined;
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

  // --- logs (the live activity stream) -----------------------------------------

  /**
   * Append a structured log line for a run — the durable backing of the live "what is the agent
   * doing right now" stream (README §3.3 Layer 6 / schema `logs`). The Agent Runner writes one per
   * streamed agent activity, so the dashboard can replay a run's progress and the API (M5) can tail
   * it live. Cheap and append-only; never on the critical path of a transition.
   */
  recordLog(input: { runId?: number | null; level?: string; message: string; data?: unknown }): number {
    const info = this.db
      .prepare('INSERT INTO logs (run_id, level, message, data) VALUES (?, ?, ?, ?)')
      .run(input.runId ?? null, input.level ?? 'info', input.message, toJson(input.data));
    return Number(info.lastInsertRowid);
  }

  /** A run's log lines, oldest first (the per-run activity feed). */
  listLogs(runId: number): LogRecord[] {
    const rows = this.db
      .prepare('SELECT id, run_id, level, message, data, created_at FROM logs WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as Array<{ id: number; run_id: number | null; level: string; message: string; data: string | null; created_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      level: r.level,
      message: r.message,
      data: parseJson(r.data),
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

  // --- side-effect ledger (the transactional outbox, README Milestone 7) --------

  /**
   * Claim a side-effect slot before performing a non-idempotent external call. Atomic via the
   * `(run_id, key)` unique index: the `INSERT OR IGNORE` either inserts (this caller wins → `fresh`)
   * or is ignored, in which case we read the existing row's state (`done` reuses its result, `pending`
   * is the ambiguous partial-application case). See {@link SideEffectClaim} and `completeSideEffect`.
   */
  beginSideEffect(runId: number, key: string): SideEffectClaim {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO side_effects (run_id, key, status) VALUES (?, ?, 'pending')")
      .run(runId, key);
    if (info.changes === 1) return { state: 'fresh' };
    const row = this.db
      .prepare('SELECT status, result FROM side_effects WHERE run_id = ? AND key = ?')
      .get(runId, key) as { status: 'pending' | 'done'; result: string | null };
    return row.status === 'done' ? { state: 'done', result: parseJson(row.result) } : { state: 'pending' };
  }

  /**
   * Mark a claimed slot `done` and store the external call's result, so a later replay of the same
   * visit reuses it instead of calling out again. Paired with {@link beginSideEffect}; the two are
   * separate autocommitted writes (the outbox is deliberately outside the transition transaction).
   */
  completeSideEffect(runId: number, key: string, result: unknown): void {
    this.db
      .prepare("UPDATE side_effects SET status = 'done', result = ? WHERE run_id = ? AND key = ?")
      .run(toJson(result), runId, key);
  }
}
