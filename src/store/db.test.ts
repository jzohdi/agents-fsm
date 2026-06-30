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
    db.close();
  });
});
