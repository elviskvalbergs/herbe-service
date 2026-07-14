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
