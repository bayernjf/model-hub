// ESLint 9 flat config for the model-hub monorepo.
// Error-level baseline only; TypeScript owns unused/implicit-any via the
// strict tsconfig (matches the growth-agent/ops-console convention).
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/coverage/',
      '**/data/',
      'apps/hub/web/',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
