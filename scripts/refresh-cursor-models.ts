/**
 * Refresh the curated Cursor model catalog from `cursor-agent --list-models` (the authoritative set of
 * `--model` values the installed CLI accepts).
 *
 *   npm run models:refresh              # dry run — report what would change
 *   npm run models:refresh -- --write   # apply the changes to cursor-models.json
 *
 * The heavy lifting (parse, infer, merge) is the pure, unit-tested {@link ../src/agent/cursor-models-source}
 * module; this wrapper only runs the CLI and reads/writes the JSON. Discovered models are added with
 * inferred metadata and a mid cost tier — skim `added` afterwards and hand-curate the label/cost/
 * `recommended` flag (curated edits survive future refreshes). Requires the `cursor-agent` CLI on PATH.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { mergeModels, parseModelList } from '../src/agent/cursor-models-source';
import type { HarnessModel } from '../src/agent/harness-models';

const JSON_PATH = new URL('../src/agent/cursor-models.json', import.meta.url);

function listModels(): string {
  try {
    return execFileSync('cursor-agent', ['--list-models'], { encoding: 'utf8' });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') throw new Error('`cursor-agent` not found on PATH — install + authenticate the Cursor CLI first (README §9.1).');
    // Some CLIs print the list to stderr / exit non-zero; fall back to whatever output we captured.
    const out = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`;
    if (out.trim()) return out;
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function main(): void {
  const write = process.argv.includes('--write');

  const ids = parseModelList(listModels());
  if (ids.length === 0) {
    console.error('`cursor-agent --list-models` returned no recognizable model ids. Aborting (no changes).');
    process.exit(1);
  }

  const curated = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as HarnessModel[];
  const { models, added, removed } = mergeModels(curated, ids);

  console.log(`cursor-agent lists ${ids.length} models · catalog has ${curated.length} · merged → ${models.length}`);
  if (added.length) console.log(`  + added ${added.length}: ${added.join(', ')}`);
  if (removed.length) console.log(`  - removed ${removed.length}: ${removed.join(', ')}`);
  if (!added.length && !removed.length) console.log('  catalog already up to date.');

  if (!write) {
    if (added.length || removed.length) console.log('\nDry run — re-run with `-- --write` to apply.');
    return;
  }
  writeFileSync(JSON_PATH, JSON.stringify(models, null, 2) + '\n');
  console.log(`\nWrote ${models.length} models to src/agent/cursor-models.json.` + (added.length ? ' Curate the added entries (label/cost/recommended).' : ''));
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
