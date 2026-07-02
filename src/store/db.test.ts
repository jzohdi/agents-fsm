/**
 * Database open/migration tests. Two regression cases: a file DB whose parent directory does not
 * exist yet (e.g. `./.agent-work/run.db` before the working root is created) must still open —
 * `better-sqlite3` will not create the parent dir, so `openDb` does; and a DB whose `user_version`
 * was stamped by a divergent branch's migrations must still receive this branch's (name-tracked)
 * migrations instead of silently skipping them.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate, openDb, type Db } from './db';
import { MIGRATIONS, appliedMigrations, columnExists, runMigrations } from './migrations';

/** A fully-migrated database has every migration recorded by name in `schema_migrations`. */
const ALL_MIGRATION_NAMES = new Set(MIGRATIONS.map((m) => m.name));
const tableExists = (db: Db, name: string): boolean =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
/** Column name + type + not-null + default, for comparing a table's shape across DBs. */
const columns = (db: Db, table: string): unknown[] =>
  (db.pragma(`table_info(${table})`) as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>).map(
    (c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value }),
  );

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('openDb', () => {
  it('opens an in-memory database with the schema applied', () => {
    const db = openDb(); // defaults to :memory:
    expect(db.open).toBe(true);
    // The schema is present (a known table is queryable).
    expect(() => db.prepare('SELECT COUNT(*) FROM runs').get()).not.toThrow();
    db.close();
  });

  it('creates the missing parent directory for a file DB path', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-fleet-db-'));
    created.push(root);
    const path = join(root, 'nested', 'deep', 'run.db'); // none of these dirs exist yet

    const db = openDb(path);

    expect(db.open).toBe(true);
    expect(existsSync(path)).toBe(true);
    db.close();
  });
});

describe('migrate', () => {
  it('records every migration on a fresh database, and re-running is a no-op', () => {
    const db = openDb();
    expect(columnExists(db, 'runs', 'archived_at')).toBe(true); // baseline provisions it
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);

    expect(() => migrate(db)).not.toThrow(); // idempotent
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);
    db.close();
  });

  it('retrofits a database created before archived_at existed', () => {
    const db = new Database(':memory:');
    // a runs table shaped like the pre-archived_at schema (a subset is enough for the column check)
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}')`);
    expect(columnExists(db, 'runs', 'archived_at')).toBe(false);

    migrate(db); // CREATE IF NOT EXISTS leaves the old `runs` as-is; the migration adds the column

    expect(columnExists(db, 'runs', 'archived_at')).toBe(true);
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);
    db.close();
  });

  it('retrofits a database created before the side_effects ledger existed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    expect(tableExists(db, 'side_effects')).toBe(false);

    runMigrations(db); // every unrecorded migration runs; the side_effects one creates the ledger

    expect(tableExists(db, 'side_effects')).toBe(true);
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);

    // Drift guard: a retrofitted ledger must be schema-identical to a fresh DB's (the migration SQL and
    // schema.sql define the same table; if they drift, old and new databases diverge silently).
    const fresh = openDb();
    expect(columns(db, 'side_effects')).toEqual(columns(fresh, 'side_effects'));
    fresh.close();
    db.close();
  });

  it('retrofits a database created before the repos registry existed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    expect(tableExists(db, 'repos')).toBe(false);

    runMigrations(db); // the repos migration creates the registry on a pre-existing DB

    expect(tableExists(db, 'repos')).toBe(true);
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);

    // Drift guard: a retrofitted registry must be schema-identical to a fresh DB's.
    const fresh = openDb();
    expect(columns(db, 'repos')).toEqual(columns(fresh, 'repos'));
    fresh.close();

    // ...including the COLLATE NOCASE on repo_ref (which `table_info` above can't see): the migration's
    // uniqueness must be case-insensitive, so a second casing of the same repo is rejected, not stored.
    db.prepare("INSERT INTO repos (repo_ref, working_root) VALUES ('Acme/Web', './w')").run();
    expect(() => db.prepare("INSERT INTO repos (repo_ref, working_root) VALUES ('acme/web', './w2')").run()).toThrow(
      /UNIQUE/,
    );
    db.close();
  });

  it('retrofits a database created before runs.cost_override existed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    expect(columnExists(db, 'runs', 'cost_override')).toBe(false);

    runMigrations(db); // the cost_override migration adds the column on a pre-existing DB

    expect(columnExists(db, 'runs', 'cost_override')).toBe(true);
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);
    db.close();
  });

  it('retrofits a database created before runs.model_override existed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    expect(columnExists(db, 'runs', 'model_override')).toBe(false);

    runMigrations(db); // the model_override migration adds the column on a pre-existing DB

    expect(columnExists(db, 'runs', 'model_override')).toBe(true);
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);
    db.close();
  });

  it('retrofits a database created before runs.harness existed, backfilling to claude-code', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    db.prepare("INSERT INTO runs (status) VALUES ('running')").run(); // a pre-existing row, before the column
    expect(columnExists(db, 'runs', 'harness')).toBe(false);

    runMigrations(db); // the harness migration adds the NOT NULL column with a constant default on a pre-existing DB

    expect(columnExists(db, 'runs', 'harness')).toBe(true);
    // The constant default backfills existing rows — no NULL harness that would break the runner's lookup.
    expect((db.prepare('SELECT harness FROM runs').get() as { harness: string }).harness).toBe('claude-code');
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);
    db.close();
  });

  it('heals a database stamped "fully migrated" by a divergent migration lineage', () => {
    // The cross-branch collision (the runs.harness incident): another branch defined its own
    // migrations 6–7 and stamped user_version = 7 into a shared DB. By version number the DB is
    // "fully migrated", but this branch's migration 6 (add runs.harness) never ran. Version-based
    // tracking silently skips it; name-based tracking must apply it.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT, cost_override TEXT, model_override TEXT)`);
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); // the other lineage's 7 created this too
    db.pragma('user_version = 7'); // the other lineage's high-water mark — same number, different migrations
    expect(columnExists(db, 'runs', 'harness')).toBe(false);

    migrate(db);

    expect(columnExists(db, 'runs', 'harness')).toBe(true); // no longer shadowed by the foreign version stamp
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES); // and every migration is now on record by name

    // Drift guard: the retrofitted tracking table must be schema-identical to a fresh DB's.
    const fresh = openDb();
    expect(columns(db, 'schema_migrations')).toEqual(columns(fresh, 'schema_migrations'));
    fresh.close();
    db.close();
  });

  it('retrofits a database created before the scheduling columns existed (Milestone 9)', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    db.prepare("INSERT INTO runs (status) VALUES ('running')").run(); // a pre-existing row, before the columns
    expect(columnExists(db, 'runs', 'depends_on')).toBe(false);

    runMigrations(db); // the scheduling migration adds all four columns on a pre-existing DB

    for (const col of ['depends_on', 'priority', 'order_key', 'deps_satisfied_at']) {
      expect(columnExists(db, 'runs', col)).toBe(true);
    }
    // Constant defaults backfill the pre-existing row to "no dependencies, default priority" — the
    // exact meaning of an absent §3.5 marker block, so old runs stay dispatchable and unordered.
    const row = db.prepare('SELECT depends_on, priority, order_key, deps_satisfied_at FROM runs').get() as {
      depends_on: string;
      priority: number;
      order_key: string;
      deps_satisfied_at: string | null;
    };
    expect(row).toEqual({ depends_on: '[]', priority: 0, order_key: '', deps_satisfied_at: null });
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);
    db.close();
  });

  it('retrofits a database created before the settings store existed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    expect(tableExists(db, 'settings')).toBe(false);

    runMigrations(db); // the settings migration creates the KV store on a pre-existing DB

    expect(tableExists(db, 'settings')).toBe(true);
    expect(appliedMigrations(db)).toEqual(ALL_MIGRATION_NAMES);

    // Drift guard: a retrofitted settings table must be schema-identical to a fresh DB's.
    const fresh = openDb();
    expect(columns(db, 'settings')).toEqual(columns(fresh, 'settings'));
    fresh.close();
    db.close();
  });
});
