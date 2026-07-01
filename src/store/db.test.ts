/**
 * Database open/migration tests. The regression case: a file DB whose parent directory does not
 * exist yet (e.g. `./.agent-work/run.db` before the working root is created) must still open —
 * `better-sqlite3` will not create the parent dir, so `openDb` does.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate, openDb, type Db } from './db';
import { LATEST_VERSION, columnExists, runMigrations } from './migrations';

const userVersion = (db: Db): number => db.pragma('user_version', { simple: true }) as number;
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
  it('pins a fresh database to the latest schema version, and re-running is a no-op', () => {
    const db = openDb();
    expect(columnExists(db, 'runs', 'archived_at')).toBe(true); // baseline provisions it
    expect(userVersion(db)).toBe(LATEST_VERSION);

    expect(() => migrate(db)).not.toThrow(); // idempotent
    expect(userVersion(db)).toBe(LATEST_VERSION);
    db.close();
  });

  it('retrofits a database created before archived_at existed', () => {
    const db = new Database(':memory:');
    // a runs table shaped like the pre-archived_at schema (a subset is enough for the column check)
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}')`);
    expect(columnExists(db, 'runs', 'archived_at')).toBe(false);
    expect(userVersion(db)).toBe(0);

    migrate(db); // CREATE IF NOT EXISTS leaves the old `runs` as-is; the migration adds the column

    expect(columnExists(db, 'runs', 'archived_at')).toBe(true);
    expect(userVersion(db)).toBe(LATEST_VERSION);
    db.close();
  });

  it('retrofits a database created before the side_effects ledger existed', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '{}', archived_at TEXT)`);
    db.pragma('user_version = 1'); // already past migration 1; only migration 2 (side_effects) should run
    expect(tableExists(db, 'side_effects')).toBe(false);

    runMigrations(db); // the migration creates the ledger on a pre-existing DB

    expect(tableExists(db, 'side_effects')).toBe(true);
    expect(userVersion(db)).toBe(LATEST_VERSION);

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
    db.pragma('user_version = 2'); // already past migrations 1–2; only migration 3 (repos) should run
    expect(tableExists(db, 'repos')).toBe(false);

    runMigrations(db); // the migration creates the registry on a pre-existing DB

    expect(tableExists(db, 'repos')).toBe(true);
    expect(userVersion(db)).toBe(LATEST_VERSION);

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
    db.pragma('user_version = 3'); // past migrations 1–3; only migration 4 (cost_override) should run
    expect(columnExists(db, 'runs', 'cost_override')).toBe(false);

    runMigrations(db); // the migration adds the column on a pre-existing DB

    expect(columnExists(db, 'runs', 'cost_override')).toBe(true);
    expect(userVersion(db)).toBe(LATEST_VERSION);
    db.close();
  });
});
