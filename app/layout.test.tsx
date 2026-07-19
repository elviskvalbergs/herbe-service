import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { DisplayScheme } from '@/lib/settings/user-prefs'

// `getLocale()`/`getMessages()` (next-intl/server) ultimately read the
// request locale via `next/headers`' `headers()`, which throws outside a
// real Next.js request. Mocking it to return the header proxy.ts forwards
// (X-NEXT-INTL-LOCALE) simulates an incoming request that already resolved
// to locale 'en'.
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'X-NEXT-INTL-LOCALE': 'en' }),
}))

// The layout now also resolves the signed-in user's persisted display
// scheme (getVerifiedSession -> getUserPrefs), both of which go through
// `@/lib/db`, which reads DATABASE_URL at module-load time. Same convention
// as app/page.test.tsx / app/api/settings/route.test.ts: mock `@/lib/auth`'s
// `auth()` seam and point DATABASE_URL at a real harness Postgres before the
// layout is first dynamically imported.
const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeUser(tenantSlug: string, email: string, displayScheme?: DisplayScheme) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: tenantSlug, name: tenantSlug }).returning()
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email, role: 'technician', ...(displayScheme ? { displayScheme } : {}) })
    .returning()
  return user
}

function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

// `next-intl/config` is normally aliased to `./lib/i18n/request.ts` by the
// webpack plugin (`createNextIntlPlugin` in next.config.ts) — that aliasing
// only happens inside a real Next.js build, so it must be stood in for here.
// `vi.importActual` (not a plain dynamic `import()` inside the factory,
// which deadlocks — verified: hangs indefinitely under this project's
// react-server-conditioned module graph) loads the REAL request.ts, so this
// test exercises the actual production request-config logic and the actual
// `locales/en.json` file content, not a duplicate/stub of either.
vi.mock('next-intl/config', async () => {
  const actual = await vi.importActual<typeof import('@/lib/i18n/request')>('@/lib/i18n/request')
  return { default: actual.default }
})

// The real `NextIntlClientProvider` (bare 'next-intl') is a "use client"
// component whose module-level code calls React's `createContext` — an API
// stripped from the 'react-server' condition build that vitest.config.ts
// forces project-wide (required so lib/i18n/request.ts resolves next-intl's
// server export). Under Next.js's real RSC bundler, this "use client"
// boundary is swapped for a lightweight reference at build time and its
// real implementation never executes server-side; Vitest has no such
// bundler, so importing the real module crashes here (verified:
// `(0 , createContext) is not a function`, reproduced identically whether
// next-intl's `use-intl` dependency is inlined or externalized in Vitest's
// module resolution). Stubbing the wrapper tests THIS file's wiring —
// which locale/messages/children get threaded into the provider — without
// re-verifying next-intl's own internals, which are next-intl's concern.
vi.mock('next-intl', () => ({
  NextIntlClientProvider: (props: { locale: string; messages: unknown; children: unknown }) => props,
}))

type El<P> = { type: unknown; props: P }

describe('RootLayout i18n wiring', () => {
  it('resolves the request locale end to end and renders NextIntlClientProvider with the real message catalog', async () => {
    const { default: RootLayout } = await import('./layout')
    const { NextIntlClientProvider } = await import('next-intl')
    const enMessages = (await import('@/locales/en.json')).default

    const element = (await RootLayout({ children: 'child-marker' })) as El<{
      lang: string
      children: El<{ children: unknown }>
    }>

    // <html lang> is resolved from the request, not hardcoded.
    expect(element.type).toBe('html')
    expect(element.props.lang).toBe('en')

    const body = element.props.children
    expect(body.type).toBe('body')

    const provider = body.props.children as El<{ locale: string; messages: unknown; children: unknown }>
    expect(provider.type).toBe(NextIntlClientProvider)
    expect(provider.props.locale).toBe('en')
    // The real locales/en.json content flows through unchanged — not a stub.
    expect(provider.props.messages).toEqual(enMessages)
    expect(provider.props.children).toBe('child-marker')
  })

  it('renders an actual translated string sourced from locales/en.json through the real getTranslations pipeline', async () => {
    const { default: RootLayout } = await import('./layout')
    const { getTranslations } = await import('next-intl/server')

    // Exercises the real request-config -> message-catalog -> translator
    // chain (same APIs a page/component would call), not a hardcoded string.
    const t = await getTranslations('app')
    const translated = t('name')
    expect(translated).toBe('herbe.service')

    const element = (await RootLayout({ children: translated })) as El<{
      children: El<{ children: El<{ children: unknown }> }>
    }>
    const provider = element.props.children.props.children
    expect(provider.props.children).toBe(translated)
  })
})

describe('RootLayout display scheme wiring', () => {
  beforeEach(() => {
    authMock.mockReset()
  })

  it('sets neither data-theme nor data-scheme when there is no session', async () => {
    authMock.mockResolvedValue(null)
    const { default: RootLayout } = await import('./layout')

    const element = (await RootLayout({ children: 'child' })) as El<{
      'data-theme'?: string
      'data-scheme'?: string
    }>

    expect(element.props['data-theme']).toBeUndefined()
    expect(element.props['data-scheme']).toBeUndefined()
  })

  it('sets neither attribute for a session with displayScheme "standard"', async () => {
    const user = await makeUser('layout-standard', 'standard@herbe-service.test', 'standard')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: RootLayout } = await import('./layout')

    const element = (await RootLayout({ children: 'child' })) as El<{
      'data-theme'?: string
      'data-scheme'?: string
    }>

    expect(element.props['data-theme']).toBeUndefined()
    expect(element.props['data-scheme']).toBeUndefined()
  })

  it('sets data-theme="dark" for a session with displayScheme "dark"', async () => {
    const user = await makeUser('layout-dark', 'dark@herbe-service.test', 'dark')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: RootLayout } = await import('./layout')

    const element = (await RootLayout({ children: 'child' })) as El<{
      'data-theme'?: string
      'data-scheme'?: string
    }>

    expect(element.props['data-theme']).toBe('dark')
    expect(element.props['data-scheme']).toBeUndefined()
  })

  it('sets data-scheme="sunlight" for a session with displayScheme "sunlight"', async () => {
    const user = await makeUser('layout-sunlight', 'sunlight@herbe-service.test', 'sunlight')
    authMock.mockResolvedValue(sessionFor(user))
    const { default: RootLayout } = await import('./layout')

    const element = (await RootLayout({ children: 'child' })) as El<{
      'data-theme'?: string
      'data-scheme'?: string
    }>

    expect(element.props['data-scheme']).toBe('sunlight')
    expect(element.props['data-theme']).toBeUndefined()
  })
})
