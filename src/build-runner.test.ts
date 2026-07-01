/**
 * build-runner tests (Milestone 5): the shared wiring for the CLI and the `serve` daemon. Stub/fake
 * mode only — no network, no cost — proving the daemon's Orchestrator is assembled correctly.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { loadDefaultConfig } from './fsm/config';
import { parseCliArgs } from './cli-args';
import { buildOrchestrator, buildRunner, loadRunConfig, resolveConcurrency, resolveCostCeiling } from './build-runner';
import { openDb } from './store/db';
import { Repository } from './store/repository';

const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('./fsm/default-config.json', import.meta.url));

describe('buildOrchestrator (stub/fake mode)', () => {
  it('assembles a working orchestrator that drives a run to done', async () => {
    const { orchestrator } = buildOrchestrator(parseCliArgs(['o/r#1', '--mock']));
    const run = orchestrator.start({ issueRef: 'o/r#1' });
    await orchestrator.settle();
    expect(orchestrator.getRun(run.id).status).toBe('done');
  });
});

describe('buildRunner (real mode — boot-time enrollment, Milestone 8)', () => {
  // Constructing the real executor + adapter is side-effect-free (no spawn, no network until used),
  // so this exercises the registry-backed resolver without spending tokens or touching GitHub.
  it('enrolls the bound repo and returns a registry-backed resolver', () => {
    const repo = new Repository(openDb(':memory:'));
    const { agents } = loadDefaultConfig();
    const args = parseCliArgs(['acme/web#1', '--repo', 'acme/web', '--base', 'develop']);

    const { resolver } = buildRunner(args, repo, agents, 'acme/web');

    // The bound repo was enrolled from the CLI args…
    expect(repo.getRepo('acme/web')).toMatchObject({ workingRoot: args.work, baseBranch: 'develop' });
    // …and the resolver serves it from the registry (its base branch flows through)…
    expect(resolver.for('acme/web')).toMatchObject({ baseBranch: 'develop' });
    // …while an unenrolled repo is a loud error, not a silent default (proves it isn't a single-repo stub).
    expect(() => resolver.for('ghost/repo')).toThrow(/not enrolled/);
  });
});

describe('resolveConcurrency (global cap: --concurrency → FLEET_CONCURRENCY → default, Milestone 8 Phase B)', () => {
  const originalEnv = process.env.FLEET_CONCURRENCY;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.FLEET_CONCURRENCY;
    else process.env.FLEET_CONCURRENCY = originalEnv;
  });

  const argsWith = (concurrency?: number): ReturnType<typeof parseCliArgs> => ({
    ...parseCliArgs(['serve']),
    ...(concurrency !== undefined ? { concurrency } : {}),
  });

  it('defaults to 4 when neither the flag nor the env var is set', () => {
    delete process.env.FLEET_CONCURRENCY;
    expect(resolveConcurrency(argsWith())).toBe(4);
  });

  it('prefers the --concurrency flag over the env var', () => {
    process.env.FLEET_CONCURRENCY = '8';
    expect(resolveConcurrency(argsWith(3))).toBe(3);
  });

  it('falls back to FLEET_CONCURRENCY when the flag is absent', () => {
    process.env.FLEET_CONCURRENCY = '6';
    expect(resolveConcurrency(argsWith())).toBe(6);
  });

  it('ignores a non-positive or non-numeric value and uses the default (never wedges at 0)', () => {
    process.env.FLEET_CONCURRENCY = '0';
    expect(resolveConcurrency(argsWith())).toBe(4);
    process.env.FLEET_CONCURRENCY = 'nonsense';
    expect(resolveConcurrency(argsWith())).toBe(4);
    delete process.env.FLEET_CONCURRENCY;
    expect(resolveConcurrency(argsWith(-2))).toBe(4);
  });
});

describe('resolveCostCeiling (global cost ceiling: --cost-ceiling → FLEET_COST_CEILING → off, Milestone 8 B3)', () => {
  const originalEnv = process.env.FLEET_COST_CEILING;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.FLEET_COST_CEILING;
    else process.env.FLEET_COST_CEILING = originalEnv;
  });

  const argsWith = (costCeiling?: number): ReturnType<typeof parseCliArgs> => ({
    ...parseCliArgs(['serve']),
    ...(costCeiling !== undefined ? { costCeiling } : {}),
  });

  it('is off (undefined) when neither the flag nor the env var is set', () => {
    delete process.env.FLEET_COST_CEILING;
    expect(resolveCostCeiling(argsWith())).toBeUndefined();
  });

  it('prefers the --cost-ceiling flag over the env var', () => {
    process.env.FLEET_COST_CEILING = '50';
    expect(resolveCostCeiling(argsWith(10))).toBe(10);
  });

  it('falls back to FLEET_COST_CEILING when the flag is absent, and allows a 0 ceiling', () => {
    process.env.FLEET_COST_CEILING = '25';
    expect(resolveCostCeiling(argsWith())).toBe(25);
    process.env.FLEET_COST_CEILING = '0';
    expect(resolveCostCeiling(argsWith())).toBe(0);
  });

  it('treats a negative or non-numeric value as off (never wedges the fleet on a typo)', () => {
    process.env.FLEET_COST_CEILING = '-5';
    expect(resolveCostCeiling(argsWith())).toBeUndefined();
    process.env.FLEET_COST_CEILING = 'nonsense';
    expect(resolveCostCeiling(argsWith())).toBeUndefined();
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
