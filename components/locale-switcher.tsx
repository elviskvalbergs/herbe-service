'use client'

import { useLocale } from 'next-intl'
import { useRouter } from 'next/navigation'
import { isLocale, locales, type Locale } from '@/lib/i18n/config'

// Native names, kept simple per WS1 Task 2 (no per-locale translation of the
// switcher's own labels — a language name reads fine in its own language).
const LOCALE_LABELS: Record<Locale, string> = {
  lv: 'Latviešu',
  en: 'English',
  et: 'Eesti',
  lt: 'Lietuvių',
  fi: 'Suomi',
  sv: 'Svenska',
  no: 'Norsk',
}

// Must match the cookie name `proxy.ts` reads (NEXT_LOCALE_COOKIE there).
const NEXT_LOCALE_COOKIE = 'NEXT_LOCALE'

// Pure and exported so it's unit-testable without a DOM/hook renderer (this
// project's Vitest setup has neither — see app/layout.test.tsx for why).
export function buildLocaleCookie(locale: Locale): string {
  return `${NEXT_LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; SameSite=Lax`
}

// Standalone for now — Task 5 (field "More" tab) and Task 6 (office settings
// stub) wire this into their pages. Reads the current locale from the
// NextIntlClientProvider context set up in app/layout.tsx, so no `value`
// prop is needed from the caller.
export function LocaleSwitcher() {
  const locale = useLocale()
  const router = useRouter()

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value
    if (!isLocale(next)) return
    document.cookie = buildLocaleCookie(next)
    router.refresh()
  }

  return (
    <select value={locale} onChange={handleChange} aria-label="Language">
      {locales.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  )
}
