import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // The sport adapter refuses to load without a sport; the rule tests
    // are sport-agnostic, so any known sport will do.
    env: { VITE_SPORT: process.env.VITE_SPORT ?? 'wnba' },
    include: ['src/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/rules/**/*.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
})
