/**
 * One-command dev loop: `npm run dev`.
 *
 * Runs the dashboard build-watcher and the `serve` daemon together:
 *  - a `vite build --watch` child rebuilds `dashboard/dist` on every Svelte/TS/CSS change;
 *  - the daemon runs **in-process** here and serves that `dist` (read from disk per request) + the API.
 *
 * Edit the Svelte app → Vite rebuilds → refresh the browser to see it. (No HMR; for hot reload without
 * a refresh use `npm run dev:dashboard`, the Vite dev server, alongside a separate daemon.)
 *
 * Extra args pass straight through to the daemon. Runs are real by default; pass `--mock` for a
 * no-cost stub/fake daemon (handy for UI work), e.g.
 *   npm run dev -- --mock --port 4320
 *   npm run dev -- --repo owner/name --db ./.agent-work/run.db   # real runs, persisted
 *
 * Running the daemon in-process (rather than as a second child) keeps its own SIGINT/SIGTERM graceful
 * shutdown intact and avoids npm/tsx signal-forwarding leaving orphan processes; we only have to clean
 * up the one Vite child.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseCliArgs } from './cli-args';
import { serve } from './serve';

const ROOT = process.cwd();
const DIST_INDEX = join(ROOT, 'dashboard', 'dist', 'index.html');
const viteBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');

/** Spawn `vite build dashboard --watch`, prefixing its output so it's distinguishable from daemon logs. */
function startWatcher(): ChildProcess {
  const child = spawn(viteBin, ['build', 'dashboard', '--watch'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  prefixOutput('dashboard', child);
  child.on('exit', (code, signal) => {
    // The watcher should outlive the session; if it dies on its own, stop the daemon too.
    console.error(`\n[dev] dashboard watcher exited (${signal ?? code}). Stopping.`);
    process.exit(code ?? 1);
  });
  return child;
}

function prefixOutput(label: string, child: ChildProcess): void {
  const tag = `[${label}] `;
  const pipe = (src: NodeJS.ReadableStream | null, dest: NodeJS.WriteStream): void => {
    let buffered = '';
    src?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) dest.write(`${tag}${line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
}

/** Resolve once `dashboard/dist/index.html` exists, so the daemon never boots without a bundle to serve. */
function waitForFirstBuild(timeoutMs = 60_000): Promise<void> {
  if (existsSync(DIST_INDEX)) return Promise.resolve();
  console.log('[dev] waiting for the first dashboard build…');
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (existsSync(DIST_INDEX)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error('dashboard build did not produce dashboard/dist/index.html in time'));
      }
    }, 150);
    timer.unref();
  });
}

async function main(): Promise<void> {
  const watcher = startWatcher();
  process.once('SIGINT', () => watcher.kill('SIGTERM')); // the daemon's own handler closes the server
  process.once('SIGTERM', () => watcher.kill('SIGTERM'));

  await waitForFirstBuild();

  // Daemon args: everything after `npm run dev --`. `serve` ignores positionals[0], so a leading token is fine.
  const args = parseCliArgs(['serve', ...process.argv.slice(2)]);
  await serve(args); // resolves on SIGINT/SIGTERM after the daemon shuts down gracefully
  watcher.kill('SIGTERM');
}

main().catch((err) => {
  console.error(`[dev] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
