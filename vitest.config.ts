import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts', 'homebridge-ui/server/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/types.ts', 'src/**/*.d.ts'],
      thresholds: {
        // Lines / statements / functions are the load-bearing coverage signals
        // for "is this code actually exercised?". We hold those at 95.
        // Branches are deliberately lower: the codebase has a number of
        // defensive guards (e.g. `if (!this.ccu) return;` after type-narrowing
        // would otherwise allow the field to be undefined) that are
        // statically unreachable but must remain for type safety. Targeted
        // `c8 ignore` annotations cover the worst of those; the rest is
        // genuine HTTP error / timeout paths that aren't worth elaborate
        // network-mock plumbing to chase.
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 90,
      },
    },
    pool: 'forks',
    testTimeout: 10000,
  },
});
