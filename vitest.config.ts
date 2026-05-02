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
