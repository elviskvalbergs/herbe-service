import { describe, expect, it, vi } from 'vitest'

// `getLocale()`/`getMessages()` (next-intl/server) ultimately read the
// request locale via `next/headers`' `headers()`, which throws outside a
// real Next.js request. Mocking it to return the header proxy.ts forwards
// (X-NEXT-INTL-LOCALE) simulates an incoming request that already resolved
// to locale 'en'.
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'X-NEXT-INTL-LOCALE': 'en' }),
}))

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
