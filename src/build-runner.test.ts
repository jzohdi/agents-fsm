/**
 * build-runner tests (Milestone 5): the shared wiring for the CLI and the `serve` daemon. Stub/fake
 * mode only — no network, no cost — proving the daemon's Orchestrator is assembled correctly.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadDefaultConfig } from './fsm/config';
import { parseCliArgs } from './cli-args';
import { buildOrchestrator, loadRunConfig } from './build-runner';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./fsm/default-config.json', import.meta.url));

describe('buildOrchestrator (stub/fake mode)', () => {
  it('assembles a working orchestrator that drives a run to done', async () => {
    const { orchestrator } = buildOrchestrator(parseCliArgs(['o/r#1', '--mock']));
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(orchestrator.getRun(run.id).status).toBe('done');
  });
});

describe('loadRunConfig', () => {
  it('falls back to the bundled default (read-only) when no --config is given', () => {
    const { loaded, configPath } = loadRunConfig(parseCliArgs(['o/r#1']));
    expect(configPath).toBeUndefined(); // no path ⇒ PUT /config is read-only
    expect(loaded.version).toBe(loadDefaultConfig().version);
  });

  it('loads a --config file and reports its path (so updates persist there)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-m5-br-'));
    const path = join(dir, 'fsm.json');
    writeFileSync(path, readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

    const { loaded, configPath } = loadRunConfig(parseCliArgs(['o/r#1', '--config', path]));
    expect(configPath).toBe(path);
    expect(loaded.fsm.initial).toBe('triage');
  });
});
