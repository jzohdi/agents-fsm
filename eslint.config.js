import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.agent-work/` holds per-run clones of *target* repos (real runs) — never lint their code.
    // `dashboard/` is the Svelte + Vite SPA: a separate front-end with its own toolchain (Svelte
    // syntax, browser globals, type-checked by `svelte-check`), so the Node `src/` lint config doesn't
    // apply. Its pure view-model logic (`render.ts`) is unit-tested by the root vitest suite.
    ignores: ['node_modules/', 'dist/', 'coverage/', '.agent-work/', 'dashboard/'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow leading-underscore escape hatch for intentionally unused vars.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests deliberately build malformed inputs to exercise validation.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
