import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.agent-work/` holds per-run clones of *target* repos during real runs. Their test files must
    // never be discovered or run by this project's suite (they belong to a different project and
    // often need a browser/other env), so exclude them alongside vitest's defaults.
    exclude: [...configDefaults.exclude, '.agent-work/**'],
  },
});
