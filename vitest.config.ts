import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['app/**/*.{ts,tsx}', 'lib/**/*.ts', 'packages/**/*.ts'],
      exclude: [
        '**/*.config.*',
        '**/*.d.ts',
        'app/layout.tsx',
        'app/page.tsx',
        'drizzle/**',
        'scripts/**',
        '**/.next/**',
        'coverage/**',
        // next-intl getRequestConfig wiring — thin framework glue exercised via
        // integration (locale resolution lives in the tested lib/i18n/config.ts),
        // not meaningfully unit-testable on its own.
        'lib/i18n/request.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        'lib/erp/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'packages/erp-core/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'lib/sync/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
})
