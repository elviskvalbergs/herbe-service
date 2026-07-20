import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
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
    // Gated live-ERP contract suite (tests/live/**) hits a real ERP over the
    // network and is only meant to run via `pnpm test:live`. Excluded from
    // the default run so `pnpm test`/CI never touches the network — on top
    // of the describe.skipIf inside the file itself. The exclude is
    // conditional on RUN_LIVE_ERP_TESTS rather than a plain static entry:
    // Vitest applies `exclude` even to an explicit CLI path argument, so a
    // hard-coded 'tests/live/**' here would also make `pnpm test:live`
    // (which sets RUN_LIVE_ERP_TESTS=1 before invoking `vitest run
    // tests/live`) collect zero files. Gating the exclude on the same env
    // var keeps both commands working: unset -> excluded/never collected;
    // set -> collected, then the file's own describe.skipIf decides.
    //
    // tests/e2e/** is always excluded regardless of that flag — it's
    // Playwright's own suite (playwright.config.ts), not vitest's. Its spec
    // files use @playwright/test's test/expect; vitest's default
    // `**/*.spec.ts` include pattern would otherwise also try to collect and
    // run them, failing immediately on the wrong test API.
    exclude: process.env.RUN_LIVE_ERP_TESTS
      ? [...configDefaults.exclude, 'tests/e2e/**']
      : [...configDefaults.exclude, 'tests/live/**', 'tests/e2e/**'],
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
        // Thin 'use client' + useEffect/Dexie glue, same rationale as
        // app/layout.tsx above — no branch logic worth unit testing without
        // adding a jsdom + React Testing Library dependency chain the task
        // didn't otherwise call for (Task 16 self-review). app/page.tsx used
        // to be excluded on the same basis (create-next-app boilerplate) but
        // Task 4 gave it real branch logic and a real test file, so it was
        // removed from this list.
        'app/(app)/customers/page.tsx',
        'drizzle/**',
        'scripts/**',
        'lib/test-support/**',
        'tests/live/**',
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
