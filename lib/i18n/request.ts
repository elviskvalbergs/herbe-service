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
