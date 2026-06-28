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
                       CHECK (status IN ('running', 'paused', 'blocked', 'done', 'needs_human')),
  fsm_config_version TEXT    NOT NULL,                 -- pins the config version for the run's lifetime
  pr_number          INTEGER,
  branch             TEXT,
  tokens_used        INTEGER NOT NULL DEFAULT 0,       -- cumulative, for the run-budget guard
  cost_used          REAL    NOT NULL DEFAULT 0,
  agent_runs_count   INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The event queue/log that drives handoffs. `status` + a unique id make
-- at-least-once processing idempotent (README §3.3 Layer 3).
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

CREATE INDEX IF NOT EXISTS idx_transitions_run ON transitions(run_id, id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_run ON agent_runs(run_id, id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, id);
