/**
 * SQLite connection + migration (Layer 1 — see README §3.3).
 *
 * KISS: the whole schema is applied on open via `CREATE TABLE IF NOT EXISTS`.
 * When the schema grows beyond what that handles, this is where a real migration
 * runner would slot in.
 */

import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

/** Apply the schema to a database (idempotent). */
export function migrate(db: Db): void {
  db.exec(SCHEMA_SQL);
}

/**
 * Open a database and ensure the schema is present.
 * Defaults to an in-memory database (used by tests).
 */
export function openDb(path = ':memory:'): Db {
  const db = new Database(path);
  // WAL improves concurrency for on-disk databases; it has no meaning for :memory:.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}
