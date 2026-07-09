-- State Store schema (Layer 1 — see README §3.3).
-- SQLite is the source of truth for runtime control-plane state. Artifacts live in
-- the repo / PR / issue; this store only references them.

PRAGMA foreign_keys = ON;

-- One row per task/issue being processed.
CREATE TABLE IF NOT EXISTS runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_ref          TEXT    NOT NULL,
  repo_ref           TEXT    NOT NULL,                 -- one repo in the MVP; per-run for multi-repo (README M8)
  current_state      TEXT    NOT NULL,
  status             TEXT    NOT NULL
                       CHECK (status IN ('running', 'paused', 'blocked', 'awaiting_input', 'done', 'needs_human', 'stopped')),
                       -- awaiting_input: parked after triage asked the human a question on the issue;
                       -- the reply poller re-arms it (→ running) when a human replies (see Reply Poller).
                       -- stopped: ended by an operator `stop` command — terminal, not resumable (README §3.3 Layer 6).
  fsm_config_version TEXT    NOT NULL,                 -- pins the config version for the run's lifetime
  pr_number          INTEGER,
  branch             TEXT,
  tokens_used        INTEGER NOT NULL DEFAULT 0,       -- cumulative, for the run-budget guard
  cost_used          REAL    NOT NULL DEFAULT 0,
  agent_runs_count   INTEGER NOT NULL DEFAULT 0,
  flags              TEXT    NOT NULL DEFAULT '{}',     -- JSON skip flags (needs_frontend/…), set by `plan`, read on every FORWARD
  archived_at        TEXT,                              -- when an operator archived this (terminal) run out of the dashboard's Resolved lane; NULL = not archived
  cost_override      TEXT,                              -- operator override of the global cost ceiling (M8 B3): 'next_step' (one stage) | 'full' (whole run) | NULL (none)
  model_override     TEXT,                              -- per-run harness model override (the dashboard's model picker); NULL = use the daemon default. Read by the runner at each stage.
  effort_override    TEXT,                              -- per-run reasoning-effort override (Claude Code's --effort): 'low'|'medium'|'high'|'xhigh'|'max' | NULL (model default). App-validated; read by the runner at each stage.
  harness            TEXT    NOT NULL DEFAULT 'claude-code', -- which agent harness runs this, pinned at start (like fsm_config_version). No CHECK: the valid set is app-validated (isHarnessId) and ALTER can't add a CHECK later — keeps a fresh DB identical to a migrated one.
  -- Scheduling declarations (Milestone 9), CACHED from the issue's §3.5 marker block — the issue owns
  -- them (the runner caches at triage-commit; the Scheduler Poller refreshes every tick; on conflict
  -- the issue wins). `depends_on` is canonical JSON (sorted-unique ints) so `= '[]'` is a reliable
  -- "no deps" test in the claim's dispatch gate. `deps_satisfied_at` is the satisfaction latch: NULL
  -- until every dependency's issue is closed, then stamped (and cleared again if the declaration
  -- changes). The claim dispatches a run only when depends_on = '[]' OR the latch is stamped.
  depends_on         TEXT    NOT NULL DEFAULT '[]',
  priority           INTEGER NOT NULL DEFAULT 0,       -- higher dispatches first (claim ORDER BY)
  order_key          TEXT    NOT NULL DEFAULT '',      -- lexicographic tiebreaker after priority
  deps_satisfied_at  TEXT,                             -- the latch; NULL = unverified/unsatisfied
  issue_context      TEXT,                              -- per-run (Layer 3) operator context prompt (agents-fsm#5); NULL = none. Read by the runner at each stage; composed global→stage→issue into the system prompt.
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The event queue/log that drives handoffs. `status` + a unique id make
-- at-least-once processing idempotent (README §3.3 Layer 3). Defined before
-- `transitions` because that table's `event_id` foreign key references it.
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       INTEGER NOT NULL REFERENCES runs(id),
  type         TEXT    NOT NULL,
  payload      TEXT,                                   -- JSON
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'done')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT
);

-- Append-only audit trail. Round counters are DERIVED from this log, not stored
-- as mutable fields (README §3.3 Layer 1): count back_edge rows per counter_key
-- since the most recent reset.
CREATE TABLE IF NOT EXISTS transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  from_state  TEXT    NOT NULL,
  to_state    TEXT    NOT NULL,
  trigger     TEXT    NOT NULL,
  reason      TEXT,                                    -- JSON payload (README §2 reversion reason)
  back_edge   INTEGER NOT NULL DEFAULT 0,
  counter_key TEXT,                                    -- which round counter this advanced, if any
  is_reset    INTEGER NOT NULL DEFAULT 0,              -- a counter reset marker (resume from needs_human)
  event_id    INTEGER REFERENCES events(id),          -- the event that caused this; NULL for manual transitions/resets
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One transition per event: makes transition application idempotent under
-- at-least-once delivery (README §3.3 Layer 3). NULL event_ids are unconstrained
-- (SQLite treats NULLs as distinct), so manual transitions and resets are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transitions_event ON transitions(event_id) WHERE event_id IS NOT NULL;

-- One row per agent invocation. A single stage produces several rows (one per
-- phase/loop iteration), enabling per-phase telemetry (README §3.3 Layer 4).
CREATE TABLE IF NOT EXISTS agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  stage       TEXT    NOT NULL,
  phase       TEXT    NOT NULL CHECK (phase IN ('produce', 'self_review', 'simplify')),
  model       TEXT,
  input       TEXT,                                    -- JSON
  output      TEXT,                                    -- JSON
  tokens      INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  success     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- References (not content) to durable artifacts living in the repo / PR / issue.
CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  kind       TEXT    NOT NULL,                         -- plan / interface / pr / review
  locator    TEXT    NOT NULL,                         -- JSON locator (branch+path+sha, or pr/issue/comment id)
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Structured records the dashboard subscribes to.
CREATE TABLE IF NOT EXISTS telemetry (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER REFERENCES runs(id),
  kind       TEXT    NOT NULL,
  data       TEXT,                                     -- JSON
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER REFERENCES runs(id),
  level      TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  data       TEXT,                                     -- JSON
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Idempotency ledger / transactional outbox for non-idempotent external side effects
-- (posting issue/PR comments, creating sub-issues — README §3.3 risk register / Milestone 7).
-- The runner claims a row ('pending') before a GitHub call and completes it ('done' + result)
-- after, keyed by a deterministic `${state}#${visit}:${slot}` slot. On a crash/replay it reuses a
-- `done` row's result instead of re-calling GitHub (no duplicate comment/sub-issue); a `pending`
-- row means a previous attempt may have partly applied, so the run escalates rather than retrying.
CREATE TABLE IF NOT EXISTS side_effects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  key        TEXT    NOT NULL,                       -- `${state}#${visit}:${slot}`, unique per run
  status     TEXT    NOT NULL CHECK (status IN ('pending', 'done')),
  result     TEXT,                                   -- JSON result of the external call; NULL while pending
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- One ledger row per (run, slot): makes the claim atomic (INSERT OR IGNORE relies on this index).
CREATE UNIQUE INDEX IF NOT EXISTS idx_side_effects_key ON side_effects(run_id, key);

-- Enrolled repositories (Milestone 8 Phase A — README §5). One row per repo the fleet can run.
-- `runs.repo_ref` references `repos.repo_ref` (enforced in the application layer, not a SQL FK:
-- `repo_ref` is a string key and SQLite cannot add a FK to the existing `runs` table without a full
-- rebuild, which buys no safety here). The columns map 1:1 onto the Git/GitHub adapter's config, so
-- the per-repo adapter resolver builds a `GitHubCli` straight from a row. Secrets stay env-only — no
-- token column in the MVP (per-repo secrets are Milestone 8 Phase B).
CREATE TABLE IF NOT EXISTS repos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- COLLATE NOCASE: GitHub repo refs are case-insensitive and `parseRepoRef` preserves casing, so the
  -- uniqueness + `ON CONFLICT(repo_ref)` upsert must be case-insensitive too — else `--repo Acme/Web`
  -- and an issue URL's `acme/web` would enroll as two rows the case-insensitive lookups can't tell apart.
  repo_ref     TEXT    NOT NULL COLLATE NOCASE UNIQUE,  -- canonical `owner/name` (see integration/refs parseRepoRef)
  clone_url    TEXT,                               -- GitHub remote; NULL → derive https://github.com/<repo_ref>.git
  local_repo   TEXT,                               -- optional local checkout to clone working trees from (offline/fast)
  working_root TEXT    NOT NULL,                   -- where this repo's per-run trees clone (`<working_root>/run-<id>`)
  base_branch  TEXT    NOT NULL DEFAULT 'main',    -- branch PRs target / working trees branch off
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Continuous mode / repo auto-pickup (Milestone 11): when `watch` = 1 the Issue Intake Poller scans
  -- this repo's open issues and starts a run per eligible one (sequential, one in-flight at a time).
  -- Off by default — enrolling a repo makes it serviceable, watching it is a separate opt-in. Appended
  -- after `created_at` so a fresh schema matches a DB retrofitted by the additive migration (db drift guard).
  watch        INTEGER NOT NULL DEFAULT 0,         -- 1 = auto-pick eligible open issues; 0 = manual runs only
  watch_label  TEXT,                               -- label that bypasses the intake guards; NULL → default 'agent help wanted'
  -- Working-directory source binding (Milestone 12). The fleet must know where a repo lives before it can
  -- run: NULL = unconfigured (attached but no working directory chosen → runs blocked with an actionable
  -- error); 'clone' = clone a fresh per-run tree from the GitHub remote; 'local' = use `local_repo` as a
  -- validated local checkout via `git worktree` (isolated per-run tree, shared object store). Appended last
  -- so a fresh schema matches a DB retrofitted by the additive migration (db drift guard).
  source_mode  TEXT,                               -- NULL = unconfigured | 'clone' | 'local' (with local_repo set)
  -- Merge-conflict policy: what a run does when merging the latest base into its branch conflicts
  -- (the between-stage base sync). 'manual' = park the run needs_human for the operator; 'auto' = let a
  -- harness invocation resolve the conflicts (mechanically verified) before escalating. No CHECK — the
  -- valid set is app-validated (like runs.harness) so a fresh DB stays identical to a migrated one.
  -- Appended last so a fresh schema matches a DB retrofitted by the additive migration (db drift guard).
  conflict_policy TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'auto'
  -- Continuous mode scope filter (issue #11): narrow the watched backlog to a subset *before* the guards
  -- run. Distinct from `watch_label` (the guard-bypass override) — these *scope* which issues are
  -- considered at all. NULL = that dimension is unconstrained (behaviour unchanged — scan all open
  -- issues); both set = match all (AND). Appended last so a fresh schema matches a DB retrofitted by the
  -- additive migration (db drift guard).
  watch_filter_label     TEXT,   -- scope the watched backlog to this label (NULL = no label filter)
  watch_filter_milestone TEXT,   -- scope the watched backlog to this milestone (NULL = no milestone filter)
  -- Continuous mode configurable in-flight cap (agents-fsm#10): max runs a watched repo admits at once
  -- (parallel pickup). Default 1 = today's strictly-sequential behaviour. The pure decision clamps it to
  -- >= 1 and actual concurrency is still bounded by the drain pool's FLEET_CONCURRENCY. Appended last so a
  -- fresh schema matches a DB retrofitted by the additive migration (db drift guard).
  watch_in_flight_cap INTEGER NOT NULL DEFAULT 1,  -- max runs a watched repo admits at once (continuous mode); 1 = sequential
  -- Opt-in auto-merge (agents-fsm#15): when 1, a run reaching the terminal `done` state merges its own
  -- PR into base (never forced — a non-mergeable PR escalates instead). Gated on exactly the approved
  -- signal `done` already requires; no new approval gate. Appended last so a fresh schema matches a DB
  -- retrofitted by the additive migration (db drift guard).
  auto_merge INTEGER NOT NULL DEFAULT 0             -- 1 = merge the PR on approve; 0 = park merge-ready for a human
);

-- Per-run operator ↔ agent chat — the run's "general chat" side channel (singular name by convention
-- for new tables). One row per exchange: the operator's prompt plus the agent's eventual reply. `mode`
-- is the permission grant the operator chose: 'read' exchanges run immediately (read-only tools, safe
-- alongside an in-flight stage); 'write' exchanges queue until the run is parked in a paused-like
-- status with no stage in flight, then run with edit tools and commit+push their changes. While a
-- 'write' exchange is `running`, the event claim refuses to dispatch a stage for its run (the chat ⇄
-- stage mutual exclusion — see Repository.claimNextEvent / claimNextChatExchange).
CREATE TABLE IF NOT EXISTS run_chat (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  prompt      TEXT    NOT NULL,
  mode        TEXT    NOT NULL CHECK (mode IN ('read', 'write')),
  status      TEXT    NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
  response    TEXT,                                    -- the agent's reply (markdown), set when done
  error       TEXT,                                    -- why the exchange failed, set when status = 'error'
  commit_sha  TEXT,                                    -- write mode: the commit pushed after the agent worked
  tokens      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_chat_run ON run_chat(run_id, id);

-- Persisted escalation-resolution advice (Layer 3 — the dashboard's "Suggest resolutions" button).
-- One row per on-demand advisor invocation over a needs_human run; the latest is what the escalation
-- panel shows, so a page reload keeps the last suggestions. Advice is *content* (unlike artifacts,
-- which are references), so it lives in its own small table rather than the artifacts table.
CREATE TABLE IF NOT EXISTS run_advice (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id),
  summary    TEXT    NOT NULL,
  options    TEXT    NOT NULL,                       -- JSON-encoded AdviceOption[]
  tokens     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_run_advice_run ON run_advice(run_id, id);

-- A tiny key/value store for daemon-level settings that must survive restarts (multi-harness support).
-- One row today: `default_harness` — the harness a new run gets when the request omits one, remembered
-- across boots (the dashboard's harness selector writes it; `resolveDefaultHarness` reads it). Kept
-- deliberately generic so future single-value settings need no new table.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Ledger of applied schema migrations, keyed by NAME (see migrations.ts). Names — not a single
-- high-water version number like PRAGMA user_version — are the identity: divergent branches can
-- define same-numbered but different migrations, and a version stamp written by one lineage must
-- not make the other lineage silently skip its own migration (the runs.harness incident).
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_transitions_run ON transitions(run_id, id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_run ON agent_runs(run_id, id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, id);
