import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
    // lib/i18n/request.ts runs in the RSC layer in production, where Next.js's
    // bundler resolves next-intl's "react-server" export condition. Vitest's
    // Node/SSR resolution otherwise falls through to the client build, which
    // throws ("getRequestConfig is not supported in Client Components").
    conditions: ['react-server'],
  },
  ssr: {
    resolve: { conditions: ['react-server'] },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Vitest externalizes node_modules by default and loads them via Node's
    // native resolver, which ignores the `resolve.conditions` above. Inlining
    // next-intl routes it through Vite's resolver instead, so the
    // "react-server" condition actually takes effect.
    server: { deps: { inline: ['next-intl'] } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['app/**/*.{ts,tsx}', 'lib/**/*.ts', 'packages/**/*.ts'],
      exclude: [
        '**/*.config.*',
        '**/*.d.ts',
        'app/layout.tsx',
        'app/page.tsx',
        // Thin 'use client' + useEffect/Dexie glue, same rationale as
        // app/layout.tsx/app/page.tsx above — no branch logic worth unit
        // testing without adding a jsdom + React Testing Library dependency
        // chain the task didn't otherwise call for (Task 16 self-review).
        'app/(app)/customers/page.tsx',
        'drizzle/**',
        'scripts/**',
        'lib/test-support/**',
        '**/.next/**',
        'coverage/**',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        'lib/erp/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'packages/erp-core/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'lib/sync/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'lib/domain/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'lib/api/ext/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'lib/security/tokens.ts': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
})
