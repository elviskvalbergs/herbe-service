import { describe, expect, it } from 'vitest'
import { locales } from '@/lib/i18n/config'
import requestConfig from '@/lib/i18n/request'

describe('i18n request config', () => {
  it('passes through a valid requested locale and loads its catalog', async () => {
    const result = await requestConfig({ requestLocale: Promise.resolve('en') })
    expect(result.locale).toBe('en')
    expect(result.messages).toBeTypeOf('object')
  })

  // Locale catalogs are currently placeholder `{}` files (translations land in a
  // later task); this asserts every locale's file resolves without throwing —
  // a typo'd filename here would break the app at request time.
  it.each(locales)('resolves the message catalog file for locale %s', async (locale) => {
    const result = await requestConfig({ requestLocale: Promise.resolve(locale) })
    expect(result.locale).toBe(locale)
    expect(result.messages).toBeTypeOf('object')
    expect(result.messages).not.toBeNull()
  })

  it('falls back to the default locale for an unknown locale', async () => {
    const result = await requestConfig({ requestLocale: Promise.resolve('xx') })
    expect(result.locale).toBe('lv')
  })

  it('falls back to the default locale when no locale is requested', async () => {
    const result = await requestConfig({ requestLocale: Promise.resolve(undefined) })
    expect(result.locale).toBe('lv')
  })
})
