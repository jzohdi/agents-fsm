/**
 * Database open/migration tests. The regression case: a file DB whose parent directory does not
 * exist yet (e.g. `./.agent-work/run.db` before the working root is created) must still open —
 * `better-sqlite3` will not create the parent dir, so `openDb` does.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb } from './db';

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
