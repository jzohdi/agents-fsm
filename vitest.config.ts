import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.agent-work/` holds per-run clones of *target* repos during real runs; `dashboard/dist/` is the
    // built dashboard bundle. Neither holds tests for this suite, so exclude them alongside vitest's
    // defaults. (The dashboard's own `src/lib/render.test.ts` IS discovered + run here — it is a pure,
    // Node-runnable unit test of the view-model logic, no browser needed.)
    exclude: [...configDefaults.exclude, '.agent-work/**', 'dashboard/dist/**'],
  },
});
