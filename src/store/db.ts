/**
 * SQLite connection + migration (Layer 1 — see README §3.3).
 *
 * On open we apply `schema.sql` (the canonical current schema, `CREATE TABLE IF NOT EXISTS`, which
 * fully provisions a fresh database) and then run the forward-only migrations in {@link ./migrations}
 * to bring any pre-existing database up to the same shape. Migrations are idempotent and tracked via
 * SQLite's `PRAGMA user_version`, so this is safe to run on every open.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { runMigrations } from './migrations';

export type Db = Database.Database;

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Provision the schema and apply any pending migrations (idempotent). */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL); // baseline: full current schema; a no-op for tables that already exist
  runMigrations(db); // retrofit older databases (e.g. add columns) and pin user_version
}

/**
 * Open a database and ensure the schema is present.
 * Defaults to an in-memory database (used by tests).
 */
export function openDb(path = ':memory:'): Db {
  // better-sqlite3 won't create a missing parent directory, so create it for a file path
  // (e.g. `./.agent-work/run.db` before the working root exists).
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL improves concurrency for on-disk databases; it has no meaning for :memory:.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
