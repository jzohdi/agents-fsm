import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.agent-work/` holds per-run clones of *target* repos (real runs) — never lint their code.
    ignores: ['node_modules/', 'dist/', 'coverage/', '.agent-work/'],
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
