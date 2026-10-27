// ESLint 9 flat config for the model-hub monorepo.
// TypeScript owns unused/implicit-any via the strict tsconfig (matches the
// growth-agent/ops-console convention). Astro templates are skipped; the
// browser islands get DOM globals while the server uses Node globals.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/coverage/',
      '**/data/',
      '**/.astro/',
      '**/*.astro',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Browser-side React islands under the Astro console.
    files: ['apps/hub/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
);
