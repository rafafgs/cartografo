import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config única da raiz, aplicada aos dois pacotes e aos scripts soltos.
 *
 * Só regras de base (`recommended`), sem checagem com informação de tipo: o
 * portão de tipos é `npm run typecheck` (`tsc --noEmit --strict`), e duplicá-lo
 * no lint só dobraria o tempo de execução com o mesmo resultado.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.cartografo/**',
      // Fixtures escritos em disco por teste; nunca ficam versionados, mas o
      // eslint roda no working tree e pegaria os que sobrarem de uma execução
      // interrompida.
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
