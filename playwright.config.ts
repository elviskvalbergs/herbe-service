// playwright.config.ts
//
// Task 11 (docs/superpowers/sdd/task-11-brief.md): first Playwright config in
// this repo. Runs against a *built* server (`next build --webpack && next
// start`), not `next dev` — next-pwa's service worker (next.config.ts:
// `disable: process.env.NODE_ENV === 'development'`) only exists in a
// production build, and the offline-reload assertion in
// tests/e2e/app-shell.spec.ts needs a real, active service worker to have
// anything to fall back to.
//
// DATABASE_URL is derived here (not created dynamically in globalSetup and
// then injected into webServer.env): Playwright starts webServer and waits
// for it to become available BEFORE running any globalSetup file (see
// playwright/lib/runner's createGlobalSetupTasks() — the webServer plugin's
// setup() task runs as part of the earlier `plugin setup` tasks, ahead of
// the `globalSetups` array). By the time this config object is built,
// webServer.env must already be its final value. Using one fixed,
// deterministic e2e database name (rather than a fresh random one per run,
// the vitest suite's convention — lib/test-support/db.ts) sidesteps that
// ordering entirely: the app server boots fine even before the database
// exists (postgres.js connects lazily, on the first real query — see
// lib/db.ts), and tests/e2e/global-setup.ts creates/migrates/seeds that same
// fixed database before any test navigates.
import { defineConfig, devices } from '@playwright/test'

const PORT = 3100

const ADMIN_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres'
export const E2E_DATABASE_URL = ADMIN_DB_URL.replace(/\/[^/]+(\?.*)?$/, '/herbe_service_e2e_ws1$1')

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // `pnpm build` already is `next build --webpack` (see package.json) —
    // no need to pass --webpack again here.
    command: `pnpm build && pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      TEST_AUTH: '1',
      // `next start` always forces NODE_ENV=production, regardless of the
      // shell's own NODE_ENV. lib/auth/test-provider.ts's isTestAuthEnabled()
      // only falls back to a NODE_ENV check when VERCEL_ENV is unset — so a
      // built server needs VERCEL_ENV set to any non-'production' value to
      // keep test-login open. This is exactly the case that file's own
      // comment anticipates ("Vercel sets NODE_ENV=production on PREVIEW
      // deploys too ... where Task 19's Playwright suite needs it" — this is
      // that suite, just running locally against a built server instead of a
      // real Preview deploy).
      VERCEL_ENV: 'preview',
      // Same throwaway values already used by this repo's own tests/CI (see
      // .github/workflows/ci.yml's vitest env and lib/security/envelope.test.ts)
      // — not real secrets.
      AUTH_SECRET: 'test-only-secret-not-for-production-use-min-32-chars',
      MASTER_ENCRYPTION_KEY: 'test-only-throwaway-key-not-a-real-secret-value',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
