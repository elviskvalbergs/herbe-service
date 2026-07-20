import { describe, expect, it, vi } from 'vitest'
import { locales } from '@/lib/i18n/config'

// `LocaleSwitcher` itself is a 'use client' component using `useLocale()`/
// `useRouter()` — hooks require an active React renderer, which this
// project's Vitest setup doesn't have (no jsdom/@testing-library — see
// app/layout.test.tsx's comments for the underlying constraint). The
// cookie-building logic is extracted as a pure function specifically so it
// stays unit-testable without one.
//
// Merely importing the module still evaluates bare 'next-intl's barrel
// export (which pulls in the real NextIntlClientProvider's module-level
// `createContext` call — see app/layout.test.tsx for the full explanation)
// and next/navigation's app-router context (same `createContext` issue), so
// both need a stub here purely to make the module loadable. (vi.mock calls
// are hoisted above imports, so this takes effect before the static import
// below runs.)
vi.mock('next-intl', () => ({ useLocale: () => 'en' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

import { buildLocaleCookie } from './locale-switcher'

describe('buildLocaleCookie', () => {
  it('builds a NEXT_LOCALE cookie string for the given locale', () => {
    expect(buildLocaleCookie('en')).toBe('NEXT_LOCALE=en; path=/; max-age=31536000; SameSite=Lax')
  })

  it.each(locales)('round-trips locale %s into the cookie value', (locale) => {
    const cookie = buildLocaleCookie(locale)
    expect(cookie.startsWith(`NEXT_LOCALE=${locale};`)).toBe(true)
  })
})
