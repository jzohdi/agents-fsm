/**
 * Forward-only schema migrations (Layer 1 — see README §3.3).
 *
 * `schema.sql` is the canonical **current** schema, applied with `CREATE TABLE IF NOT EXISTS` to fully
 * provision a fresh database. The migrations here bring a **pre-existing** database (created against an
 * older schema) up to that same shape. Each is written to be **idempotent** — e.g. add a column only
 * if it is missing — so it is a harmless no-op on a fresh DB the baseline already satisfied, and safe
 * to re-run after a mid-way crash. The applied version is recorded in SQLite's built-in
 * `PRAGMA user_version`, so an up-to-date database skips the work on every open.
 *
 * Adding a migration: append `{ version: <next>, name, apply }` (versions must stay a gap-free 1..N
 * sequence) and reflect the change in `schema.sql` too. Keep migrations additive: SQLite can
 * `ALTER TABLE ADD COLUMN` cheaply but cannot change a CHECK constraint in place — that needs a full
 * table rebuild (the 12-step ALTER procedure); none is pending.
 */

import type { Db } from './db';

export interface Migration {
  version: number;
  name: string;
  apply: (db: Db) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'add runs.archived_at',
    apply: (db) => addColumnIfMissing(db, 'runs', 'archived_at', 'TEXT'),
  },
  {
    version: 2,
    name: 'create side_effects ledger',
    // The transactional outbox (Milestone 7). Mirrors schema.sql; both use IF NOT EXISTS, so this is
    // a no-op on a fresh DB the baseline already provisioned and a retrofit on a pre-existing one.
    apply: (db) =>
      db.exec(
        `CREATE TABLE IF NOT EXISTS side_effects (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           run_id     INTEGER NOT NULL REFERENCES runs(id),
           key        TEXT    NOT NULL,
           status     TEXT    NOT NULL CHECK (status IN ('pending', 'done')),
           result     TEXT,
           created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_side_effects_key ON side_effects(run_id, key);`,
      ),
  },
  {
    version: 3,
    name: 'create repos registry',
    // Multi-repo Phase A (Milestone 8). Mirrors schema.sql; `CREATE TABLE IF NOT EXISTS` makes this a
    // no-op on a fresh DB the baseline already provisioned and a retrofit on a pre-existing one.
    apply: (db) =>
      db.exec(
        `CREATE TABLE IF NOT EXISTS repos (
           id           INTEGER PRIMARY KEY AUTOINCREMENT,
           repo_ref     TEXT    NOT NULL COLLATE NOCASE UNIQUE,
           clone_url    TEXT,
           local_repo   TEXT,
           working_root TEXT    NOT NULL,
           base_branch  TEXT    NOT NULL DEFAULT 'main',
           created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         );`,
      ),
  },
  {
    version: 4,
    name: 'add runs.cost_override',
    // Per-run override of the global cost ceiling (Milestone 8 B3). Additive column, so a plain
    // ALTER ADD COLUMN retrofits a pre-existing DB; a fresh DB already has it from schema.sql.
    apply: (db) => addColumnIfMissing(db, 'runs', 'cost_override', 'TEXT'),
  },
  {
    version: 5,
    name: 'add runs.model_override',
    // Per-run harness model override (the dashboard's model dropdown). Additive column, so a plain
    // ALTER ADD COLUMN retrofits a pre-existing DB; a fresh DB already has it from schema.sql.
    apply: (db) => addColumnIfMissing(db, 'runs', 'model_override', 'TEXT'),
  },
  {
    version: 6,
    name: 'add runs.harness',
    // Which agent harness runs each row (multi-harness support). SQLite allows ADD COLUMN with a
    // constant default, so pre-existing rows backfill to 'claude-code' — the shipped default — and the
    // column is NOT NULL from the start. No CHECK on the value: ALTER can't add one, so imposing it here
    // would make a fresh DB (schema.sql) diverge from a migrated one; the valid set is app-validated.
    apply: (db) => addColumnIfMissing(db, 'runs', 'harness', "TEXT NOT NULL DEFAULT 'claude-code'"),
  },
];

/** The schema version a fully-migrated database reports — the highest defined migration. */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

// Guard the invariant the runner relies on: a gap-free, strictly increasing 1..N sequence.
MIGRATIONS.forEach((m, i) => {
  if (m.version !== i + 1) {
    throw new Error(`migrations must be numbered 1..N with no gaps; found version ${m.version} at index ${i}`);
  }
});

/**
 * Apply every migration the database has not yet recorded, in order, pinning `user_version` after
 * each. Idempotent and crash-safe: a fresh DB re-runs the (guarded) migrations as no-ops and ends
 * pinned at {@link LATEST_VERSION}; an older DB gets exactly the changes it is missing.
 */
export function runMigrations(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => m.apply(db))(); // the schema change itself is atomic
    // Record progress outside the DDL transaction (some PRAGMAs can't run inside one); re-applying an
    // already-applied migration after a crash here is a no-op, so the unrecorded window is harmless.
    db.pragma(`user_version = ${m.version}`);
  }
}

/** Whether `table` has a column named `column`. Identifiers are internal constants — never user input. */
export function columnExists(db: Db, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(db: Db, table: string, column: string, definition: string): void {
  if (!columnExists(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
