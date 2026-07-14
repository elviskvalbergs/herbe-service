export const locales = ['lv', 'en', 'et', 'lt', 'fi', 'sv', 'no'] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = 'lv'

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value)
}
