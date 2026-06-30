import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

/**
 * Vite config for the dashboard SPA (Milestone 6, Svelte rebuild).
 *
 * `vite build dashboard` → `dashboard/dist/` (the gitignored bundle the daemon serves in production).
 * `vite dashboard` → a dev server with HMR; it proxies the API + SSE to a locally-running daemon
 * (`npm start -- serve`) so the UI hot-reloads while real data comes from the orchestrator.
 */
const DAEMON = process.env.AF_DAEMON ?? 'http://127.0.0.1:4319';
const API_ROUTES = ['/runs', '/config', '/health', '/stream'];

export default defineConfig({
  plugins: [svelte()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(API_ROUTES.map((route) => [route, { target: DAEMON, changeOrigin: true }])),
  },
});
