import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * Vite config for the dashboard SPA (Milestone 6, Svelte rebuild).
 *
 * `vite build dashboard` → `dashboard/dist/` (the gitignored bundle the daemon serves in production).
 * `vite dashboard` → a dev server with HMR; it proxies the API + SSE to a locally-running daemon
 * (`npm start -- serve`) so the UI hot-reloads while real data comes from the orchestrator.
 * `changeOrigin` rewrites only `Host`; keep the browser's `Origin` (`http://localhost:5173`) as it is, so
 * the daemon's cross-site guard still sees where a write came from (rewriting it would make this dev
 * server a relay for any page).
 */
const DAEMON = process.env.AF_DAEMON ?? 'http://127.0.0.1:4319';
const API_ROUTES = ['/runs', '/config', '/health', '/stream', '/suggestions', '/repos', '/cost', '/models', '/settings', '/scheduler'];

export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(API_ROUTES.map((route) => [route, { target: DAEMON, changeOrigin: true }])),
  },
});
