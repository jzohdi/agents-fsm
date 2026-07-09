import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // The dashboard store (`store.svelte.ts`) uses Svelte 5 runes (`$state`), so it must be compiled by
  // the Svelte plugin to load under vitest. The transform only touches `.svelte`/`.svelte.ts` files, so
  // the existing plain-`.ts` backend and dashboard tests are unaffected. Runes run under the default
  // node environment — no jsdom/testing-library needed.
  plugins: [svelte()],
  test: {
    // `.agent-work/` holds per-run clones of *target* repos during real runs; `dashboard/dist/` is the
    // built dashboard bundle. Neither holds tests for this suite, so exclude them alongside vitest's
    // defaults. (The dashboard's own `src/lib/render.test.ts` IS discovered + run here — it is a pure,
    // Node-runnable unit test of the view-model logic, no browser needed.)
    exclude: [...configDefaults.exclude, '.agent-work/**', 'dashboard/dist/**'],
  },
});
