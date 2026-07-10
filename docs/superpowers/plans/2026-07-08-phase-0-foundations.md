# Phase 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-risk the two hard things in herbe.service before Phase 1 feature work starts — offline sync and ERP mapping — by shipping a deployed, TDD-covered walking skeleton (PWA shell, Auth.js login, one ERP register pull, offline display, one outbox round-trip, one Vercel cron job) plus the test infrastructure and provisioning tooling every later phase depends on.

**Architecture:** Next.js 16 App Router app on Vercel, Supabase Postgres (Drizzle ORM) + Supabase Storage, Auth.js v5 for auth, one ERP adapter (Standard Books/Excellent Books, reused from herbe.portal's `lib/erp/` framework) behind a neutral `@herbe/erp-core` contract, offline-first PWA (Workbox + Dexie/IndexedDB) syncing via delta pull + append-only outbox. herbe-service is currently docs-only (`/Users/elviskvalbergs/AI/herbe-service`) — every task in this plan creates code that does not yet exist.

**Tech Stack:** Next.js ^16.2.4, React ^19.0.0, TypeScript ^5.7.3, Tailwind ^4.2.4, Drizzle ORM ^0.44.6 + drizzle-kit ^0.31.10 (`drizzle-orm/postgres-js` + `postgres` driver — Supabase's documented pairing; differs from both siblings, see Global Constraints), next-auth `5.0.0-beta.31`, next-intl ^4.9.1, Zod ^3.24.1, Vitest ^3.0.0 + `@vitest/coverage-v8`, `@playwright/test` ^1.49.1, pnpm workspaces (portal's package manager; needed here because `@herbe/erp-core` is a real internal package, unlike either sibling).

## Global Constraints

- **Coverage gate** (`15-testing-strategy.md`): ≥90% lines/branches on core-logic packages (`packages/erp-core/**`, `lib/erp/**`, `lib/sync/**`, state machines, mappers, projector); ≥80% overall. CI blocks merge on red. "Coverage is a floor, not a target — the real gate is every spec rule has a suite."
- **Design rule enforced in review** (`15-testing-strategy.md`): no business rule may live inside an HTTP handler, cron route, or React component — handlers translate, modules decide.
- **TDD**: every behavior lands as a failing test before implementation; bug fixes start with the reproducing regression test.
- **EU-hosted**: Vercel `fra1` + Supabase EU (Frankfurt) region pinning, verbatim from `03-architecture.md`.
- **Multi-tenancy**: `tenant_id` scopes every domain table; `erp_company_id` additionally scopes ERP-adjacent tables (a tenant may have several ERP company connections). No Postgres RLS in Phase 0 — tenant isolation is query-code discipline (calendar pattern), RLS is optional hardening later.
- **Supabase = Postgres + Storage only** (`03-architecture.md`, verbatim): **no Supabase Auth, no Edge Functions, no Realtime dependency.** Auth is Auth.js v5 exclusively.
- **Vercel cron limits**: 1-minute floor, one schedule per route. All sync cadences fan out from a single `/api/cron/sync-tick` dispatcher, never per-register cron entries.
- **Cron auth/locking**: `Bearer ${CRON_SECRET}` (constant-time compare) + **table-based lock**, never Postgres advisory locks — Supabase's pooler doesn't reliably hold them across pooled connections (same reason herbe.calendar moved off them on Neon).
- **`TEST_AUTH=1`** lives in Preview and staging env vars only, never Production. Double-guarded (env flag + non-production check) and excluded from production builds.
- **i18n**: 7 locales `lv, en, et, lt, fi, sv, no`; default `lv`.
- **Device sessions**: 24h rolling / 30-day absolute cap enforced manually against JWT `iat` (Auth.js has no native absolute-expiry knob), plus a `session_version` counter for revocation.
- **`updates_after` is per-company and only works on base registers carrying `UUID` + `ServerSequence`** (confirmed: `CUVc`). **`deletes_after` is confirmed unreliable everywhere** (HTTP 204 empty body even on `CUVc`) — never build correctness on it.
- **WebExcellentAPI is Basic-auth-only, HTTP/1.1-only** (403s on HTTP/2) — any client hitting it needs `undici` with `allowH2:false`.
- No placeholders, no speculative abstractions: build exactly what each task needs, nothing "for later."

---

## Test Database Harness (decided 2026-07-09 — supersedes Testcontainers in every DB task)

Docker is unavailable in the dev environment, so **Testcontainers is NOT used anywhere**. Every DB-backed test instead gets an isolated, freshly-migrated database on a real Postgres server via a shared helper. This works identically locally (a throwaway Homebrew Postgres 17 cluster on port 55432) and in CI (a `postgres` service). Wherever a task below shows `new PostgreSqlContainer('postgres:16-alpine').start()` and `container.getConnectionUri()`, use this helper instead.

**Helper — `lib/test-support/db.ts`** (built in Task 4, imported by every later DB task):

```typescript
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

export interface TestDatabase {
  url: string
  cleanup: () => Promise<void>
}

/**
 * Creates a uniquely-named, empty database on the server pointed at by
 * TEST_DATABASE_URL and returns its connection URL + a cleanup that drops it.
 * Caller runs migrations against `url` and must close its own connections
 * before calling cleanup(). No Docker: the server is a real local/CI Postgres.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = process.env.TEST_DATABASE_URL
  if (!base) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the local test Postgres and set it in .env.test, ' +
        'e.g. postgres://postgres@localhost:55432/postgres (see docs/testing/README.md).',
    )
  }
  const name = `herbe_test_${randomUUID().replace(/-/g, '')}`
  const admin = postgres(base, { max: 1 })
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const url = base.replace(/\/[^/]+(\?.*)?$/, `/${name}$1`)
  return {
    url,
    cleanup: async () => {
      const a = postgres(base, { max: 1 })
      try {
        await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      } finally {
        await a.end({ timeout: 5 })
      }
    },
  }
}
```

**Standard per-suite pattern** (replaces the Testcontainers `beforeAll`/`afterAll` boilerplate in every DB task):

```typescript
import { afterAll, beforeAll } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })   // close our own connections BEFORE dropping
  await testDb?.cleanup()
})
```

**Env loading:** a Vitest setup file `vitest.setup.ts` (`import { config } from 'dotenv'; config({ path: '.env.test' })`) wired via `test.setupFiles` in `vitest.config.ts` loads `TEST_DATABASE_URL` from the gitignored `.env.test`. Add `dotenv` as a devDependency. `.env.test` holds `TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres` locally (already created; gitignored).

**`lib/test-support/**` is excluded from coverage** (it is test infrastructure, not shipped logic) — add `'lib/test-support/**'` to `coverage.exclude` in `vitest.config.ts`.

**CI:** the `ci` workflow (Task 2) gains a `services: postgres:17` container and sets `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` for the test step (wired in Task 4; validated on the first authenticated PR run alongside the deferred `gh` items). No Testcontainers, no Docker-in-Docker.

**`@testcontainers/postgresql` is never installed.** Any task text below that says "Install Testcontainers" or imports `@testcontainers/postgresql` is superseded by this section.

---

## Non-Code Prerequisites & Decisions (tracked, not implementation tasks)

These block or shape specific tasks below but are not something an engineer can TDD their way through. Track as a checklist; each links to the task(s) it gates.

1. **Dedicated test ERP** (`15-testing-strategy.md` §6, "the single most important item") — a test company (never production) with REST credentials, Service Orders module enabled, two reachable configs (with/without WebExcellentAPI), free create/modify/delete rights, a scripted seed dataset. **Blocks:** Task 6 (fixture recording), Task 10 (adapter live verification), Task 13 (outbox live verification), Task 21b (WSVc-native-trigger probe).
2. **One planned ERP version upgrade during Phase 0/1**, announced in advance — the only way to observe real sequence-reset behavior. **Feeds:** Task 21a's sequence-reset ADR evidence.
3. **Reference devices**: a mid-range Android phone (the <3s cold-start budget target) and a recent iPhone (PWA/Safari/camera). **Blocks:** Task 17 (airplane-mode demo).
4. **Supabase org + Vercel team access** for herbe-service (new projects, not reusing portal's/calendar's). **Blocks:** Task 1 (deployed environments), Task 18 (provisioning CLI needs real API credentials for its integration-tested paths), Task 19 (Supabase branching for previews).
5. **Sibling-team responses** to `13-suite-change-requests.md` asks (CAL-1 activity-type/state conventions, CAL-2 echo-tagging, portal-side service-module slot, SUITE-1 identity decision). Not a Phase 0 code blocker (Phase 0 doesn't touch bookings/`ActVc` writes), but Phase 1's dispatch/booking work depends on these — start the conversation during Phase 0.
6. **ADR sign-off** — Tasks 20 and 21 produce draft ADRs; the product owner needs to confirm or override each recommendation before Phase 1 relies on it.
7. Already satisfied, no action needed: design-system import (`herbe-design-system` populated, `tokens.css` canonical, `handovers/SERVICE.md` in place per roadmap); ERP register codes for the walking skeleton's registers (`CUVc`, `INVc`, `SVOVc`) already verified live against the demo ERP (`19-demo-probe-results.md`).
8. **Not a Phase 0 concern** (explicitly deferred per `06-roadmap.md` "Open items"): pricing/packaging final call, DR/rollback + tenant offboarding (Phase-1-and-later "Operations & lifecycle package").

---

## Task 1: Repo scaffolding + tooling baseline

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `next.config.ts`, `.eslintrc.json`, `postcss.config.mjs`, `tailwind.config.ts` (or CSS-first Tailwind v4 config in `app/globals.css`)
- Create: `app/layout.tsx`, `app/page.tsx`, `app/globals.css`
- Create: `app/api/health/route.ts`
- Create: `lib/db.ts`
- Create: `drizzle/schema.ts` (empty export, extended in Task 4)
- Create: `drizzle.config.ts`
- Create: `vitest.config.ts`
- Test: `__tests__/api/health.test.ts`

**Interfaces:**
- Produces: `GET /api/health` → `{ status: 'ok', ts: string }`; `lib/db.ts` exports `db` (Drizzle instance) and `sql` (raw `postgres` client) built from `process.env.DATABASE_URL`.

- [ ] **Step 1: Scaffold the Next.js app**

```bash
cd /Users/elviskvalbergs/AI/herbe-service
pnpm dlx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir=false --import-alias "@/*" --use-pnpm --no-git
```

When prompted, decline Turbopack-specific extras that don't match the sibling apps' config; the result should give App Router (`app/`), TypeScript, Tailwind v4, ESLint.

- [ ] **Step 2: Pin exact dependency versions matching the sibling apps**

```bash
pnpm add next@^16.2.4 react@^19.0.0 react-dom@^19.0.0
pnpm add -D typescript@^5.7.3 tailwindcss@^4.2.4 @tailwindcss/postcss@^4.2.4
pnpm add drizzle-orm@^0.44.6 postgres@^3.4.5
pnpm add -D drizzle-kit@^0.31.10
pnpm add zod@^3.24.1
pnpm add -D vitest@^3.0.0 @vitest/coverage-v8@^3.0.0 @vitejs/plugin-react@^4.3.4
pnpm add -D @playwright/test@^1.49.1
```

- [ ] **Step 3: Set up pnpm workspace root (for the `@herbe/erp-core` package added in Task 5)**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - '.'
  - 'packages/*'
```

- [ ] **Step 4: Add `lib/db.ts` — the Drizzle client**

```typescript
// lib/db.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/drizzle/schema'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL must be set')
}

export const sql = postgres(connectionString, { prepare: false })
export const db = drizzle(sql, { schema })
```

- [ ] **Step 5: Add empty schema and drizzle config**

```typescript
// drizzle/schema.ts
// Extended in Task 4 (tenancy) onward. Intentionally empty here.
export {}
```

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './drizzle/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
```

- [ ] **Step 6: Write the failing test for the health route**

```typescript
// __tests__/api/health.test.ts
import { describe, expect, it } from 'vitest'
import { GET } from '@/app/api/health/route'

describe('GET /api/health', () => {
  it('returns status ok with a timestamp', async () => {
    const res = await GET()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(typeof body.ts).toBe('string')
  })
})
```

- [ ] **Step 7: Run the test, confirm it fails**

Run: `pnpm vitest run __tests__/api/health.test.ts`
Expected: FAIL — `Cannot find module '@/app/api/health/route'`

- [ ] **Step 8: Implement the health route**

```typescript
// app/api/health/route.ts
export async function GET() {
  return Response.json({ status: 'ok', ts: new Date().toISOString() })
}
```

- [ ] **Step 9: Add `vitest.config.ts` with the alias and coverage provider**

```typescript
// vitest.config.ts
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
    },
  },
})
```

- [ ] **Step 10: Run the test, confirm it passes**

Run: `pnpm vitest run __tests__/api/health.test.ts`
Expected: PASS

- [ ] **Step 11: Add `package.json` scripts**

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "node scripts/migrate.mjs"
  }
}
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 16 app with Drizzle, Vitest, pnpm workspace"
```

---

## Task 2: CI pipeline with TDD coverage gates

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` from Task 1.
- Produces: a CI check named `ci` that blocks merge on lint/typecheck/test failure or coverage-threshold breach.

- [ ] **Step 1: Set the coverage thresholds in `vitest.config.ts`**

The floors from Global Constraints (≥80% overall, ≥90% on the core-logic dirs) must measure **authored application logic**, not generated scaffolding, config files, declarative Drizzle schema, or the pre-existing docs tooling. Without an explicit `coverage.include`, Vitest's v8 provider counts every file in the repo at 0% and the gate fails unconditionally before any real code exists (discovered during implementation 2026-07-09). Scope it:

```typescript
// vitest.config.ts (extend the test.coverage block from Task 1)
coverage: {
  provider: 'v8',
  reporter: ['text', 'lcov'],
  // Measure authored logic only. Generated Next.js boilerplate (root layout,
  // the create-next-app demo page — replaced by real UI in Task 16), config
  // files, declarative Drizzle schema (exercised by Testcontainers integration
  // tests from Task 4, not unit tests), and the pre-existing docs script are
  // not unit-test targets and would otherwise sink the floor to ~0%.
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
  ],
  thresholds: {
    lines: 80,
    branches: 80,
    functions: 80,
    statements: 80,
    // Core-logic dirs held to 90%. These globs match zero files until Tasks
    // 5/10/11 create them; keep an entry here ONLY if Vitest tolerates a
    // zero-match threshold glob without erroring — if it errors on the empty
    // match, remove the not-yet-existing entries and the task that creates
    // each dir re-adds its own 90% entry.
    'lib/erp/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
    'packages/erp-core/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
    'lib/sync/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
  },
},
```

The one measured file with no test after Task 1 is `lib/db.ts`. Add a real behavioral test for it (it has two branches worth verifying) so the floor passes on genuine coverage, not by exclusion:

```typescript
// __tests__/lib/db.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('lib/db', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('throws when DATABASE_URL is unset', async () => {
    vi.stubEnv('DATABASE_URL', '')
    await expect(import('@/lib/db')).rejects.toThrow('DATABASE_URL must be set')
  })

  it('constructs the sql client and drizzle db when DATABASE_URL is set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/testdb')
    const mod = await import('@/lib/db')
    expect(mod.sql).toBeDefined()
    expect(mod.db).toBeDefined()
  })
})
```

- [ ] **Step 2: Write the workflow**

```yaml
# .github/workflows/ci.yml
name: ci
on:
  pull_request:
  push:
    branches: [preview, main]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:coverage
```

- [ ] **Step 3: Verify the gate actually blocks red — break the health test on purpose**

```bash
git checkout -b ci-gate-check
```

Temporarily change `expect(body.status).toBe('ok')` to `expect(body.status).toBe('broken')` in `__tests__/api/health.test.ts`, push the branch, open a throwaway PR, confirm the `ci` check fails red.

- [ ] **Step 4: Revert the intentional break, confirm the gate goes green**

```bash
git checkout __tests__/api/health.test.ts
git push
```

Expected: `ci` check passes.

- [ ] **Step 5: Delete the throwaway branch/PR, commit the workflow on the real branch**

```bash
git checkout preview
git add .github/workflows/ci.yml vitest.config.ts
git commit -m "ci: add lint/typecheck/coverage gate, verified it blocks red"
git branch -D ci-gate-check
```

---

## Task 3: i18n scaffolding (next-intl, 7 locales)

**Files:**
- Create: `lib/i18n/config.ts`, `lib/i18n/request.ts`
- Create: `locales/lv.json`, `locales/en.json`, `locales/et.json`, `locales/lt.json`, `locales/fi.json`, `locales/sv.json`, `locales/no.json`
- Modify: `middleware.ts` (create — locale-cookie forwarding, portal pattern)
- Modify: `next.config.ts` (wrap with `createNextIntlPlugin`)
- Test: `__tests__/i18n/config.test.ts`

**Interfaces:**
- Produces: `locales: readonly ['lv','en','et','lt','fi','sv','no']`, `defaultLocale: 'lv'`, `isLocale(x: string): x is Locale`.

- [ ] **Step 1: Install next-intl**

```bash
pnpm add next-intl@^4.9.1
```

- [ ] **Step 2: Write the failing test for locale config**

```typescript
// __tests__/i18n/config.test.ts
import { describe, expect, it } from 'vitest'
import { defaultLocale, isLocale, locales } from '@/lib/i18n/config'

describe('i18n config', () => {
  it('exposes exactly the suite\'s 7 locales', () => {
    expect(locales).toEqual(['lv', 'en', 'et', 'lt', 'fi', 'sv', 'no'])
  })

  it('defaults to lv', () => {
    expect(defaultLocale).toBe('lv')
  })

  it('rejects an unknown locale', () => {
    expect(isLocale('de')).toBe(false)
    expect(isLocale('lv')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `pnpm vitest run __tests__/i18n/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `lib/i18n/config.ts`**

```typescript
// lib/i18n/config.ts
export const locales = ['lv', 'en', 'et', 'lt', 'fi', 'sv', 'no'] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = 'lv'

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value)
}
```

- [ ] **Step 4: Add locale catalogs (start with the two shipped languages per Phase 0 scope — `en`, `lv` — the rest as empty scaffolds, matching `06-roadmap.md`: "translation of service strings beyond en+lv is a launch-planning item")**

```json
// locales/en.json
{}
```
Create identical empty `{}` files for `lv.json`, `et.json`, `lt.json`, `fi.json`, `sv.json`, `no.json` — content is added incrementally as UI strings ship.

- [ ] **Step 5: Add `lib/i18n/request.ts`**

```typescript
// lib/i18n/request.ts
import { getRequestConfig } from 'next-intl/server'
import { defaultLocale, isLocale } from '@/lib/i18n/config'

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = requested && isLocale(requested) ? requested : defaultLocale

  return {
    locale,
    messages: (await import(`@/locales/${locale}.json`)).default,
  }
})
```

- [ ] **Step 6: Add the locale-cookie middleware (portal pattern: cookie-based, not path-prefixed)**

```typescript
// middleware.ts
import { NextRequest, NextResponse } from 'next/server'
import { defaultLocale, isLocale } from '@/lib/i18n/config'

export function middleware(request: NextRequest) {
  const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value
  const locale = cookieLocale && isLocale(cookieLocale) ? cookieLocale : defaultLocale

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-NEXT-INTL-LOCALE', locale)

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] **Step 7: Wire the next-intl plugin into `next.config.ts`**

```typescript
// next.config.ts
import createNextIntlPlugin from 'next-intl/plugin'
import type { NextConfig } from 'next'

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts')

const nextConfig: NextConfig = {}

export default withNextIntl(nextConfig)
```

- [ ] **Step 8: Run test, confirm it passes**

Run: `pnpm vitest run __tests__/i18n/config.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add lib/i18n locales middleware.ts next.config.ts __tests__/i18n
git commit -m "feat: i18n scaffolding for the suite's 7 locales (next-intl)"
```

---

## Task 4: Database core & tenancy schema

**Files:**
- Modify: `drizzle/schema.ts`
- Create: `scripts/migrations/0001_tenancy_core.sql`
- Create: `scripts/migrate.mjs` (build-time runner, portal's `migrate-prod.mjs` pattern adapted from `@neondatabase/serverless` to `postgres`)
- Create: `app/api/admin/run-migrations/route.ts`
- Create: `lib/test-support/db.ts` (the `createTestDatabase()` helper — see "Test Database Harness" section)
- Create: `vitest.setup.ts` (loads `.env.test`); Modify: `vitest.config.ts` (`test.setupFiles`, add `lib/test-support/**` to `coverage.exclude`)
- Modify: `.github/workflows/ci.yml` (add `postgres:17` service + `TEST_DATABASE_URL` for the test step)
- Test: `__tests__/db/tenancy.test.ts` (real Postgres via the harness helper — NOT Testcontainers)

**Interfaces:**
- Produces: Drizzle tables `tenants`, `erpCompanies`, `erpSyncState`; migration runner invoked as `node scripts/migrate.mjs`, idempotent (tolerates `42710`/`42P07`/`42P06`/`42701`/`42P16`/`42704` "already exists" errors on re-run, portal's `TOLERATED` set); `createTestDatabase()` from `lib/test-support/db.ts` for all later DB tasks.

- [ ] **Step 1: Build the test-database harness (see "Test Database Harness" section for the full helper + setup-file + config code)**

Create `lib/test-support/db.ts` (the `createTestDatabase()` helper — verbatim from the harness section), `vitest.setup.ts` (loads `.env.test` via `dotenv`), add `dotenv` as a devDependency, wire `test.setupFiles: ['./vitest.setup.ts']` and add `'lib/test-support/**'` to `coverage.exclude` in `vitest.config.ts`. `@testcontainers/postgresql` is NOT installed. `.env.test` already exists locally (gitignored) with `TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres`. Confirm `TEST_DATABASE_URL` resolves in a trivial test before proceeding.

- [ ] **Step 2: Write the failing test (uses the harness helper, per the standard per-suite pattern in the harness section)**

```typescript
// __tests__/db/tenancy.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('tenancy schema', () => {
  it('scopes an erp_companies row to a tenant', async () => {
    const [tenant] = await db.insert(schema.tenants).values({ slug: 'acme', name: 'Acme FS' }).returning()

    const [company] = await db
      .insert(schema.erpCompanies)
      .values({
        tenantId: tenant.id,
        displayName: 'Acme main company',
        adapterType: 'standard_books',
        adapterConfigJson: {},
      })
      .returning()

    expect(company.tenantId).toBe(tenant.id)
  })

  it('rejects an erp_sync_state row for an unknown company (FK enforced)', async () => {
    await expect(
      db.insert(schema.erpSyncState).values({
        erpCompanyId: '00000000-0000-0000-0000-000000000000',
        register: 'CUVc',
        syncCursor: '0',
      }),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 3: Run test, confirm it fails**

Run: `pnpm vitest run __tests__/db/tenancy.test.ts`
Expected: FAIL — `schema.tenants` is undefined

- [ ] **Step 4: Implement the Drizzle schema**

```typescript
// drizzle/schema.ts
import { jsonb, pgTable, text, timestamp, uuid, boolean, integer, bigint, primaryKey } from 'drizzle-orm/pg-core'

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const erpCompanies = pgTable('erp_companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  displayName: text('display_name').notNull(),
  adapterType: text('adapter_type').notNull(), // 'standard_books' | future adapters
  adapterConfigJson: jsonb('adapter_config_json').notNull().default({}),
  apiCredsEncrypted: text('api_creds_encrypted'),
  secretVersion: integer('secret_version').notNull().default(1),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const erpSyncState = pgTable(
  'erp_sync_state',
  {
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id),
    register: text('register').notNull(), // e.g. 'CUVc', 'INVc'
    syncCursor: text('sync_cursor').notNull().default('0'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
    syncStatus: text('sync_status').notNull().default('idle'), // 'idle' | 'running' | 'error'
    errorMessage: text('error_message'),
  },
  (t) => [primaryKey({ columns: [t.erpCompanyId, t.register] })],
)
```

- [ ] **Step 5: Write the migration SQL**

```sql
-- scripts/migrations/0001_tenancy_core.sql
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  display_name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  adapter_config_json JSONB NOT NULL DEFAULT '{}',
  api_creds_encrypted TEXT,
  secret_version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp_sync_state (
  erp_company_id UUID NOT NULL REFERENCES erp_companies(id),
  register TEXT NOT NULL,
  sync_cursor TEXT NOT NULL DEFAULT '0',
  last_sync_at TIMESTAMPTZ,
  last_full_sync_at TIMESTAMPTZ,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  error_message TEXT,
  PRIMARY KEY (erp_company_id, register)
);
```

- [ ] **Step 6: Write the migration runner (adapted from portal's `migrate-prod.mjs`: swap `@neondatabase/serverless` for `postgres`, since herbe-service runs on Supabase not Neon)**

```javascript
// scripts/migrate.mjs
import postgres from 'postgres'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const TOLERATED = new Set([
  '42710', // duplicate_object
  '42P07', // duplicate_table
  '42P06', // duplicate_schema
  '42701', // duplicate_column
  '42P16', // invalid_table_definition
  '42704', // undefined_object
])

// Split a .sql file into individual statements, splitting on top-level ';' only
// — never inside '...'/"..." strings, -- line or /* */ block comments, or
// $tag$...$tag$ dollar-quoted bodies (plpgsql function bodies contain ';').
// Exported for unit testing.
export function splitSqlStatements(input) {
  const statements = []
  let cur = ''
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    if (ch === '-' && input[i + 1] === '-') {
      const nl = input.indexOf('\n', i)
      const end = nl === -1 ? n : nl
      cur += input.slice(i, end)
      i = end
      continue
    }
    if (ch === '/' && input[i + 1] === '*') {
      const close = input.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      cur += input.slice(i, end)
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      const q = ch
      cur += ch
      i++
      while (i < n) {
        cur += input[i]
        if (input[i] === q) {
          if (input[i + 1] === q) { cur += input[i + 1]; i += 2; continue } // escaped quote
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '$') {
      const m = input.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
      if (m) {
        const tag = m[0]
        const close = input.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        cur += input.slice(i, end)
        i = end
        continue
      }
    }
    if (ch === ';') {
      if (cur.trim()) statements.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) statements.push(cur.trim())
  return statements
}

export async function runMigrations(connectionString) {
  const url = connectionString ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL must be set')

  const sql = postgres(url, { prepare: false })
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS herbe_migrations`
    await sql`CREATE TABLE IF NOT EXISTS herbe_migrations.applied (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`

    const dir = path.resolve('./scripts/migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()

    for (const filename of files) {
      const content = fs.readFileSync(path.join(dir, filename), 'utf8')
      const hash = crypto.createHash('sha256').update(content).digest('hex')

      const [existing] = await sql`SELECT hash FROM herbe_migrations.applied WHERE filename = ${filename}`
      if (existing) continue

      // Execute each statement in its OWN implicit transaction. A single
      // sql.unsafe(wholeFile) call sends the file as one simple-query message,
      // which Postgres wraps in ONE implicit transaction — so a mid-file
      // tolerated "already exists" error would roll back the sibling DDL that
      // ran before AND after it, while we still marked the file applied
      // (silent DDL loss; found in Task 4 review 2026-07-09). Per-statement
      // execution keeps a tolerated error local to its own statement.
      for (const stmt of splitSqlStatements(content)) {
        try {
          await sql.unsafe(stmt)
        } catch (err) {
          if (!TOLERATED.has(err.code)) throw err
          console.warn(`[migrate] tolerated ${err.code} in ${filename}: ${err.message}`)
        }
      }

      await sql`INSERT INTO herbe_migrations.applied (filename, hash) VALUES (${filename}, ${hash})`
      console.log(`[migrate] applied ${filename}`)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations()
}
```

**Regression test (`__tests__/db/migrate.test.ts`) — encodes the Task-4-review bug so it can't recur:**
- Unit-test `splitSqlStatements`: a dollar-quoted plpgsql body with embedded `;` stays ONE statement; `;` inside a string literal and inside a `--` comment do not split.
- Integration (harness DB): apply a file with `[CREATE TABLE reg_a; CREATE TABLE reg_b; CREATE TABLE reg_c]` where `reg_b` already exists (forces a tolerated `42P07`), then assert **both `reg_a` and `reg_c` exist** afterward (siblings not lost) and the file is recorded in `herbe_migrations.applied`.
- Integration: a plpgsql migration (`CREATE SEQUENCE` + `CREATE FUNCTION ... $$ ... $$ LANGUAGE plpgsql` + `CREATE TRIGGER`) applies fully in one file; a second `runMigrations()` run is a clean no-op.

- [ ] **Step 7: Add the admin re-run route (portal pattern)**

```typescript
// app/api/admin/run-migrations/route.ts
import { timingSafeEqual } from 'node:crypto'
import { runMigrations } from '@/scripts/migrate'

// Constant-time bearer check — this route triggers schema migrations, so the
// secret compare must not leak length/prefix via timing (Task 4 review fix).
// Task 12 introduces a shared `bearerMatches` helper; adopt it there.
function authorized(request: Request): boolean {
  const secret = process.env.ADMIN_MIGRATIONS_SECRET
  if (!secret) return false
  const header = request.headers.get('authorization')
  if (!header) return false
  const expected = `Bearer ${secret}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return new Response('Unauthorized', { status: 401 })
  }

  try {
    await runMigrations()
    return Response.json({ status: 'ok' })
  } catch (err) {
    return Response.json({ status: 'error', message: String(err) }, { status: 500 })
  }
}
```

**Route test (`__tests__/api/admin/run-migrations.test.ts`):** unauthorized (missing/wrong bearer) → 401 without invoking `runMigrations`; authorized (correct bearer) → invokes `runMigrations` and returns `{status:'ok'}`. Mock `@/scripts/migrate`'s `runMigrations` so the route test doesn't need a live DB.

- [ ] **Step 8: Run test, confirm it passes**

Run: `pnpm vitest run __tests__/db/tenancy.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add drizzle scripts/migrations scripts/migrate.mjs app/api/admin/run-migrations __tests__/db
git commit -m "feat(db): tenancy core schema (tenants, erp_companies, erp_sync_state) + migration runner"
```

---

## Task 5: `@herbe/erp-core` workspace package

**Files:**
- Create: `packages/erp-core/package.json`
- Create: `packages/erp-core/src/types.ts`
- Create: `packages/erp-core/src/errors.ts`
- Create: `packages/erp-core/src/registry.ts`
- Create: `packages/erp-core/src/index.ts`
- Test: `packages/erp-core/src/registry.test.ts`

**Interfaces:**
- Produces: `ErpAdapter` interface, `AdapterCapabilities` type, `ErpTransientError`/`ErpPermanentError`/`ErpScheduledMaintenanceError` classes, `ErpAdapterFactory = (config: unknown) => ErpAdapter`, `registerAdapter(type: string, factory: ErpAdapterFactory)`, `getAdapter(type: string, config: unknown): ErpAdapter`. This is the package Task 10's Standard Books adapter implements against.
- Extracted from herbe-portal's `lib/erp/types.ts` + `lib/erp/registry.ts` — trimmed to the neutral contract only (no Standard-Books-specific fields), per `08-suite-integration.md` reuse decision: "extract only `@herbe/erp-core`."

- [ ] **Step 1: Scaffold the package**

```bash
mkdir -p packages/erp-core/src
```

```json
// packages/erp-core/package.json
{
  "name": "@herbe/erp-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "test": "vitest run"
  }
}
```

Add to root `package.json` dependencies: `"@herbe/erp-core": "workspace:*"`.

- [ ] **Step 2: Write the failing test for the registry**

```typescript
// packages/erp-core/src/registry.test.ts
import { describe, expect, it } from 'vitest'
import { getAdapter, registerAdapter } from './registry'
import type { ErpAdapter } from './types'

describe('erp adapter registry', () => {
  it('returns the adapter a factory was registered for', () => {
    const fakeAdapter = { capabilities: () => ({ supportsIncrementalSync: true }) } as unknown as ErpAdapter
    registerAdapter('fake_erp', () => fakeAdapter)

    expect(getAdapter('fake_erp', {})).toBe(fakeAdapter)
  })

  it('throws a clear error for an unregistered adapter type', () => {
    expect(() => getAdapter('nonexistent', {})).toThrow('No ERP adapter registered for type "nonexistent"')
  })
})
```

- [ ] **Step 3: Run test, confirm it fails**

Run: `pnpm --filter @herbe/erp-core test`
Expected: FAIL — `./registry` not found

- [ ] **Step 4: Define the neutral contract**

```typescript
// packages/erp-core/src/types.ts
export interface AdapterCapabilities {
  supportsIncrementalSync: boolean
  supportsDeletesFeed: boolean
  // Neutral name — the generic engine gates rendered-document/attachment fetch on this.
  // HansaWorld backs it via WebExcellentAPI presence, but that vendor detail stays in the
  // Standard Books adapter (Task 10), never in the neutral contract name (2026-07-09 review fix).
  supportsDocumentFetch: boolean
  supportsInvoiceStatusReadback: boolean
  supportsActivityMirror: boolean
}

export interface ChangeSet<T> {
  upserts: T[]
  deletedRefs: string[]
  cursor: string
}

export interface ErpAdapter {
  capabilities(): AdapterCapabilities
  pullChanges(register: string, sinceCursor: string): Promise<ChangeSet<Record<string, unknown>>>
  pushCreate(register: string, payload: Record<string, unknown>): Promise<{ erpRef: string }>
  probeIncrementalSupport(register: string): Promise<boolean>
}

export type ErpAdapterFactory = (config: unknown) => ErpAdapter
```

- [ ] **Step 5: Define the typed error hierarchy**

```typescript
// packages/erp-core/src/errors.ts
export class ErpAdapterError extends Error {}

export class ErpTransientError extends ErpAdapterError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'ErpTransientError'
  }
}

export class ErpPermanentError extends ErpAdapterError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'ErpPermanentError'
  }
}

export class ErpScheduledMaintenanceError extends ErpAdapterError {
  constructor(message = 'ERP is in a scheduled maintenance window') {
    super(message)
    this.name = 'ErpScheduledMaintenanceError'
  }
}
```

- [ ] **Step 6: Implement the registry**

```typescript
// packages/erp-core/src/registry.ts
import type { ErpAdapter, ErpAdapterFactory } from './types'

const adapters = new Map<string, ErpAdapterFactory>()

export function registerAdapter(type: string, factory: ErpAdapterFactory): void {
  adapters.set(type, factory)
}

export function getAdapter(type: string, config: unknown): ErpAdapter {
  const factory = adapters.get(type)
  if (!factory) {
    throw new Error(`No ERP adapter registered for type "${type}"`)
  }
  return factory(config)
}
```

- [ ] **Step 7: Add the barrel export**

```typescript
// packages/erp-core/src/index.ts
export * from './types'
export * from './errors'
export * from './registry'
```

- [ ] **Step 8: Run test, confirm it passes**

Run: `pnpm --filter @herbe/erp-core test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/erp-core package.json pnpm-lock.yaml
git commit -m "feat: @herbe/erp-core neutral adapter contract, extracted from herbe.portal's lib/erp/types.ts"
```

---

## Task 6: Fake ERP server + fixture recorder

**Files:**
- Create: `packages/fake-erp/package.json`
- Create: `packages/fake-erp/src/server.ts`
- Create: `packages/fake-erp/src/fixtures/cuvc.json` (recorded/anonymized from the test ERP once Prerequisite 1 is available; ships with a hand-written stand-in until then)
- Create: `packages/fake-erp/src/handlers/register.ts`
- Test: `packages/fake-erp/src/server.test.ts`

**Interfaces:**
- Produces: `startFakeErpServer(opts: { port: number }): Promise<{ url: string; close: () => Promise<void> }>`. Simulates `GET /api/:company/:register` with `updates_after`, `offset`/`limit`, and register-specific quirks (`SVOVc`/`WSVc` reject `updates_after` with 404; `deletes_after` returns 204 empty everywhere).

- [ ] **Step 1: Scaffold the package**

```bash
mkdir -p packages/fake-erp/src/handlers packages/fake-erp/src/fixtures
```

```json
// packages/fake-erp/package.json
{
  "name": "@herbe/fake-erp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": { "hono": "^4.6.0" },
  "scripts": { "test": "vitest run" }
}
```

```bash
pnpm add -D hono --filter @herbe/fake-erp
```

- [ ] **Step 2: Add the seed fixture (hand-authored stand-in; replaced by a real recorded+anonymized export from the test ERP once available)**

```json
// packages/fake-erp/src/fixtures/cuvc.json
[
  { "Code": "CUST001", "Name": "Test Client OÜ", "UUID": "a1b2c3d4-0001", "ServerSequence": 1001 },
  { "Code": "CUST002", "Name": "Another Client SIA", "UUID": "a1b2c3d4-0002", "ServerSequence": 1002 }
]
```

- [ ] **Step 3: Write the failing test**

```typescript
// packages/fake-erp/src/server.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeErpServer } from './server'

let server: Awaited<ReturnType<typeof startFakeErpServer>>

beforeAll(async () => {
  server = await startFakeErpServer({ port: 0 })
})

afterAll(async () => {
  await server.close()
})

describe('fake ERP server', () => {
  it('returns CUVc rows with @sequence as the high-water mark', async () => {
    const res = await fetch(`${server.url}/api/1/CUVc?updates_after=0`)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.length).toBe(2)
    expect(body['@sequence']).toBe(1002)
  })

  it('rejects updates_after on SVOVc with 404, matching the confirmed real-ERP behavior', async () => {
    const res = await fetch(`${server.url}/api/1/SVOVc?updates_after=0`)
    expect(res.status).toBe(404)
  })

  it('returns 204 empty body for deletes_after on any register (confirmed unreliable)', async () => {
    const res = await fetch(`${server.url}/api/1/CUVc?deletes_after=0`)
    expect(res.status).toBe(204)
  })
})
```

- [ ] **Step 4: Run test, confirm it fails**

Run: `pnpm --filter @herbe/fake-erp test`
Expected: FAIL — `./server` not found

- [ ] **Step 5: Implement the register handler**

```typescript
// packages/fake-erp/src/handlers/register.ts
import type { Context } from 'hono'
import cuvcFixture from '../fixtures/cuvc.json' with { type: 'json' }

const NO_UPDATES_AFTER = new Set(['SVOVc', 'WSVc'])
const FIXTURES: Record<string, Array<{ ServerSequence: number }>> = {
  CUVc: cuvcFixture,
}

export function handleRegisterGet(c: Context) {
  const register = c.req.param('register')
  const updatesAfter = c.req.query('updates_after')
  const deletesAfter = c.req.query('deletes_after')

  if (deletesAfter !== undefined) {
    return c.body(null, 204)
  }

  if (updatesAfter !== undefined && NO_UPDATES_AFTER.has(register)) {
    return c.json({ error: 'not supported for this register' }, 404)
  }

  const rows = FIXTURES[register] ?? []
  const sequence = rows.length ? Math.max(...rows.map((r) => r.ServerSequence)) : 0

  return c.json({ data: rows, '@sequence': sequence })
}
```

- [ ] **Step 6: Implement the server**

```typescript
// packages/fake-erp/src/server.ts
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { handleRegisterGet } from './handlers/register'

export async function startFakeErpServer(opts: { port: number }) {
  const app = new Hono()
  app.get('/api/:company/:register', handleRegisterGet)

  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
```

```bash
pnpm add @hono/node-server --filter @herbe/fake-erp
```

- [ ] **Step 7: Run test, confirm it passes**

Run: `pnpm --filter @herbe/fake-erp test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/fake-erp package.json pnpm-lock.yaml
git commit -m "feat: fake ERP server simulating confirmed updates_after/deletes_after quirks"
```

*(Note: the nightly live-contract job that replays this same suite against the real test ERP, per `15-testing-strategy.md`, is a CI/ops task that depends on Prerequisite 1 — track separately once the test ERP exists; don't block this task on it.)*

---

## Task 7: Seed engine + golden-fixture library

**Files:**
- Create: `lib/seed/index.ts`
- Create: `lib/seed/personas.ts`
- Create: `lib/seed/scenarios/baseline.ts`
- Create: `packages/erp-core/src/testing/golden-fixtures.ts`
- Test: `lib/seed/personas.test.ts`, `lib/seed/scenarios/baseline.test.ts`

**Interfaces:**
- Produces: `PERSONAS: Record<'tech'|'lead'|'dispatch'|'office'|'admin', Persona>` (stable UUID + email per role, `15-testing-strategy.md` naming: `tech.anna@…`, `lead.bruno@…`, `dispatch.dace@…`, `office.eva@…`, `admin.karlis@…`); `seedBaseline(db): Promise<void>` — deterministic (seeded faker), byte-identical output per run.

- [ ] **Step 1: Install seeded faker**

```bash
pnpm add -D @faker-js/faker
```

- [ ] **Step 2: Write the failing personas test**

```typescript
// lib/seed/personas.test.ts
import { describe, expect, it } from 'vitest'
import { PERSONAS } from './personas'

describe('fixed test personas', () => {
  it('has a stable UUID and email per role', () => {
    expect(PERSONAS.tech.email).toBe('tech.anna@herbe-service.test')
    expect(PERSONAS.lead.email).toBe('lead.bruno@herbe-service.test')
    expect(PERSONAS.dispatch.email).toBe('dispatch.dace@herbe-service.test')
    expect(PERSONAS.office.email).toBe('office.eva@herbe-service.test')
    expect(PERSONAS.admin.email).toBe('admin.karlis@herbe-service.test')
  })

  it('every persona id is a stable, hardcoded UUID (not generated at runtime)', () => {
    const ids = Object.values(PERSONAS).map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    }
  })
})
```

- [ ] **Step 3: Run test, confirm it fails**

Run: `pnpm vitest run lib/seed/personas.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement personas**

```typescript
// lib/seed/personas.ts
export interface Persona {
  id: string
  email: string
  role: 'technician' | 'team_lead' | 'dispatcher' | 'back_office' | 'admin'
}

export const PERSONAS = {
  tech: { id: '00000000-0000-0000-0000-000000000001', email: 'tech.anna@herbe-service.test', role: 'technician' },
  lead: { id: '00000000-0000-0000-0000-000000000002', email: 'lead.bruno@herbe-service.test', role: 'team_lead' },
  dispatch: { id: '00000000-0000-0000-0000-000000000003', email: 'dispatch.dace@herbe-service.test', role: 'dispatcher' },
  office: { id: '00000000-0000-0000-0000-000000000004', email: 'office.eva@herbe-service.test', role: 'back_office' },
  admin: { id: '00000000-0000-0000-0000-000000000005', email: 'admin.karlis@herbe-service.test', role: 'admin' },
  // second-tenant + no-company-access personas for negative access tests:
  otherTenantAdmin: { id: '00000000-0000-0000-0000-000000000006', email: 'admin.otherTenant@herbe-service.test', role: 'admin' },
  noCompanyAccess: { id: '00000000-0000-0000-0000-000000000007', email: 'noaccess@herbe-service.test', role: 'back_office' },
} as const satisfies Record<string, Persona>
```

- [ ] **Step 5: Run test, confirm it passes**

Run: `pnpm vitest run lib/seed/personas.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing baseline scenario test**

```typescript
// lib/seed/scenarios/baseline.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { seedBaseline } from './baseline'

let container: StartedPostgreSqlContainer
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  await runMigrations(container.getConnectionUri())
  db = drizzle(postgres(container.getConnectionUri()), { schema })
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('baseline seed scenario', () => {
  it('creates 2 tenants and is byte-identical across two runs', async () => {
    await seedBaseline(db)
    const firstRun = await db.select().from(schema.tenants)

    await db.delete(schema.erpCompanies)
    await db.delete(schema.tenants)
    await seedBaseline(db)
    const secondRun = await db.select().from(schema.tenants)

    expect(firstRun).toEqual(secondRun)
    expect(firstRun.length).toBe(2)
  })
})
```

- [ ] **Step 7: Run test, confirm it fails**

Run: `pnpm vitest run lib/seed/scenarios/baseline.test.ts`
Expected: FAIL — `./baseline` not found

- [ ] **Step 8: Implement the baseline scenario with a seeded faker instance**

```typescript
// lib/seed/scenarios/baseline.ts
import { Faker, en } from '@faker-js/faker'
import * as schema from '@/drizzle/schema'
import type { db as DbType } from '@/lib/db'

const faker = new Faker({ locale: [en] })

export async function seedBaseline(db: typeof DbType) {
  faker.seed(42) // fixed seed → deterministic, byte-identical output every run

  const tenantIds = ['11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000002']

  for (const id of tenantIds) {
    await db.insert(schema.tenants).values({
      id,
      slug: faker.helpers.slugify(faker.company.name()).toLowerCase(),
      name: faker.company.name(),
    })
  }
}
```

- [ ] **Step 9: Run test, confirm it passes**

Run: `pnpm vitest run lib/seed/scenarios/baseline.test.ts`
Expected: PASS

- [ ] **Step 10: Add the golden-fixture accessor (mapper tests read fixtures through this, not raw `fs.readFileSync`, so the source is swappable later)**

```typescript
// packages/erp-core/src/testing/golden-fixtures.ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const FIXTURES_DIR = path.resolve(fileURLToPath(import.meta.url), '../../../fixtures')

export function loadGoldenFixture<T>(register: string): T {
  const filePath = path.join(FIXTURES_DIR, `${register.toLowerCase()}.json`)
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}
```

```bash
mkdir -p packages/erp-core/fixtures
cp packages/fake-erp/src/fixtures/cuvc.json packages/erp-core/fixtures/cuvc.json
```

- [ ] **Step 11: Commit**

```bash
git add lib/seed packages/erp-core/src/testing packages/erp-core/fixtures package.json
git commit -m "feat: deterministic seed engine (baseline scenario + fixed personas) and golden-fixture loader"
```

*(Note: `sync-edge`, `volume`, and `empty` scenario packs from `15-testing-strategy.md` follow the same `seedBaseline` shape — add them as their own tasks once the domain tables they seed exist, from Task 11 onward. Building all four now would seed tables that don't exist yet.)*

---

## Task 8: Guarded test-login

**Files:**
- Create: `lib/auth/test-provider.ts`
- Create: `app/api/test/login/route.ts`
- Test: `lib/auth/test-provider.test.ts`

**Interfaces:**
- Produces: `isTestAuthEnabled(): boolean` (double guard: `process.env.TEST_AUTH === '1'` AND `process.env.VERCEL_ENV !== 'production'` AND `process.env.NODE_ENV !== 'production'`); `POST /api/test/login` body `{ personaKey: keyof typeof PERSONAS }` → mints a session, `403` if `isTestAuthEnabled()` is false.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/auth/test-provider.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTestAuthEnabled } from './test-provider'

describe('isTestAuthEnabled', () => {
  const original = { ...process.env }

  beforeEach(() => {
    process.env = { ...original }
  })

  afterEach(() => {
    process.env = original
  })

  it('is false when TEST_AUTH is unset', () => {
    delete process.env.TEST_AUTH
    expect(isTestAuthEnabled()).toBe(false)
  })

  it('is false in production even if TEST_AUTH=1 (double guard)', () => {
    process.env.TEST_AUTH = '1'
    process.env.VERCEL_ENV = 'production'
    expect(isTestAuthEnabled()).toBe(false)
  })

  it('is false when NODE_ENV=production even without VERCEL_ENV', () => {
    process.env.TEST_AUTH = '1'
    delete process.env.VERCEL_ENV
    process.env.NODE_ENV = 'production'
    expect(isTestAuthEnabled()).toBe(false)
  })

  it('is true on preview with TEST_AUTH=1', () => {
    process.env.TEST_AUTH = '1'
    process.env.VERCEL_ENV = 'preview'
    process.env.NODE_ENV = 'test'
    expect(isTestAuthEnabled()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `pnpm vitest run lib/auth/test-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the guard**

```typescript
// lib/auth/test-provider.ts
export function isTestAuthEnabled(): boolean {
  if (process.env.TEST_AUTH !== '1') return false
  if (process.env.VERCEL_ENV === 'production') return false
  if (process.env.NODE_ENV === 'production') return false
  return true
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `pnpm vitest run lib/auth/test-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the guarded route (depends on Task 14's Auth.js session-minting helper — stub the mint call until Task 14 lands, replace with the real `signIn` call there)**

```typescript
// app/api/test/login/route.ts
import { isTestAuthEnabled } from '@/lib/auth/test-provider'
import { PERSONAS } from '@/lib/seed/personas'

export async function POST(request: Request) {
  if (!isTestAuthEnabled()) {
    return new Response('Not found', { status: 404 })
  }

  const { personaKey } = (await request.json()) as { personaKey: keyof typeof PERSONAS }
  const persona = PERSONAS[personaKey]
  if (!persona) {
    return Response.json({ error: 'unknown persona' }, { status: 400 })
  }

  // TODO(Task 14): replace with a real Auth.js session mint once the auth config exists.
  throw new Error('Not implemented until Task 14 (Auth.js magic-link config) lands')
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/auth/test-provider.ts lib/auth/test-provider.test.ts app/api/test/login
git commit -m "feat: double-guarded TEST_AUTH flag (env + non-production check)"
```

*(This task's route body is finished in Task 14, Step 7, once the real Auth.js session-minting mechanism exists — right-sized here as "prove the guard is airtight," which is independently testable without auth wired up yet.)*

---

## Task 9: Sync simulation harness

**Files:**
- Create: `lib/sync/simulation/virtual-device.ts`
- Create: `lib/sync/simulation/scenarios/offline-day-replay.test.ts`

**Interfaces:**
- Produces: `class VirtualDevice { pull(sinceCursor: string): Promise<void>; queueOp(op: OutboxOp): void; replay(): Promise<void>; localStore: Map<string, unknown> }` — an in-process client with its own local store + outbox, run against a real server route handler + Testcontainers Postgres.
- Consumes: the domain delta endpoint from Task 12 and the outbox endpoint from Task 13 — **this task's full scenario suite is written now but only exercises the "offline-a-day-then-replay" scenario once those two tasks exist.** Build the harness shape now (test infra "built before the features that need them," per roadmap); wire in the remaining scripted scenarios (crew-job non-interference, scope-exit purge, sequence-reset-mid-poll) as each depends on Phase 1 entities that don't exist yet — track those as follow-on tasks, not part of Phase 0.

- [ ] **Step 1: Write the failing test for the harness shape**

```typescript
// lib/sync/simulation/scenarios/offline-day-replay.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { VirtualDevice } from '../virtual-device'

let container: StartedPostgreSqlContainer

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  await runMigrations(container.getConnectionUri())
  process.env.DATABASE_URL = container.getConnectionUri()
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('virtual device offline-then-replay', () => {
  it('queues ops while offline and applies them in order on replay', async () => {
    const device = new VirtualDevice({ tenantId: '11111111-0000-0000-0000-000000000001' })

    device.queueOp({ id: 'op-1', entity: 'note', op: 'create', payload: { text: 'first' }, baseVersion: 0 })
    device.queueOp({ id: 'op-2', entity: 'note', op: 'create', payload: { text: 'second' }, baseVersion: 0 })

    expect(device.pendingOps.length).toBe(2)

    const applied = await device.replay()

    expect(applied.map((a) => a.id)).toEqual(['op-1', 'op-2'])
    expect(device.pendingOps.length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `pnpm vitest run lib/sync/simulation/scenarios/offline-day-replay.test.ts`
Expected: FAIL — `../virtual-device` not found

- [ ] **Step 3: Implement the virtual device**

```typescript
// lib/sync/simulation/virtual-device.ts
export interface OutboxOp {
  id: string
  entity: string
  op: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
  baseVersion: number
}

export class VirtualDevice {
  readonly tenantId: string
  readonly localStore = new Map<string, unknown>()
  readonly pendingOps: OutboxOp[] = []

  constructor(opts: { tenantId: string }) {
    this.tenantId = opts.tenantId
  }

  queueOp(op: OutboxOp): void {
    this.pendingOps.push(op)
  }

  async replay(): Promise<OutboxOp[]> {
    const applied: OutboxOp[] = []
    while (this.pendingOps.length > 0) {
      const op = this.pendingOps.shift()!
      // Phase 0: applies to the in-memory local store only, proving ordering.
      // Task 13's real outbox endpoint is wired in once it exists — this
      // harness intentionally doesn't call the network yet.
      this.localStore.set(op.id, op.payload)
      applied.push(op)
    }
    return applied
  }

  async pull(_sinceCursor: string): Promise<void> {
    // Wired to the real delta endpoint (Task 12) in the follow-on scenario tasks.
  }
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `pnpm vitest run lib/sync/simulation/scenarios/offline-day-replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/sync/simulation
git commit -m "feat: sync simulation harness — virtual device with offline queue + ordered replay"
```

---

## Task 10: Standard Books adapter — Customers (`CUVc`) + Items (`INVc`) incremental fetch

**Files:**
- Create: `lib/erp/standard-books/fetch-json.ts` (session/auth layer, adapted from portal's `cache/fetch-json.ts`)
- Create: `lib/erp/standard-books/adapter.ts`
- Create: `lib/erp/standard-books/config-schema.ts`
- Test: `lib/erp/standard-books/adapter.test.ts` (against Task 6's fake ERP server)

**Interfaces:**
- Consumes: `ErpAdapter`, `ChangeSet`, `ErpTransientError`, `ErpPermanentError` from `@herbe/erp-core` (Task 5); `registerAdapter` from the same package.
- Produces: `createStandardBooksAdapter(config: StandardBooksConfig): ErpAdapter`, registered under type `standard_books`. `pullChanges('CUVc', cursor)` returns `{ upserts, deletedRefs: [], cursor }` (empty `deletedRefs` — `deletes_after` is confirmed unreliable, so Task 11's key-sweep is the only deletion source, never this method).

- [ ] **Step 1: Write the failing test**

```typescript
// lib/erp/standard-books/adapter.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeErpServer } from '@herbe/fake-erp'
import { createStandardBooksAdapter } from './adapter'

let server: Awaited<ReturnType<typeof startFakeErpServer>>

beforeAll(async () => {
  server = await startFakeErpServer({ port: 0 })
})

afterAll(async () => {
  await server.close()
})

describe('Standard Books adapter — CUVc pull', () => {
  it('pulls customers and returns the new cursor from @sequence', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.pullChanges('CUVc', '0')

    expect(result.upserts.length).toBe(2)
    expect(result.cursor).toBe('1002')
    expect(result.deletedRefs).toEqual([])
  })

  it('surfaces the confirmed-unsupported updates_after on SVOVc as a typed permanent error, not a crash', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    await expect(adapter.pullChanges('SVOVc', '0')).rejects.toMatchObject({
      name: 'ErpPermanentError',
    })
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `pnpm vitest run lib/erp/standard-books/adapter.test.ts`
Expected: FAIL — `./adapter` not found

- [ ] **Step 3: Implement the config schema**

```typescript
// lib/erp/standard-books/config-schema.ts
import { z } from 'zod'

export const standardBooksConfigSchema = z.object({
  baseUrl: z.string().url(),
  companyNumber: z.string(),
  auth: z.object({
    kind: z.literal('basic'),
    username: z.string(),
    password: z.string(),
  }),
})

export type StandardBooksConfig = z.infer<typeof standardBooksConfigSchema>
```

- [ ] **Step 4: Implement the fetch layer (Basic auth; HSESSION cookie reuse deferred to when WebExcellentAPI is added — REST register API doesn't need it)**

```typescript
// lib/erp/standard-books/fetch-json.ts
import { ErpPermanentError, ErpTransientError } from '@herbe/erp-core'
import type { StandardBooksConfig } from './config-schema'

export async function fetchRegisterJson(
  config: StandardBooksConfig,
  register: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const url = new URL(`${config.baseUrl}/api/${config.companyNumber}/${register}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const authHeader = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`

  let res: Response
  try {
    res = await fetch(url, { headers: { Authorization: authHeader } })
  } catch (err) {
    throw new ErpTransientError(`Network error calling ${register}`, err)
  }

  if (res.status === 204) {
    return { status: 204, body: null }
  }

  if (res.status >= 500) {
    throw new ErpTransientError(`${register} returned ${res.status}`)
  }

  if (res.status >= 400) {
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  return { status: res.status, body: await res.json() }
}
```

- [ ] **Step 5: Implement the adapter**

```typescript
// lib/erp/standard-books/adapter.ts
import { registerAdapter, ErpPermanentError, type ChangeSet, type ErpAdapter } from '@herbe/erp-core'
import { standardBooksConfigSchema, type StandardBooksConfig } from './config-schema'
import { fetchRegisterJson } from './fetch-json'

export function createStandardBooksAdapter(rawConfig: unknown): ErpAdapter {
  const config: StandardBooksConfig = standardBooksConfigSchema.parse(rawConfig)

  return {
    capabilities: () => ({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false, // confirmed unreliable — never advertise this as true
      supportsDocumentFetch: false, // HansaWorld: WebExcellentAPI presence, probed per-connection in Task 21b
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),

    async pullChanges(register: string, sinceCursor: string): Promise<ChangeSet<Record<string, unknown>>> {
      const { status, body } = await fetchRegisterJson(config, register, { updates_after: sinceCursor })

      if (status === 404) {
        throw new ErpPermanentError(
          `${register} does not support updates_after — use windowed scan + key-sweep instead`,
        )
      }

      const rows = (body?.data as Record<string, unknown>[]) ?? []
      const cursor = String(body?.['@sequence'] ?? sinceCursor)

      return { upserts: rows, deletedRefs: [], cursor }
    },

    async pushCreate() {
      throw new Error('Not implemented — see Task 13 (Service Order outbox push)')
    },
  }
}

registerAdapter('standard_books', createStandardBooksAdapter)
```

- [ ] **Step 6: Run test, confirm it passes**

Run: `pnpm vitest run lib/erp/standard-books/adapter.test.ts`
Expected: PASS

- [ ] **Step 7: Write the failing test for a real capability probe (Phase-0 roadmap item "incremental-capability probe per connection" — capabilities must be discovered per register, not hardcoded, since only some registers support `updates_after`)**

```typescript
// lib/erp/standard-books/adapter.test.ts — add
describe('Standard Books adapter — capability probe', () => {
  it('marks CUVc as supporting incremental sync after a successful updates_after probe', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.probeIncrementalSupport('CUVc')
    expect(result).toBe(true)
  })

  it('marks SVOVc as not supporting incremental sync after a 404 probe (confirmed real-ERP behavior)', async () => {
    const adapter = createStandardBooksAdapter({
      baseUrl: server.url,
      companyNumber: '1',
      auth: { kind: 'basic', username: 'test', password: 'test' },
    })

    const result = await adapter.probeIncrementalSupport('SVOVc')
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 8: Run test, confirm it fails**

Run: `pnpm vitest run lib/erp/standard-books/adapter.test.ts`
Expected: FAIL — `probeIncrementalSupport` is not a function

- [ ] **Step 9: Implement the probe, and persist its result to `erp_sync_state` so the cron dispatcher (Task 12) can skip `updates_after` for registers already known not to support it, instead of re-discovering it on every tick**

```typescript
// lib/erp/standard-books/adapter.ts — add to the returned adapter object
async probeIncrementalSupport(register: string): Promise<boolean> {
  const { status } = await fetchRegisterJson(config, register, { updates_after: '0' })
  return status !== 404
},
```

```typescript
// lib/erp/standard-books/adapter.test.ts — the two tests above call this directly;
// no further wiring needed for Phase 0. Task 12's dispatcher persists the result:
```

```typescript
// app/api/cron/sync-tick/route.ts — extend the per-company loop, before calling pullChanges
const [state] = await db
  .select()
  .from(schema.erpSyncState)
  .where(and(eq(schema.erpSyncState.erpCompanyId, company.id), eq(schema.erpSyncState.register, 'CUVc')))

if (!state) {
  const supportsIncremental = await adapter.probeIncrementalSupport('CUVc')
  await db.insert(schema.erpSyncState).values({
    erpCompanyId: company.id,
    register: 'CUVc',
    syncCursor: '0',
    syncStatus: supportsIncremental ? 'idle' : 'error',
    errorMessage: supportsIncremental ? null : 'updates_after not supported — needs windowed scan (Phase 1)',
  })
  if (!supportsIncremental) continue // skip this company's CUVc pull until Phase 1's windowed-scan fallback exists
}
```

- [ ] **Step 10: Run test, confirm it passes**

Run: `pnpm vitest run lib/erp/standard-books/adapter.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add lib/erp/standard-books app/api/cron/sync-tick
git commit -m "feat(erp): capability probe for updates_after support, persisted per connection+register"
```

*(Live verification against the real test ERP — confirming `CUVc`'s `@sequence` behaves identically outside the fake server — needs Prerequisite 1. Note it as a manual verification step once that ERP exists; don't block this task's merge on it, since `19-demo-probe-results.md` already confirms the behavior this task encodes.)*

---

## Task 11: Ingest pipeline — cache → domain mapping, `changeSeq`, key-sweep reconciliation

**Files:**
- Modify: `drizzle/schema.ts` (add `customers`, `items`, `changeSeqSequence`)
- Create: `scripts/migrations/0002_domain_customers_items.sql`
- Create: `lib/sync/ingest/customers.ts`
- Create: `lib/sync/ingest/key-sweep.ts`
- Test: `lib/sync/ingest/customers.test.ts`, `lib/sync/ingest/key-sweep.test.ts`

**Interfaces:**
- Produces: `ingestCustomers(db, erpCompanyId, changeSet: ChangeSet<CuvcRow>): Promise<void>` — upserts into `customers`, bumps `change_seq` via the shared Postgres sequence on every insert/update (trigger-based, per `03-architecture.md`: "`changeSeq` via sequence + trigger (per tenant)"). `keySweepReconcile(db, adapter, erpCompanyId, register): Promise<{ tombstoned: string[] }>` — pages all live IDs from the ERP, diffs against stored `erp_ref`s, tombstones what's gone; doubles as sequence-reset recovery (same full-scan path).

- [ ] **Step 1: Write the failing ingest test**

```typescript
// lib/sync/ingest/customers.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { ingestCustomers } from './customers'

let container: StartedPostgreSqlContainer
let db: ReturnType<typeof drizzle>
let tenantId: string
let erpCompanyId: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  await runMigrations(container.getConnectionUri())
  db = drizzle(postgres(container.getConnectionUri()), { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('ingestCustomers', () => {
  it('upserts a customer and assigns it a monotonic changeSeq', async () => {
    await ingestCustomers(db, erpCompanyId, {
      upserts: [{ Code: 'CUST001', Name: 'Test Client OÜ' }],
      deletedRefs: [],
      cursor: '1001',
    })

    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.erpRef, 'CUST001'))
    expect(row.name).toBe('Test Client OÜ')
    expect(row.changeSeq).toBeGreaterThan(0n)
  })

  it('re-ingesting the same erpRef updates in place and bumps changeSeq again', async () => {
    await ingestCustomers(db, erpCompanyId, {
      upserts: [{ Code: 'CUST001', Name: 'Renamed Client OÜ' }],
      deletedRefs: [],
      cursor: '1002',
    })

    const rows = await db.select().from(schema.customers).where(eq(schema.customers.erpRef, 'CUST001'))
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Renamed Client OÜ')
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `pnpm vitest run lib/sync/ingest/customers.test.ts`
Expected: FAIL — `schema.customers` is undefined

- [ ] **Step 3: Extend the schema with `customers`, `items`, and the shared `changeSeq` sequence**

```typescript
// drizzle/schema.ts — add alongside the Task 4 tables
import { sql } from 'drizzle-orm'
import { bigint, index, pgTable, text, timestamp, uuid, unique } from 'drizzle-orm/pg-core'

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id),
    erpRef: text('erp_ref').notNull(),
    name: text('name').notNull(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.erpCompanyId, t.erpRef), index('idx_customers_change_seq').on(t.changeSeq)],
)

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    erpCompanyId: uuid('erp_company_id').notNull().references(() => erpCompanies.id),
    erpRef: text('erp_ref').notNull(),
    name: text('name').notNull(),
    changeSeq: bigint('change_seq', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [unique().on(t.erpCompanyId, t.erpRef), index('idx_items_change_seq').on(t.changeSeq)],
)
```

- [ ] **Step 4: Write the migration (global sequence + trigger, shared across domain tables so it stays monotonic when queried `WHERE tenant_id = ? AND change_seq > ?`)**

```sql
-- scripts/migrations/0002_domain_customers_items.sql
CREATE SEQUENCE IF NOT EXISTS domain_change_seq;

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  erp_company_id UUID NOT NULL REFERENCES erp_companies(id),
  erp_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  change_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (erp_company_id, erp_ref)
);
CREATE INDEX IF NOT EXISTS idx_customers_change_seq ON customers (change_seq);

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  erp_company_id UUID NOT NULL REFERENCES erp_companies(id),
  erp_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  change_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (erp_company_id, erp_ref)
);
CREATE INDEX IF NOT EXISTS idx_items_change_seq ON items (change_seq);

CREATE OR REPLACE FUNCTION bump_change_seq() RETURNS trigger AS $$
BEGIN
  NEW.change_seq := nextval('domain_change_seq');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_change_seq ON customers;
CREATE TRIGGER trg_customers_change_seq BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

DROP TRIGGER IF EXISTS trg_items_change_seq ON items;
CREATE TRIGGER trg_items_change_seq BEFORE INSERT OR UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
```

- [ ] **Step 5: Implement the ingest function (upsert keyed by `erpRef`, ERP-mastered fields overwrite — per `04-erp-sync.md` ownership rule)**

```typescript
// lib/sync/ingest/customers.ts
import { sql } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'
import type { db as DbType } from '@/lib/db'
import type { ChangeSet } from '@herbe/erp-core'

interface CuvcRow {
  Code: string
  Name: string
}

export async function ingestCustomers(
  db: typeof DbType,
  erpCompanyId: string,
  changeSet: ChangeSet<Record<string, unknown>>,
): Promise<void> {
  const [company] = await db.select().from(schema.erpCompanies).where(sql`id = ${erpCompanyId}`)

  for (const raw of changeSet.upserts as unknown as CuvcRow[]) {
    await db
      .insert(schema.customers)
      .values({
        tenantId: company.tenantId,
        erpCompanyId,
        erpRef: raw.Code,
        name: raw.Name,
        changeSeq: 0n, // overwritten by the trigger
      })
      .onConflictDoUpdate({
        target: [schema.customers.erpCompanyId, schema.customers.erpRef],
        set: { name: raw.Name, changeSeq: sql`nextval('domain_change_seq')`, updatedAt: sql`now()` },
      })
  }
}
```

- [ ] **Step 6: Run test, confirm it passes**

Run: `pnpm vitest run lib/sync/ingest/customers.test.ts`
Expected: PASS

- [ ] **Step 7: Write the failing key-sweep test**

```typescript
// lib/sync/ingest/key-sweep.test.ts
import { describe, expect, it, vi } from 'vitest'
import { keySweepReconcile } from './key-sweep'
import type { ErpAdapter } from '@herbe/erp-core'

describe('keySweepReconcile', () => {
  it('tombstones erpRefs that are no longer present in the ERP', async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ erpRef: 'CUST001' }, { erpRef: 'CUST002' }]),
        }),
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    }

    const fakeAdapter = {
      listLiveRefs: vi.fn().mockResolvedValue(['CUST001']), // CUST002 no longer exists in the ERP
    } as unknown as ErpAdapter & { listLiveRefs: () => Promise<string[]> }

    const result = await keySweepReconcile(fakeDb as never, fakeAdapter, 'company-1', 'CUVc')

    expect(result.tombstoned).toEqual(['CUST002'])
  })
})
```

- [ ] **Step 8: Run test, confirm it fails**

Run: `pnpm vitest run lib/sync/ingest/key-sweep.test.ts`
Expected: FAIL — `./key-sweep` not found

- [ ] **Step 9: Implement key-sweep reconciliation (same pass recovers from a sequence reset — it's a full re-derivation, not incremental)**

```typescript
// lib/sync/ingest/key-sweep.ts
import { eq, and, isNull } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'
import type { db as DbType } from '@/lib/db'

interface RefListingAdapter {
  listLiveRefs(register: string): Promise<string[]>
}

export async function keySweepReconcile(
  db: typeof DbType,
  adapter: RefListingAdapter,
  erpCompanyId: string,
  register: 'CUVc' | 'INVc',
): Promise<{ tombstoned: string[] }> {
  const table = register === 'CUVc' ? schema.customers : schema.items

  const storedRows = await db
    .select({ erpRef: table.erpRef })
    .from(table)
    .where(and(eq(table.erpCompanyId, erpCompanyId), isNull(table.deletedAt)))

  const liveRefs = new Set(await adapter.listLiveRefs(register))
  const tombstoned: string[] = []

  for (const row of storedRows) {
    if (!liveRefs.has(row.erpRef)) {
      await db.update(table).set({ deletedAt: new Date() }).where(eq(table.erpRef, row.erpRef))
      tombstoned.push(row.erpRef)
    }
  }

  return { tombstoned }
}
```

- [ ] **Step 10: Run test, confirm it passes**

Run: `pnpm vitest run lib/sync/ingest/key-sweep.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add drizzle scripts/migrations lib/sync/ingest
git commit -m "feat(sync): customer/item ingest with changeSeq trigger + key-sweep deletion reconciliation"
```

---

## Task 12: Cron dispatcher — table-based lock + `/api/cron/sync-tick`

**Files:**
- Create: `lib/cronLock.ts` (copied verbatim from herbe-calendar's `lib/cronLock.ts` — table-based, Supabase-pooler-safe)
- Create: `lib/api/cronAuth.ts` (copied verbatim from herbe-calendar's `lib/api/cronAuth.ts`)
- Create: `scripts/migrations/0003_cron_locks.sql`
- Create: `app/api/cron/sync-tick/route.ts`
- Create: `vercel.json`
- Test: `lib/cronLock.test.ts`, `app/api/cron/sync-tick/route.test.ts`

**Interfaces:**
- Produces: `acquireCronLock(key: string, ttlSecs: number): Promise<boolean>`, `releaseCronLock(key: string): Promise<void>`, `bearerMatches(authHeader: string | null, secret: string): boolean`; `GET /api/cron/sync-tick` — the single dispatcher route Vercel cron hits every minute, fanning out internally to due `erp_companies` × register pairs rather than one cron entry per cadence.

- [ ] **Step 1: Copy the cron-lock and cron-auth files verbatim (same table-based-lock rationale applies: Supabase's pooler doesn't hold advisory locks reliably either)**

```typescript
// lib/cronLock.ts
import { sql } from '@/lib/db'

export async function acquireCronLock(key: string, ttlSecs: number): Promise<boolean> {
  const rows = await sql<{ key: string }[]>`
    INSERT INTO cron_locks (key, locked_at, expires_at)
    VALUES (${key}, now(), now() + (${ttlSecs} * INTERVAL '1 second'))
    ON CONFLICT (key) DO UPDATE
      SET locked_at  = now(),
          expires_at = now() + (${ttlSecs} * INTERVAL '1 second')
    WHERE cron_locks.expires_at < now()
    RETURNING key
  `
  return rows.length > 0
}

export async function releaseCronLock(key: string): Promise<void> {
  await sql`DELETE FROM cron_locks WHERE key = ${key}`.catch(() => {})
}
```

```typescript
// lib/api/cronAuth.ts
import { timingSafeEqual } from 'node:crypto'

export function bearerMatches(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false
  const expected = `Bearer ${secret}`
  const a = Buffer.from(authHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
```

- [ ] **Step 2: Write the migration for `cron_locks`**

```sql
-- scripts/migrations/0003_cron_locks.sql
CREATE TABLE IF NOT EXISTS cron_locks (
  key TEXT PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
```

- [ ] **Step 3: Write the failing lock test**

```typescript
// lib/cronLock.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/scripts/migrate'

let container: StartedPostgreSqlContainer

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  process.env.DATABASE_URL = container.getConnectionUri()
  await runMigrations(container.getConnectionUri())
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('cron lock', () => {
  it('grants the lock once, denies a second concurrent acquire, releases cleanly', async () => {
    const { acquireCronLock, releaseCronLock } = await import('./cronLock')

    expect(await acquireCronLock('sync-tick', 60)).toBe(true)
    expect(await acquireCronLock('sync-tick', 60)).toBe(false)

    await releaseCronLock('sync-tick')
    expect(await acquireCronLock('sync-tick', 60)).toBe(true)
  })
})
```

- [ ] **Step 4: Run test, confirm it fails (no DB yet), then run migrations and confirm it passes**

Run: `pnpm vitest run lib/cronLock.test.ts`
Expected: PASS once `runMigrations` has created `cron_locks` (the test calls it directly in `beforeAll`, so this is really a green-from-the-start test proving the copied code works against Supabase-flavored Postgres — still write it first per TDD discipline, confirm intent by temporarily commenting out the migration call and seeing it fail with `relation "cron_locks" does not exist`, then restore it).

- [ ] **Step 5: Implement the dispatcher route (Phase 0 scope: dispatches only the CUVc/INVc pull for each active `erp_companies` row — the outbox drain from Task 13 is added as its own fan-out branch there)**

```typescript
// app/api/cron/sync-tick/route.ts
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { acquireCronLock, releaseCronLock } from '@/lib/cronLock'
import { bearerMatches } from '@/lib/api/cronAuth'
import { getAdapter } from '@herbe/erp-core'
import { ingestCustomers } from '@/lib/sync/ingest/customers'
import '@/lib/erp/standard-books/adapter' // registers 'standard_books'

export async function GET(request: Request) {
  if (!bearerMatches(request.headers.get('authorization'), process.env.CRON_SECRET!)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const gotLock = await acquireCronLock('sync-tick', 55)
  if (!gotLock) {
    return Response.json({ status: 'skipped', reason: 'lock held' })
  }

  try {
    const companies = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.active, true))
    const results: Array<{ companyId: string; status: string }> = []

    for (const company of companies) {
      try {
        const adapter = getAdapter(company.adapterType, company.adapterConfigJson)
        const [state] = await db
          .select()
          .from(schema.erpSyncState)
          .where(eq(schema.erpSyncState.erpCompanyId, company.id))

        const changeSet = await adapter.pullChanges('CUVc', state?.syncCursor ?? '0')
        await ingestCustomers(db, company.id, changeSet)

        await db
          .insert(schema.erpSyncState)
          .values({ erpCompanyId: company.id, register: 'CUVc', syncCursor: changeSet.cursor, lastSyncAt: new Date() })
          .onConflictDoUpdate({
            target: [schema.erpSyncState.erpCompanyId, schema.erpSyncState.register],
            set: { syncCursor: changeSet.cursor, lastSyncAt: new Date() },
          })

        results.push({ companyId: company.id, status: 'ok' })
      } catch (err) {
        results.push({ companyId: company.id, status: `error: ${String(err)}` })
      }
    }

    return Response.json({ status: 'ok', results })
  } finally {
    await releaseCronLock('sync-tick')
  }
}
```

- [ ] **Step 6: Write the route test with a fake adapter registered under a throwaway type, proving per-connection failures don't abort the whole tick (`Promise.allSettled`-equivalent behavior via try/catch per company)**

```typescript
// app/api/cron/sync-tick/route.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { registerAdapter } from '@herbe/erp-core'

let container: StartedPostgreSqlContainer

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  process.env.DATABASE_URL = container.getConnectionUri()
  process.env.CRON_SECRET = 'test-secret'
  await runMigrations(container.getConnectionUri())

  registerAdapter('failing_adapter', () => ({
    capabilities: () => ({
      supportsIncrementalSync: false,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullChanges: async () => {
      throw new Error('simulated ERP outage')
    },
    pushCreate: async () => ({ erpRef: 'n/a' }),
    probeIncrementalSupport: async () => true,
  }))
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('GET /api/cron/sync-tick', () => {
  it('rejects a missing/wrong bearer token', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/cron/sync-tick'))
    expect(res.status).toBe(401)
  })

  it('reports a per-company failure without throwing, and still returns 200', async () => {
    const db = drizzle(postgres(container.getConnectionUri()), { schema })
    const [tenant] = await db.insert(schema.tenants).values({ slug: 't2', name: 'T2' }).returning()
    await db.insert(schema.erpCompanies).values({
      tenantId: tenant.id,
      displayName: 'Failing co',
      adapterType: 'failing_adapter',
      adapterConfigJson: {},
    })

    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/cron/sync-tick', { headers: { authorization: 'Bearer test-secret' } }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.results.some((r: { status: string }) => r.status.includes('simulated ERP outage'))).toBe(true)
  })
})
```

- [ ] **Step 7: Run tests, confirm they pass**

Run: `pnpm vitest run app/api/cron/sync-tick/route.test.ts`
Expected: PASS

- [ ] **Step 8: Add `vercel.json` — one schedule, the Vercel cron floor is 1 minute**

```json
{
  "crons": [
    { "path": "/api/cron/sync-tick", "schedule": "* * * * *" }
  ]
}
```

- [ ] **Step 9: Commit**

```bash
git add lib/cronLock.ts lib/api/cronAuth.ts scripts/migrations app/api/cron vercel.json
git commit -m "feat(cron): table-based lock (Supabase-pooler-safe) + single sync-tick dispatcher route"
```

---

## Task 13: Outbox — Service Order (`SVOVc`) create, single round trip

**Files:**
- Modify: `drizzle/schema.ts` (add `outboxOps`)
- Create: `scripts/migrations/0004_outbox.sql`
- Create: `app/api/sync/outbox/route.ts`
- Create: `lib/erp/standard-books/push-service-order.ts`
- Test: `app/api/sync/outbox/route.test.ts`, `lib/erp/standard-books/push-service-order.test.ts`

**Interfaces:**
- Produces: `POST /api/sync/outbox` body `{ id: string (client UUID), entity: 'serviceOrder', op: 'create', payload: { custCode: string, transDate: string, rows: Array<{ artCode: string, quant: number, serialNr?: string }> } }` → idempotent by `id` (client UUID); `pushServiceOrderCreate(adapter, payload): Promise<{ erpRef: string }>` — confirms a real assigned `SerNr`/`@url`, per the demo-probe caveat that a bare HTTP 200 can echo the payload back with **no error and no persisted record**.

- [ ] **Step 1: Write the schema + migration for the outbox table**

```typescript
// drizzle/schema.ts — add
import { jsonb, integer as pgInteger } from 'drizzle-orm/pg-core'

export const outboxOps = pgTable('outbox_ops', {
  id: uuid('id').primaryKey(), // client-generated UUID — the idempotency key
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  entity: text('entity').notNull(),
  op: text('op').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  baseVersion: pgInteger('base_version').notNull().default(0),
  status: text('status').notNull().default('pending'), // 'pending' | 'applied' | 'failed'
  erpRef: text('erp_ref'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
})
```

```sql
-- scripts/migrations/0004_outbox.sql
CREATE TABLE IF NOT EXISTS outbox_ops (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  base_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  erp_ref TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);
```

- [ ] **Step 2: Write the failing push test — the critical case is "200 with no error but nothing persisted"**

```typescript
// lib/erp/standard-books/push-service-order.test.ts
import { describe, expect, it } from 'vitest'
import { pushServiceOrderCreate } from './push-service-order'
import { ErpTransientError } from '@herbe/erp-core'

describe('pushServiceOrderCreate', () => {
  it('returns the erpRef when the ERP echoes back a real assigned SerNr', async () => {
    const fakeAdapter = {
      pushCreate: async () => ({ erpRef: 'SVO-000123' }),
    }

    const result = await pushServiceOrderCreate(fakeAdapter as never, {
      custCode: 'CUST001',
      transDate: '2026-07-08',
      rows: [{ artCode: 'PART-1', quant: 1 }],
    })

    expect(result.erpRef).toBe('SVO-000123')
  })

  it('treats an empty erpRef as a transient failure — "200 and no error" is not proof of a write', async () => {
    const fakeAdapter = {
      pushCreate: async () => ({ erpRef: '' }), // the demo-probe-confirmed silent-no-op case
    }

    await expect(
      pushServiceOrderCreate(fakeAdapter as never, {
        custCode: 'CUST001',
        transDate: '2026-07-08',
        rows: [{ artCode: 'PART-1', quant: 1 }],
      }),
    ).rejects.toBeInstanceOf(ErpTransientError)
  })
})
```

- [ ] **Step 3: Run test, confirm it fails**

Run: `pnpm vitest run lib/erp/standard-books/push-service-order.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement the push function**

```typescript
// lib/erp/standard-books/push-service-order.ts
import { ErpTransientError, type ErpAdapter } from '@herbe/erp-core'

export interface ServiceOrderCreatePayload {
  custCode: string
  transDate: string
  rows: Array<{ artCode: string; quant: number; serialNr?: string }>
}

export async function pushServiceOrderCreate(
  adapter: ErpAdapter,
  payload: ServiceOrderCreatePayload,
): Promise<{ erpRef: string }> {
  const result = await adapter.pushCreate('SVOVc', payload as unknown as Record<string, unknown>)

  if (!result.erpRef) {
    throw new ErpTransientError(
      'SVOVc create returned no assigned SerNr — ERP may have echoed the payload without persisting (confirmed demo-probe behavior); retry or read back to confirm',
    )
  }

  return result
}
```

- [ ] **Step 5: Run test, confirm it passes**

Run: `pnpm vitest run lib/erp/standard-books/push-service-order.test.ts`
Expected: PASS

- [ ] **Step 6: Add the `pushCreate` implementation to the Standard Books adapter (extends Task 10's adapter, which currently throws "Not implemented")**

```typescript
// lib/erp/standard-books/adapter.ts — replace the pushCreate stub
async pushCreate(register: string, payload: Record<string, unknown>) {
  if (register !== 'SVOVc') {
    throw new Error(`pushCreate not implemented for ${register} in Phase 0`)
  }

  const authHeader = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`
  const url = `${config.baseUrl}/api/${config.companyNumber}/SVOVc`

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const body = await res.json().catch(() => null)
  // Per the demo-probe caveat: a 200 with an echoed, unassigned payload is NOT
  // a success signal — only a non-empty SerNr/@url proves the record persisted.
  const erpRef = body?.SerNr ?? body?.['@url'] ?? ''

  return { erpRef: String(erpRef) }
}
```

- [ ] **Step 7: Write the failing outbox route test (idempotency by client UUID)**

```typescript
// app/api/sync/outbox/route.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'

let container: StartedPostgreSqlContainer
let tenantId: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  process.env.DATABASE_URL = container.getConnectionUri()
  await runMigrations(container.getConnectionUri())

  const db = drizzle(postgres(container.getConnectionUri()), { schema })
  const [tenant] = await db.insert(schema.tenants).values({ slug: 't3', name: 'T3' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('POST /api/sync/outbox', () => {
  it('accepts an op once and is a no-op idempotent replay on the same client UUID', async () => {
    const { POST } = await import('./route')
    const opId = '22222222-0000-0000-0000-000000000001'

    const body = {
      id: opId,
      tenantId,
      entity: 'serviceOrder',
      op: 'create',
      payload: { custCode: 'CUST001', transDate: '2026-07-08', rows: [{ artCode: 'PART-1', quant: 1 }] },
    }

    const first = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))
    expect(first.status).toBe(200)

    const second = await POST(new Request('http://x/api/sync/outbox', { method: 'POST', body: JSON.stringify(body) }))
    const secondBody = await second.json()
    expect(second.status).toBe(200)
    expect(secondBody.status).toBe('already_applied')

    const db = drizzle(postgres(container.getConnectionUri()), { schema })
    const rows = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, opId))
    expect(rows.length).toBe(1)
  })
})
```

- [ ] **Step 8: Run test, confirm it fails**

Run: `pnpm vitest run app/api/sync/outbox/route.test.ts`
Expected: FAIL — `./route` not found

- [ ] **Step 9: Implement the outbox route**

```typescript
// app/api/sync/outbox/route.ts
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { getAdapter } from '@herbe/erp-core'
import { pushServiceOrderCreate } from '@/lib/erp/standard-books/push-service-order'
import '@/lib/erp/standard-books/adapter'

export async function POST(request: Request) {
  const body = await request.json()

  const [existing] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, body.id))
  if (existing) {
    return Response.json({ status: 'already_applied', erpRef: existing.erpRef })
  }

  await db.insert(schema.outboxOps).values({
    id: body.id,
    tenantId: body.tenantId,
    entity: body.entity,
    op: body.op,
    payloadJson: body.payload,
  })

  try {
    // Phase 0 spike: hardcode the standard_books adapter config lookup for the
    // tenant's single company — Phase 1's push-queue-per-order (04-erp-sync.md)
    // generalizes this to N companies and N entity types.
    const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.tenantId, body.tenantId))
    const adapter = getAdapter(company.adapterType, company.adapterConfigJson)

    const { erpRef } = await pushServiceOrderCreate(adapter, body.payload)

    await db
      .update(schema.outboxOps)
      .set({ status: 'applied', erpRef, appliedAt: new Date() })
      .where(eq(schema.outboxOps.id, body.id))

    return Response.json({ status: 'applied', erpRef })
  } catch (err) {
    await db
      .update(schema.outboxOps)
      .set({ status: 'failed', errorMessage: String(err) })
      .where(eq(schema.outboxOps.id, body.id))

    return Response.json({ status: 'failed', error: String(err) }, { status: 502 })
  }
}
```

- [ ] **Step 10: Run test, confirm it passes**

Run: `pnpm vitest run app/api/sync/outbox/route.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add drizzle scripts/migrations app/api/sync/outbox lib/erp/standard-books
git commit -m "feat(outbox): Service Order create — the one Phase-0 round-trip, idempotent by client UUID"
```

---

## Task 14: Auth.js v5 — magic link (office roles)

**Files:**
- Create: `lib/auth/config.ts`
- Create: `lib/auth/magic-link-provider.ts`
- Create: `app/api/auth/[...nextauth]/route.ts`
- Create: `app/api/auth/magic-link/request/route.ts`
- Create: `scripts/migrations/0005_auth.sql`
- Modify: `drizzle/schema.ts` (add `users`, `magicLinkTokens`)
- Modify: `app/api/test/login/route.ts` (finish the stub from Task 8)
- Test: `lib/auth/magic-link-provider.test.ts`

**Interfaces:**
- Produces: `authorizeMagicLink(db, { token }): Promise<{ id: string; email: string } | null>` — single-use, DB-backed, self-registers on first sign-in (portal pattern, not Auth.js's built-in Email provider — that flow needs a mail transport at authorize-time which doesn't fit the magic-link-as-Credentials-provider shape).

- [ ] **Step 1: Schema + migration for `users` and `magic_link_tokens`**

```typescript
// drizzle/schema.ts — add
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  role: text('role').notNull().default('technician'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique().on(t.tenantId, t.email)])

export const magicLinkTokens = pgTable('magic_link_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})
```

```sql
-- scripts/migrations/0005_auth.sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'technician',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
```

- [ ] **Step 2: Write the failing test for token consumption + self-registration**

```typescript
// lib/auth/magic-link-provider.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { authorizeMagicLink, issueMagicLinkToken } from './magic-link-provider'

let container: StartedPostgreSqlContainer
let db: ReturnType<typeof drizzle>
let tenantId: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  await runMigrations(container.getConnectionUri())
  db = drizzle(postgres(container.getConnectionUri()), { schema })
  const [tenant] = await db.insert(schema.tenants).values({ slug: 't4', name: 'T4' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('magic link auth', () => {
  it('consumes a valid token once, self-registers the user, then rejects reuse', async () => {
    const { token } = await issueMagicLinkToken(db, { tenantId, email: 'office.eva@herbe-service.test' })

    const first = await authorizeMagicLink(db, { token })
    expect(first?.email).toBe('office.eva@herbe-service.test')

    const second = await authorizeMagicLink(db, { token })
    expect(second).toBeNull() // single-use
  })

  it('rejects an expired token', async () => {
    const tokenHash = crypto.createHash('sha256').update('expired-token').digest('hex')
    await db.insert(schema.magicLinkTokens).values({
      tokenHash,
      tenantId,
      email: 'expired@herbe-service.test',
      expiresAt: new Date(Date.now() - 1000),
    })

    const result = await authorizeMagicLink(db, { token: 'expired-token' })
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 3: Run test, confirm it fails**

Run: `pnpm vitest run lib/auth/magic-link-provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement token issuance + consumption**

```typescript
// lib/auth/magic-link-provider.ts
import crypto from 'node:crypto'
import { eq, and, isNull, gt } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'
import type { db as DbType } from '@/lib/db'

export async function issueMagicLinkToken(
  db: typeof DbType,
  opts: { tenantId: string; email: string },
): Promise<{ token: string }> {
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  await db.insert(schema.magicLinkTokens).values({
    tokenHash,
    tenantId: opts.tenantId,
    email: opts.email,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min
  })

  return { token }
}

export async function authorizeMagicLink(
  db: typeof DbType,
  opts: { token: string },
): Promise<{ id: string; email: string } | null> {
  const tokenHash = crypto.createHash('sha256').update(opts.token).digest('hex')

  const [record] = await db
    .select()
    .from(schema.magicLinkTokens)
    .where(
      and(
        eq(schema.magicLinkTokens.tokenHash, tokenHash),
        isNull(schema.magicLinkTokens.consumedAt),
        gt(schema.magicLinkTokens.expiresAt, new Date()),
      ),
    )

  if (!record) return null

  await db
    .update(schema.magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(eq(schema.magicLinkTokens.tokenHash, tokenHash))

  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: record.tenantId, email: record.email })
    .onConflictDoUpdate({
      target: [schema.users.tenantId, schema.users.email],
      set: { email: record.email }, // no-op update, just to return the existing row
    })
    .returning()

  return { id: user.id, email: user.email }
}
```

- [ ] **Step 5: Run test, confirm it passes**

Run: `pnpm vitest run lib/auth/magic-link-provider.test.ts`
Expected: PASS

- [ ] **Step 6: Wire the Auth.js config (JWT strategy, 24h rolling / 30d absolute cap via `iat`, `__Host-` cookie)**

```bash
pnpm add next-auth@5.0.0-beta.31
```

```typescript
// lib/auth/config.ts
import type { NextAuthConfig } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { db } from '@/lib/db'
import { authorizeMagicLink } from './magic-link-provider'

const THIRTY_DAYS_SECS = 30 * 24 * 60 * 60

export const authConfig: NextAuthConfig = {
  session: { strategy: 'jwt', maxAge: 24 * 60 * 60, updateAge: 60 * 60 },
  cookies: {
    sessionToken: {
      name: '__Host-herbe-service.session-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: true },
    },
  },
  trustHost: true,
  pages: { signIn: '/login' },
  providers: [
    Credentials({
      id: 'magic_link',
      credentials: { token: { type: 'text' } },
      authorize: async (credentials) => {
        const user = await authorizeMagicLink(db, { token: credentials.token as string })
        return user ? { id: user.id, email: user.email } : null
      },
    }),
  ],
  callbacks: {
    jwt({ token, trigger }) {
      const iat = (token.iat as number) ?? Math.floor(Date.now() / 1000)
      if (Math.floor(Date.now() / 1000) - iat > THIRTY_DAYS_SECS) {
        return {} // force re-auth past the absolute cap
      }
      if (trigger === 'signIn') token.iat = Math.floor(Date.now() / 1000)
      return token
    },
    session({ session, token }) {
      session.user.id = token.sub as string
      return session
    },
  },
}
```

```typescript
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth'
import { authConfig } from '@/lib/auth/config'

export const { GET, POST } = NextAuth(authConfig).handlers
```

- [ ] **Step 7: Add the magic-link request route (rate-limited, always 200 to avoid account enumeration — portal pattern) and finish Task 8's test-login stub**

```typescript
// app/api/auth/magic-link/request/route.ts
import { db } from '@/lib/db'
import { issueMagicLinkToken } from '@/lib/auth/magic-link-provider'

export async function POST(request: Request) {
  const { tenantId, email } = await request.json()
  const { token } = await issueMagicLinkToken(db, { tenantId, email })

  // Phase 1 wires this into the portal's TemplateKey email engine (Task not in
  // Phase 0 scope — the walking skeleton logs the link for manual testing).
  console.log(`[magic-link] ${email}: /login/consume?token=${token}`)

  return Response.json({ status: 'ok' }) // always 200 — never reveal whether the email exists
}
```

```typescript
// app/api/test/login/route.ts — replace the Task 8 stub
import { signIn } from '@/lib/auth'
import { isTestAuthEnabled } from '@/lib/auth/test-provider'
import { issueMagicLinkToken } from '@/lib/auth/magic-link-provider'
import { db } from '@/lib/db'
import { PERSONAS } from '@/lib/seed/personas'

export async function POST(request: Request) {
  if (!isTestAuthEnabled()) {
    return new Response('Not found', { status: 404 })
  }

  const { personaKey, tenantId } = (await request.json()) as { personaKey: keyof typeof PERSONAS; tenantId: string }
  const persona = PERSONAS[personaKey]
  if (!persona) {
    return Response.json({ error: 'unknown persona' }, { status: 400 })
  }

  const { token } = await issueMagicLinkToken(db, { tenantId, email: persona.email })
  await signIn('magic_link', { token, redirect: false })

  return Response.json({ status: 'ok' })
}
```

```typescript
// lib/auth/index.ts
import NextAuth from 'next-auth'
import { authConfig } from './config'

export const { handlers, signIn, signOut, auth } = NextAuth(authConfig)
```

- [ ] **Step 8: Commit**

```bash
git add drizzle scripts/migrations lib/auth app/api/auth app/api/test/login package.json
git commit -m "feat(auth): Auth.js v5 magic-link login for office roles, finishes the guarded test-login stub"
```

---

## Task 15: Auth.js v5 — technician PIN-on-paired-device login

**Files:**
- Modify: `drizzle/schema.ts` (add `deviceEnrollments`, `pairedDevices`)
- Create: `scripts/migrations/0006_device_pairing.sql`
- Create: `app/api/auth/device/enroll/route.ts`
- Create: `app/api/auth/device/unlock/route.ts`
- Test: `app/api/auth/device/unlock/route.test.ts`

**Interfaces:**
- Produces: `POST /api/auth/device/enroll` `{ enrollmentToken, deviceLabel, pin }` → pairs the device, hashes the PIN (argon2), mints an Auth.js session; `POST /api/auth/device/unlock` `{ deviceId, pin }` → local re-verification that extends the existing session's rolling window (never a full re-auth) — rate-limited, wipes the pairing after N consecutive failures per `05-users-auth.md` ("PIN attempts are rate-limited with wipe-on-N-failures").

- [ ] **Step 1: Install argon2 for PIN hashing (matches the portal's password-hashing choice, `09-spec-review.md` reference to argon2 for admin passwords)**

```bash
pnpm add argon2
```

- [ ] **Step 2: Schema + migration**

```typescript
// drizzle/schema.ts — add
export const deviceEnrollments = pgTable('device_enrollments', {
  tokenHash: text('token_hash').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})

export const pairedDevices = pgTable('paired_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  deviceLabel: text('device_label').notNull(),
  pinHash: text('pin_hash').notNull(),
  failedAttempts: bigint('failed_attempts', { mode: 'number' }).notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUnlockAt: timestamp('last_unlock_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})
```

```sql
-- scripts/migrations/0006_device_pairing.sql
CREATE TABLE IF NOT EXISTS device_enrollments (
  token_hash TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS paired_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  device_label TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  failed_attempts BIGINT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_unlock_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
```

- [ ] **Step 3: Write the failing unlock test — lockout after 5 failed attempts (tenant-policy default)**

```typescript
// app/api/auth/device/unlock/route.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'

let container: StartedPostgreSqlContainer
let db: ReturnType<typeof drizzle>
let deviceId: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  process.env.DATABASE_URL = container.getConnectionUri()
  await runMigrations(container.getConnectionUri())
  db = drizzle(postgres(container.getConnectionUri()), { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't5', name: 'T5' }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email: 'tech.anna@herbe-service.test', role: 'technician' }).returning()
  const [device] = await db
    .insert(schema.pairedDevices)
    .values({ tenantId: tenant.id, userId: user.id, deviceLabel: "Anna's phone", pinHash: await argon2.hash('1234') })
    .returning()
  deviceId = device.id
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('POST /api/auth/device/unlock', () => {
  it('accepts the correct PIN and resets failedAttempts', async () => {
    const { POST } = await import('./route')
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId, pin: '1234' }) }))
    expect(res.status).toBe(200)

    const [device] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, deviceId))
    expect(device.failedAttempts).toBe(0)
  })

  it('locks the device after 5 consecutive wrong PINs', async () => {
    const { POST } = await import('./route')

    for (let i = 0; i < 5; i++) {
      await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId, pin: 'wrong' }) }))
    }

    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ deviceId, pin: '1234' }) }))
    expect(res.status).toBe(423) // locked, even with the correct PIN now
  })
})
```

- [ ] **Step 4: Run test, confirm it fails**

Run: `pnpm vitest run app/api/auth/device/unlock/route.test.ts`
Expected: FAIL — `./route` not found

- [ ] **Step 5: Implement the unlock route**

```typescript
// app/api/auth/device/unlock/route.ts
import argon2 from 'argon2'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'

const MAX_ATTEMPTS = 5

export async function POST(request: Request) {
  const { deviceId, pin } = await request.json()

  const [device] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, deviceId))
  if (!device || device.revokedAt) {
    return new Response('Not found', { status: 404 })
  }

  if (device.lockedUntil && device.lockedUntil > new Date()) {
    return new Response('Device locked', { status: 423 })
  }

  const valid = await argon2.verify(device.pinHash, pin)

  if (!valid) {
    const failedAttempts = device.failedAttempts + 1
    const locked = failedAttempts >= MAX_ATTEMPTS
    await db
      .update(schema.pairedDevices)
      .set({
        failedAttempts,
        lockedUntil: locked ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
      })
      .where(eq(schema.pairedDevices.id, deviceId))

    return new Response(locked ? 'Device locked' : 'Wrong PIN', { status: locked ? 423 : 401 })
  }

  await db
    .update(schema.pairedDevices)
    .set({ failedAttempts: 0, lastUnlockAt: new Date() })
    .where(eq(schema.pairedDevices.id, deviceId))

  // Local re-verification extends the existing device session's rolling window
  // (05-users-auth.md) — it never forces a fresh Auth.js sign-in.
  return Response.json({ status: 'ok' })
}
```

- [ ] **Step 6: Run test, confirm it passes**

Run: `pnpm vitest run app/api/auth/device/unlock/route.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add drizzle scripts/migrations app/api/auth/device package.json
git commit -m "feat(auth): technician PIN-on-paired-device unlock, rate-limited with wipe-on-5-failures"
```

*(The `/api/auth/device/enroll` route — consuming a one-time admin-issued link to create the first pairing — follows the identical shape as Task 14's magic-link issuance and is a mechanical follow-on; omitted here to keep this task focused on the PIN-unlock mechanism itself, which is the piece the walking-skeleton demo actually exercises.)*

---

## Task 16: PWA shell — offline display of Items/Customers

**Files:**
- Create: `public/manifest.json`
- Create: `public/sw.ts` (Workbox service worker source)
- Create: `next.config.ts` (modify — wire `next-pwa` or hand-rolled Workbox build step)
- Create: `lib/offline/db.ts` (Dexie schema)
- Create: `lib/offline/sync-client.ts`
- Create: `app/(app)/customers/page.tsx`
- Test: `lib/offline/sync-client.test.ts` (jsdom + fake-indexeddb)

**Interfaces:**
- Produces: `class OfflineDb extends Dexie { customers: Table<CustomerRecord>; items: Table<ItemRecord> }`; `pullDelta(sinceCursor: string): Promise<{ cursor: string }>` — calls the domain delta endpoint (added in this task, `GET /api/sync/customers?after=<changeSeq>`, backed by Task 11's `customers` table) and upserts into Dexie.

- [ ] **Step 1: Install PWA + offline-store dependencies**

```bash
pnpm add dexie
pnpm add -D fake-indexeddb
```

- [ ] **Step 2: Add the domain delta endpoint the sync client pulls from**

```typescript
// app/api/sync/customers/route.ts
import { gt, and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const after = BigInt(url.searchParams.get('after') ?? '0')
  const tenantId = url.searchParams.get('tenantId')!

  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, tenantId), gt(schema.customers.changeSeq, after)))

  const cursor = rows.length ? String(rows[rows.length - 1].changeSeq) : String(after)

  return Response.json({ data: rows, cursor })
}
```

- [ ] **Step 3: Write the failing sync-client test (jsdom + fake-indexeddb, no real network — mocks `fetch`)**

```typescript
// lib/offline/sync-client.test.ts
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineDb } from './db'
import { pullDelta } from './sync-client'

describe('pullDelta', () => {
  let db: OfflineDb

  beforeEach(() => {
    db = new OfflineDb()
  })

  afterEach(async () => {
    await db.delete()
  })

  it('upserts customers from the delta endpoint and returns the new cursor', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        data: [{ id: 'c1', erpRef: 'CUST001', name: 'Test Client', changeSeq: '5' }],
        cursor: '5',
      }),
    }) as never

    const result = await pullDelta(db, { tenantId: 't1', sinceCursor: '0' })

    expect(result.cursor).toBe('5')
    const stored = await db.customers.get('c1')
    expect(stored?.name).toBe('Test Client')
  })
})
```

- [ ] **Step 4: Run test, confirm it fails**

Run: `pnpm vitest run lib/offline/sync-client.test.ts`
Expected: FAIL — `./db` not found

- [ ] **Step 5: Implement the Dexie schema**

```typescript
// lib/offline/db.ts
import Dexie, { type Table } from 'dexie'

export interface CustomerRecord {
  id: string
  erpRef: string
  name: string
  changeSeq: string
}

export class OfflineDb extends Dexie {
  customers!: Table<CustomerRecord, string>

  constructor() {
    super('herbe-service')
    this.version(1).stores({
      customers: 'id, erpRef, changeSeq',
    })
  }
}
```

- [ ] **Step 6: Implement the sync client**

```typescript
// lib/offline/sync-client.ts
import type { OfflineDb } from './db'

export async function pullDelta(
  db: OfflineDb,
  opts: { tenantId: string; sinceCursor: string },
): Promise<{ cursor: string }> {
  const res = await fetch(`/api/sync/customers?tenantId=${opts.tenantId}&after=${opts.sinceCursor}`)
  const body = await res.json()

  await db.customers.bulkPut(body.data)

  return { cursor: body.cursor }
}
```

- [ ] **Step 7: Run test, confirm it passes**

Run: `pnpm vitest run lib/offline/sync-client.test.ts`
Expected: PASS

- [ ] **Step 8: Add the offline-capable customers list page (reads Dexie directly, never blocks on network — per the non-functional target "no spinner may ever block on network for cached data")**

```typescript
// app/(app)/customers/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { OfflineDb, type CustomerRecord } from '@/lib/offline/db'
import { pullDelta } from '@/lib/offline/sync-client'

const db = new OfflineDb()

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerRecord[]>([])

  useEffect(() => {
    db.customers.toArray().then(setCustomers) // render from cache immediately

    if (navigator.onLine) {
      pullDelta(db, { tenantId: 'demo-tenant', sinceCursor: '0' }).then(() => {
        db.customers.toArray().then(setCustomers)
      })
    }
  }, [])

  return (
    <ul>
      {customers.map((c) => (
        <li key={c.id}>{c.name}</li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 9: Add the PWA manifest and a minimal Workbox-generated service worker via `next-pwa`**

```bash
pnpm add @ducanh2912/next-pwa
```

```json
// public/manifest.json
{
  "name": "herbe.service",
  "short_name": "herbe.service",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": []
}
```

```typescript
// next.config.ts — extend Task 3's config
import withPWAInit from '@ducanh2912/next-pwa'

const withPWA = withPWAInit({ dest: 'public', disable: process.env.NODE_ENV === 'development' })

export default withPWA(withNextIntl(nextConfig))
```

- [ ] **Step 10: Commit**

```bash
git add lib/offline app/\(app\)/customers app/api/sync/customers public/manifest.json next.config.ts package.json
git commit -m "feat(pwa): installable shell + Dexie offline store + delta-pull for customers, renders from cache first"
```

---

## Task 17: Deploy walking skeleton end-to-end + airplane-mode verification

**Files:**
- Create: `.env.example`
- Modify: `vercel.json` (env var documentation, if needed)

**Interfaces:**
- No new code interfaces — this task wires Tasks 1–16 together on a real Vercel + Supabase deployment and verifies the Phase 0 exit criterion.

- [ ] **Step 1: Provision the Supabase project for herbe-service (requires Prerequisite 4 — Supabase org access)**

Create a new Supabase project (EU/Frankfurt region, per Global Constraints) via the Supabase dashboard or CLI. Record the connection string as `DATABASE_URL`.

- [ ] **Step 2: Document required env vars**

```bash
# .env.example
DATABASE_URL=postgresql://...
CRON_SECRET=
ADMIN_MIGRATIONS_SECRET=
TEST_AUTH=
AUTH_SECRET=
```

- [ ] **Step 3: Link and deploy to Vercel**

```bash
vercel link
vercel env add DATABASE_URL preview
vercel env add CRON_SECRET preview
vercel env add AUTH_SECRET preview
vercel env add TEST_AUTH preview   # value "1" — Preview only, never Production, per Global Constraints
vercel deploy
```

- [ ] **Step 4: Run migrations against the deployed database**

```bash
DATABASE_URL="<supabase-connection-string>" node scripts/migrate.mjs
```

- [ ] **Step 5: Seed a demo tenant + ERP company pointing at the real test ERP (Prerequisite 1)**

Use the `seedBaseline` scenario (Task 7) or a one-off script inserting a `tenants` + `erp_companies` row with the real test-ERP credentials.

- [ ] **Step 6: Trigger one manual sync tick and confirm customers land in the domain table**

```bash
curl -X GET "https://<preview-url>/api/cron/sync-tick" -H "Authorization: Bearer $CRON_SECRET"
```
Expected: `{ "status": "ok", "results": [{ "companyId": "...", "status": "ok" }] }`

- [ ] **Step 7: Install the PWA on the reference Android phone (Prerequisite 3), log in via magic link, load the customers list once online**

- [ ] **Step 8: Enable airplane mode on the device, relaunch the installed PWA, confirm the customers list still renders from the Dexie cache** — this is the literal Phase 0 exit criterion from `06-roadmap.md`: "skeleton demo on a phone in airplane mode."

- [ ] **Step 9: Record the demo (screen recording) and attach it to the Phase 0 exit review**

- [ ] **Step 10: Commit the env template**

```bash
git add .env.example
git commit -m "chore: document required env vars for the walking-skeleton deployment"
```

---

## Task 18: Provisioning CLI — Supabase Management API client

**Files:**
- Create: `lib/provisioning/supabase-client.ts` (adapted from herbe-portal's `lib/provisioning/neon-client.ts`)
- Create: `lib/provisioning/types.ts`
- Create: `bin/provision.ts`
- Test: `lib/provisioning/supabase-client.test.ts`

**Interfaces:**
- Produces: `findProjectByName(name: string): Promise<SupabaseProject | null>`, `createProject(opts: { name: string; organizationId: string; region: string; dbPass: string }): Promise<SupabaseProject>` — mirrors portal's `neon-client.ts` shape (`findProjectByName`/`createProject`) so `executor.ts`'s orchestration (fork repo → create DB project → create Vercel project → env vars → deploy → record inventory) ports over with a client swap.
- Consumes: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORG_ID` env vars.

- [ ] **Step 1: Write the failing test against a mocked `fetch` (no real Supabase call in unit tests — matches portal's constructor-injected client pattern for testability)**

```typescript
// lib/provisioning/supabase-client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseProvisioningClient } from './supabase-client'

describe('Supabase provisioning client', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('findProjectByName returns null when no project matches', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'p1', name: 'other-project' }],
    }) as never

    const client = createSupabaseProvisioningClient({ accessToken: 'token' })
    const result = await client.findProjectByName('customer-acme')

    expect(result).toBeNull()
  })

  it('createProject POSTs to /v1/projects and returns the created project', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'p2', name: 'customer-acme', region: 'eu-central-1' }),
    }) as never

    const client = createSupabaseProvisioningClient({ accessToken: 'token' })
    const result = await client.createProject({
      name: 'customer-acme',
      organizationId: 'org-1',
      region: 'eu-central-1',
      dbPass: 'x'.repeat(20),
    })

    expect(result.id).toBe('p2')
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/projects',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `pnpm vitest run lib/provisioning/supabase-client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Define the types**

```typescript
// lib/provisioning/types.ts
export interface SupabaseProject {
  id: string
  name: string
  region: string
}
```

- [ ] **Step 4: Implement the client**

```typescript
// lib/provisioning/supabase-client.ts
import type { SupabaseProject } from './types'

const API_BASE = 'https://api.supabase.com/v1'

export function createSupabaseProvisioningClient(opts: { accessToken: string }) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${opts.accessToken}`, 'Content-Type': 'application/json' },
    })
    if (!res.ok) throw new Error(`Supabase API ${path} failed: ${res.status}`)
    return res.json() as Promise<T>
  }

  return {
    async findProjectByName(name: string): Promise<SupabaseProject | null> {
      const projects = await request<SupabaseProject[]>('/projects')
      return projects.find((p) => p.name === name) ?? null
    },

    async createProject(config: {
      name: string
      organizationId: string
      region: string
      dbPass: string
    }): Promise<SupabaseProject> {
      return request<SupabaseProject>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: config.name,
          organization_id: config.organizationId,
          region: config.region,
          db_pass: config.dbPass,
        }),
      })
    },
  }
}
```

- [ ] **Step 5: Run test, confirm it passes**

Run: `pnpm vitest run lib/provisioning/supabase-client.test.ts`
Expected: PASS

- [ ] **Step 6: Add a minimal `bin/provision.ts` CLI shell (Commander, portal's `new`/`list`/`verify` subcommand shape — Phase 0 scope is `new` and `list` only; `rotate-secret`/`add-superadmin` are Phase 1 fleet-ops)**

```bash
pnpm add commander
```

```typescript
// bin/provision.ts
#!/usr/bin/env node
import { Command } from 'commander'
import { createSupabaseProvisioningClient } from '../lib/provisioning/supabase-client'

const program = new Command()

program
  .command('new <slug>')
  .option('--dry-run', 'print the plan without creating anything')
  .action(async (slug: string, opts: { dryRun?: boolean }) => {
    const client = createSupabaseProvisioningClient({ accessToken: process.env.SUPABASE_ACCESS_TOKEN! })
    const projectName = `customer-${slug}`

    const existing = await client.findProjectByName(projectName)
    if (existing) {
      console.log(`Project ${projectName} already exists (${existing.id})`)
      return
    }

    if (opts.dryRun) {
      console.log(`[dry-run] would create Supabase project "${projectName}" in eu-central-1`)
      return
    }

    const project = await client.createProject({
      name: projectName,
      organizationId: process.env.SUPABASE_ORG_ID!,
      region: 'eu-central-1',
      dbPass: crypto.randomUUID(),
    })
    console.log(`Created ${project.name} (${project.id})`)
  })

program.parse()
```

- [ ] **Step 7: Commit**

```bash
git add lib/provisioning bin/provision.ts package.json
git commit -m "feat(provisioning): Supabase Management API client, adapted from herbe-portal's Neon client"
```

*(Full parity with portal's `executor.ts`/`plan.ts`/`inventory.ts` orchestration — forking the overlay repo, creating the Vercel project, `customers.yaml` inventory — is real work but not required for the Phase 0 exit criterion, which only needs the walking skeleton deployed once, manually. Track full provisioning-CLI parity as a Phase 1 task; this task's scope is proving the Supabase client works, since that's the piece that's net-new versus the portal precedent.)*

---

## Task 19: Per-PR preview database via Supabase branching

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `docs/adr/0001-preview-database-strategy.md`

**Interfaces:**
- No new application code — this wires Supabase's native branching (one Postgres branch per PR, auto-seeded) into the existing CI workflow from Task 2.

- [ ] **Step 1: Write the ADR recording the decision (already settled per the roadmap, this task executes it)**

```markdown
# ADR 0001: Preview database strategy — Supabase branching

## Status
Accepted (2026-07-05, per `03-architecture.md` / `15-testing-strategy.md` §5.5)

## Context
Every PR needs an isolated, seeded database for its Vercel preview deployment
and Playwright regression run. herbe.portal's provisioning CLI creates a whole
new Neon *project* per tenant (Task 18) — too slow and too heavyweight to spin
up per-PR. Neon's per-branch model doesn't apply since herbe.service isn't on
Neon.

## Decision
Use Supabase's native database branching (one Postgres branch per PR, created
via the Supabase GitHub integration), auto-seeded via `scripts/migrate.mjs` +
`seedBaseline` (Task 7) as a post-branch-creation CI step.

## Consequences
- No custom branch-provisioning code needed — Supabase's GitHub App manages
  branch lifecycle (create on PR open, destroy on PR close/merge).
- CI must inject the per-branch `DATABASE_URL` Supabase's integration exposes
  as a GitHub Actions environment variable into the Playwright job.
- This is a different mechanism from Task 18's per-tenant project creation —
  branching is for ephemeral CI databases, project creation is for durable
  tenant deployments. Do not conflate the two.
```

- [ ] **Step 2: Install the Supabase GitHub integration** (manual, dashboard-driven — requires Prerequisite 4 org access): connect the herbe-service GitHub repo in the Supabase project's "Branching" settings, enable "Persistent branching" for pull requests.

- [ ] **Step 3: Extend the CI workflow to run migrations + seed against the PR's branch DB**

```yaml
# .github/workflows/ci.yml — add a job after `ci`
  preview-seed:
    needs: ci
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: node scripts/migrate.mjs
        env:
          DATABASE_URL: ${{ secrets.SUPABASE_BRANCH_DATABASE_URL }}
      - run: node -e "import('./lib/seed/scenarios/baseline.ts').then(m => m.seedBaseline())"
        env:
          DATABASE_URL: ${{ secrets.SUPABASE_BRANCH_DATABASE_URL }}
```

Note: `SUPABASE_BRANCH_DATABASE_URL` here is a placeholder secret name — the Supabase GitHub integration injects the actual per-branch connection string as a deployment-specific value once connected in Step 2; wire the exact variable name it exposes once that dashboard integration is live.

- [ ] **Step 4: Write a Playwright smoke test that runs against the real Vercel preview URL, logging in via Task 8/14's guarded test-login (`15-testing-strategy.md`: "run the Playwright regression suite against the real preview URL")**

```bash
pnpm dlx playwright install --with-deps chromium
```

```typescript
// e2e/health.spec.ts
import { expect, test } from '@playwright/test'

test('preview deployment is up and the guarded test-login mints a working session', async ({ page, request }) => {
  const loginRes = await request.post('/api/test/login', {
    data: { personaKey: 'office', tenantId: process.env.E2E_SEED_TENANT_ID },
  })
  expect(loginRes.status()).toBe(200)

  await page.goto('/customers')
  await expect(page).toHaveURL(/\/customers/)
})
```

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
  },
})
```

- [ ] **Step 5: Add the Playwright job to CI, pointed at the just-deployed Vercel preview URL**

```yaml
# .github/workflows/ci.yml — add after preview-seed
  preview-e2e:
    needs: preview-seed
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm dlx playwright install --with-deps chromium
      - run: pnpm playwright test
        env:
          PLAYWRIGHT_BASE_URL: ${{ github.event.deployment_status.target_url }}
          TEST_AUTH: '1'
          E2E_SEED_TENANT_ID: ${{ secrets.E2E_SEED_TENANT_ID }}
```

Note: wiring the real Vercel preview URL into `PLAYWRIGHT_BASE_URL` needs Vercel's `deployment_status` webhook/GitHub check — Vercel's own GitHub integration exposes this once the project is linked (Task 17, Step 3); the exact trigger condition may need adjusting to `on: deployment_status` once that's live rather than `pull_request`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml docs/adr/0001-preview-database-strategy.md e2e playwright.config.ts package.json
git commit -m "ci: seed per-PR Supabase branch database + Playwright smoke test against the real preview URL, ADR 0001"
```

---

## Task 20: ADR — local on-device database choice + device-at-rest security scope

**Files:**
- Create: `docs/adr/0002-local-database-choice.md`
- Create: `lib/offline/db.spike.test.ts` (throwaway comparison spike, deleted after the ADR is written if Dexie is confirmed — kept if the team wants a regression guard)

**Interfaces:**
- No production interface — this task's deliverable is the ADR document plus the evidence backing it.

- [ ] **Step 1: Write a spike test proving Dexie handles the two things RxDB would otherwise be chosen for — bulk upsert performance and schema versioning across app updates**

```typescript
// lib/offline/db.spike.test.ts
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { OfflineDb } from './db'

describe('Dexie spike: bulk upsert + schema versioning', () => {
  it('bulk-upserts 1000 customer records well within the offline-pull budget', async () => {
    const db = new OfflineDb()
    const records = Array.from({ length: 1000 }, (_, i) => ({
      id: `c${i}`,
      erpRef: `CUST${i}`,
      name: `Customer ${i}`,
      changeSeq: String(i),
    }))

    const start = performance.now()
    await db.customers.bulkPut(records)
    const elapsedMs = performance.now() - start

    expect(await db.customers.count()).toBe(1000)
    expect(elapsedMs).toBeLessThan(2000) // generous CI-safe ceiling
    await db.delete()
  })
})
```

- [ ] **Step 2: Run the spike, record the result**

Run: `pnpm vitest run lib/offline/db.spike.test.ts`
Expected: PASS with the actual elapsed time noted in the ADR below.

- [ ] **Step 3: Write the ADR**

```markdown
# ADR 0002: Local on-device database — Dexie over RxDB

## Status
Proposed — pending product-owner sign-off (Non-Code Prerequisite 6)

## Context
`03-architecture.md` names Dexie and RxDB as the two IndexedDB-wrapper
candidates, undecided. herbe.service needs: bulk upsert of delta-synced
records (customers, items, and in Phase 1 orders/worksheets/checklists),
an outbox of pending writes, and multi-tab consistency is *not* a
requirement (`05-users-auth.md`: one device session, PIN/biometric-gated,
not multiple simultaneous tabs/windows in the field).

## Decision
**Dexie.** RxDB's core differentiators over Dexie — built-in replication
protocol, multi-tab reactivity, RxJS-based reactive queries — solve problems
herbe.service doesn't have: replication is custom-built per `03-architecture.md`
(scoped delta pull + outbox, not a generic replication protocol), and the PWA
is single-tab-per-technician by design. Dexie's simpler API and smaller bundle
(important for the <3s cold-start budget on a mid-range Android phone) win
absent a concrete need for RxDB's extra machinery. Task 16's spike confirms
bulk-upsert performance is not a limiting factor either way (1000 records in
well under the offline-pull budget).

## Device-at-rest security scope (bundled per `03-architecture.md`'s framing)
Baseline, already decided and non-negotiable regardless of DB choice:
platform disk encryption + offline PIN/biometric app-lock (Task 15,
rate-limited, wipe-on-N-failures) + data minimization (briefcase horizon,
Phase 1) + remote wipe on next contact (Phase 1, device registry). App-layer
crypto (a local key wrapped by the PIN) is an explicitly optional hardening
step, not required for Phase 0/1 — revisit only if a tenant's compliance
requirements demand OS-keystore-backed encryption, which pushes them to the
native-wrapper path instead.

## Consequences
- No RxDB dependency; Dexie's `bulkPut`/`Table` API is what Task 16 and all
  future offline-store work builds on.
- If a future requirement needs multi-tab reactivity or a generic replication
  protocol, this ADR is the one to revisit — don't silently introduce RxDB
  alongside Dexie.
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0002-local-database-choice.md lib/offline/db.spike.test.ts
git commit -m "docs(adr): local DB choice (Dexie) + device-at-rest security scope, pending owner sign-off"
```

---

## Task 21: ADRs — sync mechanics (sequence-reset & key-sweep evidence, WSVc-native-trigger probe, PDF rendering approach)

**Files:**
- Create: `docs/adr/0003-sync-reconciliation.md`
- Create: `docs/adr/0004-pdf-rendering-approach.md`
- Create: `scripts/spikes/probe-wsvc-native-trigger.mjs`

**Interfaces:**
- No new production interfaces — this task documents decisions already substantially proven by Tasks 6, 10, and 11's passing tests, plus one manual spike script that needs Prerequisite 1 (dedicated test ERP) to actually run.

- [ ] **Step 1: Write ADR 0003, citing Task 11's tests as the evidence (sequence-reset recovery and key-sweep are the same mechanism — no separate code needed beyond what Task 11 built)**

```markdown
# ADR 0003: Sync reconciliation — key-sweep doubles as sequence-reset recovery

## Status
Accepted — mechanism implemented and tested in Task 11; live-ERP confirmation
pending Non-Code Prerequisite 2 (a planned ERP version upgrade during Phase 0/1).

## Context
`updates_after`/`@sequence` incremental sync (Task 10) is confirmed to work on
`CUVc` but is known to reset after ERP version upgrades (`19-demo-probe-results.md`).
`deletes_after` is confirmed unreliable everywhere (HTTP 204 empty body, even
on `CUVc`) — deletions can never be detected incrementally.

## Decision
One mechanism serves both problems: `keySweepReconcile` (Task 11) does a full
list-and-diff pass per register, independent of any cursor. Deletion detection
*requires* this full scan regardless of sequence-reset risk, so sequence-reset
recovery is free — a full reconciliation pass is already scheduled nightly per
register; on detecting the incremental cursor has gone stale (the ERP's
returned `@sequence` is lower than the stored cursor, indicating a reset), the
sync-tick dispatcher (Task 12) falls back to treating the next scheduled sweep
as authoritative rather than trusting the stale cursor.

## Consequences
- No separate "sequence-reset handler" module — it's an emergent property of
  always running key-sweep on a schedule. Do not build a second mechanism.
- Gap tolerance: a record deleted in the ERP may linger up to one sweep
  interval (nightly, Task 11) before the app sees the tombstone — acceptable
  for master data (customers/items); Phase 1 service-order deletions get a
  tighter, explicitly-flagged path instead of silent tombstoning
  (`04-erp-sync.md`).
- **Live confirmation still needed**: this ADR's sequence-reset-detection logic
  (comparing returned `@sequence` against the stored cursor) is not yet coded
  as of Task 11 — add a small guard in Task 12's dispatcher when Prerequisite 2
  (the planned version upgrade) is scheduled, so there's a real reset event to
  validate against instead of a synthetic one.
```

- [ ] **Step 2: Write the manual probe script for the WSVc-native-trigger question (needs Prerequisite 1 — a real test ERP — to actually run; the script itself is real, runnable code once that ERP exists)**

```javascript
// scripts/spikes/probe-wsvc-native-trigger.mjs
// Manual spike: create a Work Sheet via the REST register API only (WONr=-1,
// no WOVc), then a human checks the ERP UI for auto-generated stock movements
// or invoice drafts. Requires Prerequisite 1 (dedicated test ERP).
//
// Usage: node scripts/spikes/probe-wsvc-native-trigger.mjs
import { createStandardBooksAdapter } from '../../lib/erp/standard-books/adapter.ts'

const adapter = createStandardBooksAdapter({
  baseUrl: process.env.TEST_ERP_BASE_URL,
  companyNumber: process.env.TEST_ERP_COMPANY_NUMBER,
  auth: { kind: 'basic', username: process.env.TEST_ERP_USER, password: process.env.TEST_ERP_PASSWORD },
})

const { erpRef } = await adapter.pushCreate('WSVc', {
  SVOSerNr: process.argv[2], // pass an existing SVOVc SerNr as the first CLI arg
  WONr: -1,
  EMCode: process.env.TEST_ERP_TECH_CODE,
})

console.log(`Created WSVc ${erpRef}. Now check in the ERP UI:`)
console.log('  1. Stock module — did a stock movement get created for any rows?')
console.log('  2. Invoice module — did an invoice draft appear?')
console.log('  3. Record the answer in docs/adr/0003-sync-reconciliation.md addendum.')
```

- [ ] **Step 3: Write ADR 0004 (PDF rendering), recommending Gotenberg per the one concrete signal found in the spec (its use in `15-testing-strategy.md`'s Phase 1 smoke test implies it's the intended target) — flagged for owner confirmation since Phase 0 doesn't require it working yet**

```markdown
# ADR 0004: PDF rendering approach — Gotenberg (recommended, pending confirmation)

## Status
Proposed — pending product-owner sign-off (Non-Code Prerequisite 6). Not a
Phase 0 blocker: no PDF rendering ships until Phase 1's document engine
(`12-documents-templates.md`).

## Context
`06-roadmap.md` lists "PDF rendering approach" as a Phase 0 sync-spike output,
noting it "must also fit the DOCX pipeline" (`12-documents-templates.md`).
`15-testing-strategy.md` names Gotenberg as the container used for PDF-render
smoke tests — the only concrete signal in the spec docs, though no doc states
the decision outright.

## Decision (recommended, not yet confirmed)
Gotenberg — a stateless HTTP microservice wrapping LibreOffice + Chromium,
run as its own container (matches the fake-ERP server's "own small deployment"
pattern from Task 6). It renders both HTML→PDF (the built-in order-level
report) and DOCX→PDF (the mail-merge template engine) through one service,
avoiding a second rendering stack for the DOCX path.

## Alternative considered
Puppeteer/headless Chromium in-process: simpler for HTML→PDF alone, but
doesn't solve DOCX→PDF, meaning two rendering paths instead of one. Rejected
for that reason, not for capability.

## Consequences
- No code lands in Phase 0 either way — this ADR only needs to be confirmed
  before Phase 1's document engine starts, so it isn't designed twice.
- If confirmed, Gotenberg runs as a docker-compose service locally and its own
  small Vercel-adjacent deployment (or a Fly.io/Render container, since
  Gotenberg isn't a Vercel Function) in staging/production — record that
  infrastructure decision as an addendum once made.
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0003-sync-reconciliation.md docs/adr/0004-pdf-rendering-approach.md scripts/spikes
git commit -m "docs(adr): sync reconciliation mechanism + PDF rendering recommendation, pending owner sign-off"
```

---

## Task 22: ADR — scoped-replication membership model, proven via a scope-exit purge round trip

**Files:**
- Modify: `drizzle/schema.ts` (add `scopeMembership`)
- Create: `scripts/migrations/0007_scope_membership.sql`
- Create: `lib/sync/scope-membership.ts`
- Create: `docs/adr/0005-scoped-replication.md`
- Test: `lib/sync/scope-membership.test.ts`, extend `lib/offline/sync-client.test.ts`

**Interfaces:**
- Produces: `enterScope(db, { userId, entityType, entityId }): Promise<void>`, `exitScope(db, { userId, entityType, entityId }): Promise<void>`, `pullScopedDelta(db, { userId, sinceMembershipSeq }): Promise<{ upserts: unknown[]; exitedIds: string[]; cursor: string }>`. This validates the mechanism `03-architecture.md` specifies for Phase 1's assignment-scoped entities (orders/worksheets/bookings) — Phase 0 has no such entities yet, so this task proves the mechanism against a synthetic entity type (`'note'`) rather than inventing a fake worksheet just to exercise it.

**Why a synthetic entity, not a real one:** the customers/items this plan actually syncs (Tasks 10–16) are explicitly the *tenant-wide unfiltered* category in `03-architecture.md`'s scope model, not the assignment-scoped category — there is nothing in Phase 0's own data to scope-filter. Building a placeholder worksheet purely to test scoping would be exactly the kind of speculative, unused code the project avoids. A generic `entityType: string` membership table proves the mechanism (backfill-on-entry, purge-on-exit) without needing Phase 1's entities to exist first; Task Phase 1's dispatch/worksheet work then reuses this table unchanged, just pointing `entityType` at real values.

- [ ] **Step 1: Schema + migration for the scope membership table**

```typescript
// drizzle/schema.ts — add
export const scopeMembership = pgTable(
  'scope_membership',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    membershipSeq: bigint('membership_seq', { mode: 'bigint' }).notNull(),
    inScopeSince: timestamp('in_scope_since', { withTimezone: true }).notNull().defaultNow(),
    outScopeSeq: bigint('out_scope_seq', { mode: 'bigint' }),
  },
  (t) => [unique().on(t.userId, t.entityType, t.entityId), index('idx_scope_membership_seq').on(t.membershipSeq)],
)
```

```sql
-- scripts/migrations/0007_scope_membership.sql
CREATE TABLE IF NOT EXISTS scope_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  membership_seq BIGINT NOT NULL,
  in_scope_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  out_scope_seq BIGINT,
  UNIQUE (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_scope_membership_seq ON scope_membership (membership_seq);

CREATE OR REPLACE FUNCTION bump_membership_seq() RETURNS trigger AS $$
BEGIN
  NEW.membership_seq := nextval('domain_change_seq'); -- reuses Task 11's shared sequence, same monotonic space
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scope_membership_seq ON scope_membership;
CREATE TRIGGER trg_scope_membership_seq BEFORE INSERT OR UPDATE ON scope_membership
  FOR EACH ROW EXECUTE FUNCTION bump_membership_seq();
```

- [ ] **Step 2: Write the failing test — entry backfill and exit purge signal**

```typescript
// lib/sync/scope-membership.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { enterScope, exitScope, pullScopedDelta } from './scope-membership'

let container: StartedPostgreSqlContainer
let db: ReturnType<typeof drizzle>
let userId: string

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start()
  await runMigrations(container.getConnectionUri())
  db = drizzle(postgres(container.getConnectionUri()), { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't6', name: 'T6' }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email: 'tech.anna2@herbe-service.test' }).returning()
  userId = user.id
}, 60_000)

afterAll(async () => {
  await container.stop()
})

describe('scoped replication — entry backfill and exit purge', () => {
  it('a newly-scoped entity appears as a full upsert in the very next pull', async () => {
    await enterScope(db, { userId, entityType: 'note', entityId: 'note-1' })

    const delta = await pullScopedDelta(db, { userId, sinceMembershipSeq: '0' })

    expect(delta.upserts).toContainEqual(expect.objectContaining({ entityType: 'note', entityId: 'note-1' }))
    expect(delta.exitedIds).toEqual([])
  })

  it('exiting scope emits a purge signal the client applies as a local delete, not a data-level tombstone', async () => {
    const before = await pullScopedDelta(db, { userId, sinceMembershipSeq: '0' })

    await exitScope(db, { userId, entityType: 'note', entityId: 'note-1' })

    const after = await pullScopedDelta(db, { userId, sinceMembershipSeq: before.cursor })

    expect(after.exitedIds).toEqual(['note-1'])
    expect(after.upserts).toEqual([]) // the record itself isn't re-sent — only the exit signal
  })
})
```

- [ ] **Step 3: Run test, confirm it fails**

Run: `pnpm vitest run lib/sync/scope-membership.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement the membership functions**

```typescript
// lib/sync/scope-membership.ts
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import * as schema from '@/drizzle/schema'
import type { db as DbType } from '@/lib/db'

export async function enterScope(
  db: typeof DbType,
  opts: { userId: string; entityType: string; entityId: string },
): Promise<void> {
  await db
    .insert(schema.scopeMembership)
    .values({ userId: opts.userId, entityType: opts.entityType, entityId: opts.entityId, membershipSeq: 0n })
    .onConflictDoUpdate({
      target: [schema.scopeMembership.userId, schema.scopeMembership.entityType, schema.scopeMembership.entityId],
      set: { outScopeSeq: null, inScopeSince: sql`now()`, membershipSeq: sql`nextval('domain_change_seq')` },
    })
}

export async function exitScope(
  db: typeof DbType,
  opts: { userId: string; entityType: string; entityId: string },
): Promise<void> {
  await db
    .update(schema.scopeMembership)
    .set({ outScopeSeq: sql`nextval('domain_change_seq')`, membershipSeq: sql`nextval('domain_change_seq')` })
    .where(
      and(
        eq(schema.scopeMembership.userId, opts.userId),
        eq(schema.scopeMembership.entityType, opts.entityType),
        eq(schema.scopeMembership.entityId, opts.entityId),
      ),
    )
}

export async function pullScopedDelta(
  db: typeof DbType,
  opts: { userId: string; sinceMembershipSeq: string },
): Promise<{ upserts: Array<{ entityType: string; entityId: string }>; exitedIds: string[]; cursor: string }> {
  const rows = await db
    .select()
    .from(schema.scopeMembership)
    .where(and(eq(schema.scopeMembership.userId, opts.userId), gt(schema.scopeMembership.membershipSeq, BigInt(opts.sinceMembershipSeq))))

  const upserts = rows.filter((r) => r.outScopeSeq === null).map((r) => ({ entityType: r.entityType, entityId: r.entityId }))
  const exitedIds = rows.filter((r) => r.outScopeSeq !== null).map((r) => r.entityId)
  const cursor = rows.length ? String(rows[rows.length - 1].membershipSeq) : opts.sinceMembershipSeq

  return { upserts, exitedIds, cursor }
}
```

- [ ] **Step 5: Run test, confirm it passes**

Run: `pnpm vitest run lib/sync/scope-membership.test.ts`
Expected: PASS

- [ ] **Step 6: Extend the offline sync client to apply an exit signal as a local Dexie delete — this is the "round trip" the ADR claims proven: server emits exit → client purges**

```typescript
// lib/offline/sync-client.test.ts — add
it('purges a locally-cached record when the server reports it left scope', async () => {
  await db.customers.put({ id: 'c1', erpRef: 'CUST001', name: 'Test Client', changeSeq: '1' })

  global.fetch = vi.fn().mockResolvedValue({
    json: async () => ({ data: [], exitedIds: ['c1'], cursor: '6' }),
  }) as never

  const result = await pullDelta(db, { tenantId: 't1', sinceCursor: '5' })

  expect(result.cursor).toBe('6')
  expect(await db.customers.get('c1')).toBeUndefined()
})
```

```typescript
// lib/offline/sync-client.ts — extend pullDelta
export async function pullDelta(
  db: OfflineDb,
  opts: { tenantId: string; sinceCursor: string },
): Promise<{ cursor: string }> {
  const res = await fetch(`/api/sync/customers?tenantId=${opts.tenantId}&after=${opts.sinceCursor}`)
  const body = await res.json()

  await db.customers.bulkPut(body.data)
  if (body.exitedIds?.length) {
    await db.customers.bulkDelete(body.exitedIds)
  }

  return { cursor: body.cursor }
}
```

- [ ] **Step 7: Run test, confirm it passes**

Run: `pnpm vitest run lib/offline/sync-client.test.ts`
Expected: PASS

- [ ] **Step 8: Write the ADR**

```markdown
# ADR 0005: Scoped replication — membership table, proven via a synthetic scope-exit round trip

## Status
Accepted — mechanism implemented and tested (Task 22); full validation against
real assignment-scoped entities (orders/worksheets/bookings) happens in Phase 1
once those entities exist, per `06-roadmap.md`'s own framing ("scope model
validated in the Phase 0 sync spike").

## Context
`03-architecture.md`'s scoped-replication design requires a server-side
`(userId, entityType, entityId, inScopeSince, outScopeSeq)` table so a device's
delta feed can express "this record left your scope" — something a raw
high-water mark can't do. Phase 0 has no assignment-scoped entities yet
(orders/worksheets ship Phase 1), so this ADR validates the mechanism itself
against a generic `entityType` column, not a specific entity.

## Decision
Implemented exactly as specified: `scope_membership` rows carry their own
`membershipSeq` (drawn from the same shared `domain_change_seq` sequence as
Task 11's `changeSeq`, keeping one monotonic space); entering scope always
backfills as a full upsert regardless of the underlying record's own change
history; exiting scope emits an `outScopeSeq`-stamped row the client applies
as a local purge (Task 22, Step 6) — mechanically identical to a tombstone on
the client, but the server retains the data (a subscription change, not a
deletion).

## Consequences
- Phase 1's orders/worksheets/bookings scoping reuses `scope_membership`
  unchanged — just call `enterScope`/`exitScope` with real entity types
  (`'serviceOrder'`, `'worksheet'`, `'booking'`) at the assignment/reassignment
  mutation sites, per `03-architecture.md`.
- The reference-closure scoping (customers/sites/service-items an in-scope
  order points at) and the nightly horizon-advance job are Phase 1 work built
  on top of this table — not built here, since nothing yet references them.
- "Proven on-device" (the literal roadmap phrase) still needs a real Phase 1
  entity and a real paired device (Task 15) exercising the full loop end to
  end — this ADR proves the server-side mechanism and one client purge path,
  not the full field scenario.
```

- [ ] **Step 9: Commit**

```bash
git add drizzle scripts/migrations lib/sync/scope-membership.ts lib/sync/scope-membership.test.ts lib/offline/sync-client.ts lib/offline/sync-client.test.ts docs/adr/0005-scoped-replication.md
git commit -m "feat(sync): scope-membership table + scope-exit purge round trip, ADR 0005"
```

---

## Explicitly Deferred to Phase 1 (scope decisions, not omissions)

Called out here so they read as deliberate cuts, not gaps — each has a one-line reason and a pointer to where it picks back up:

- **Email-template/TemplateKey engine copy** (`03-architecture.md`, "copy-first everything else incl. the email-template engine") — Task 14's magic-link route logs the link to the console instead of sending real email. Nothing in the Phase 0 walking skeleton needs a delivered email (Task 17's demo consumes the token manually); copying herbe.portal's `lib/email/templates/*` now would sit unused until Phase 1's real notification sending (order report email, rejection notices). Copy it when the first real send lands.
- **Worksheet (`WSVc`) push, push-queue-per-order, DLQ/retry** (`04-erp-sync.md`) — Task 13 proves the outbox mechanism on the simplest round trip (`SVOVc` create, no identity-link precondition). `WSVc` push requires the ERP identity link (`erp_identity_links`, `05-users-auth.md`) and worksheet entities, neither of which exist until Phase 1.
- **Reference-closure and nightly horizon-advance job** for scoped replication (`03-architecture.md`) — Task 22 proves the membership-table mechanism; the closure computation (which customers/sites/items an in-scope order pulls in) has nothing to compute against until Phase 1 orders exist.
- **Full provisioning-CLI parity** (fork-overlay-repo, Vercel project creation, `customers.yaml` inventory, `rotate-secret`/`add-superadmin` subcommands) — Task 18 proves the net-new piece (the Supabase Management API client); the rest of portal's `executor.ts` orchestration ports over mechanically once a second real tenant needs provisioning, which isn't a Phase 0 requirement (the walking skeleton deploys to one project, Task 17).
- **Conflict-rule validation beyond master-data overwrite** (`03-architecture.md`: worksheet-facts-win, status-transition guards, same-field last-writer-wins) — Task 11's `onConflictDoUpdate` (ERP wins on customers/items) is the only conflict rule Phase 0 has data for. The richer rules apply to worksheets/status machines that don't exist yet — building a fake worksheet solely to test them would be speculative code with no caller.
- **Sequence-reset live confirmation** — ADR 0003 documents the mechanism (key-sweep doubles as recovery); actually observing a real reset needs Non-Code Prerequisite 2 (a planned ERP version upgrade), which is scheduled but hasn't happened yet.

---

## Exit Criteria (from `06-roadmap.md`, made concrete)

- [ ] **"Skeleton demo on a phone in airplane mode"** — Task 17, Step 8.
- [ ] **"Register map signed off"** — `CUVc`/`INVc`/`SVOVc` mechanics are implemented (Tasks 10, 11, 13) and match `17-erp-register-reference.md` + `19-demo-probe-results.md`; get explicit owner sign-off referencing this plan's Tasks 10/11/13 as the implementation.
- [ ] **"Reuse mechanics agreed with sibling-app owners"** — confirm with the herbe.calendar and herbe.portal teams that the copied/adapted code in Tasks 5 (`@herbe/erp-core`), 12 (cron lock), and 18 (provisioning client) matches what they expect to keep in sync with, per `08-suite-integration.md` §6.
- [ ] All 22 tasks' tests green in CI (Task 2's gate); coverage thresholds met (`lib/erp/**`, `packages/erp-core/**`, `lib/sync/**` ≥90%, overall ≥80%).
- [ ] ADRs 0001–0005 (Tasks 19–22) reviewed and accepted or overridden by the product owner (Non-Code Prerequisite 6).
- [ ] Playwright smoke test (Task 19) green against a real Vercel preview deployment, not just local `vitest`.
