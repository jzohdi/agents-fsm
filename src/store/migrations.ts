/**
 * Forward-only schema migrations (Layer 1 — see README §3.3).
 *
 * `schema.sql` is the canonical **current** schema, applied with `CREATE TABLE IF NOT EXISTS` to fully
 * provision a fresh database. The migrations here bring a **pre-existing** database (created against an
 * older schema) up to that same shape. Each is written to be **idempotent** — e.g. add a column only
 * if it is missing — so it is a harmless no-op on a fresh DB the baseline already satisfied, and safe
 * to re-run after a mid-way crash. Applied migrations are recorded **by name** in the
 * `schema_migrations` table, so an up-to-date database skips the work on every open. Names — not a
 * single high-water version number — are the identity: divergent branches can each define a
 * "migration 6", and a DB migrated by one lineage must still get the other's same-numbered-but-
 * different migration instead of silently skipping it (the runs.harness incident). SQLite's
 * `PRAGMA user_version` (the previous tracking scheme) is deliberately left untouched: code from a
 * pre-`schema_migrations` lineage keys on it and re-runs its own migrations, which their
 * idempotency makes harmless.
 *
 * Adding a migration: append `{ version: <next>, name, apply }` (versions order the list and must
 * stay a gap-free 1..N sequence; names are the tracked identity and must be unique — never rename
 * an applied one) and reflect the change in `schema.sql` too. Keep migrations additive: SQLite can
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
  {
    version: 7,
    name: 'create settings kv',
    // A tiny key/value store for the persisted default harness (multi-harness support). Mirrors
    // schema.sql; `CREATE TABLE IF NOT EXISTS` makes this a no-op on a fresh DB the baseline already
    // provisioned and a retrofit on a pre-existing one.
    apply: (db) =>
      db.exec(
        `CREATE TABLE IF NOT EXISTS settings (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );`,
      ),
  },
  {
    version: 8,
    name: 'add runs scheduling columns',
    // Cached §3.5 scheduling declarations + the dependency-satisfaction latch (Milestone 9). All
    // additive with constant defaults, so pre-existing rows backfill to "no dependencies, default
    // priority" — exactly what an absent marker block means — and behavior is unchanged until a
    // declaration is written. Mirrors schema.sql.
    apply: (db) => {
      addColumnIfMissing(db, 'runs', 'depends_on', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'runs', 'priority', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'runs', 'order_key', "TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'runs', 'deps_satisfied_at', 'TEXT');
    },
  },
];

// Guard the invariants the runner relies on: versions a gap-free, strictly increasing 1..N sequence
// (ordering only) and unique names (the identity key — a duplicate would shadow a real migration).
MIGRATIONS.forEach((m, i) => {
  if (m.version !== i + 1) {
    throw new Error(`migrations must be numbered 1..N with no gaps; found version ${m.version} at index ${i}`);
  }
});
if (new Set(MIGRATIONS.map((m) => m.name)).size !== MIGRATIONS.length) {
  throw new Error('migration names must be unique; the name is the applied-migration identity key');
}

// Mirrors schema.sql; created here too so `runMigrations` is self-sufficient when called directly.
const TRACKING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

/** The migration names a fully-migrated database has recorded in `schema_migrations`. */
export const appliedMigrations = (db: Db): Set<string> =>
  new Set((db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map((r) => r.name));

/**
 * Apply every migration the database has no record of, in order, recording each by name in the
 * same transaction. Idempotent and crash-safe: a fresh DB runs the (guarded) migrations as no-ops
 * and records them all; an older DB gets exactly the changes it has no record of — including a DB
 * whose `user_version` was stamped by a divergent lineage but that never saw these migrations.
 */
export function runMigrations(db: Db): void {
  db.exec(TRACKING_TABLE_SQL);
  const applied = appliedMigrations(db);
  const record = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    // Apply and record atomically: after a crash the migration is either fully applied and recorded,
    // or re-run from scratch (a no-op, per the idempotency invariant) — never recorded without running.
    db.transaction(() => {
      m.apply(db);
      record.run(m.name);
    })();
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
