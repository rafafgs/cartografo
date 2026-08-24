import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * The root's single flat config, applied to every package and to the loose scripts.
 *
 * Base rules only (`recommended`), with no type-aware checking: the type gate is
 * `npm run typecheck` (`tsc --noEmit --strict`), and duplicating it in the lint
 * would only double the running time for the same result.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.cartografo/**',
      // Fixtures written to disk by a test; they are never versioned, but
      // eslint runs over the working tree and would pick up whatever is left
      // behind by an interrupted run.
      '**/.tmp-fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
