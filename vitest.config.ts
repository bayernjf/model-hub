import { defineConfig } from 'vitest/config';

// node:sqlite is newer than this Vite version's builtin allow-list; a
// pre-resolve plugin marks it external so the test runner loads it from
// Node instead of Vite trying (and failing) to bundle "sqlite".
const externalizeNodeSqlite = {
  name: 'externalize-node-sqlite',
  enforce: 'pre' as const,
  resolveId(source: string) {
    // Match both the prefixed and (during some Vite resolve stages) the
    // bare "sqlite" id and force it external to Node.
    if (source === 'node:sqlite' || source === 'sqlite') {
      return { id: 'node:sqlite', external: true };
    }
    return null;
  },
};

export default defineConfig({
  plugins: [externalizeNodeSqlite],
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 30000,
    pool: 'threads',
  },
});
