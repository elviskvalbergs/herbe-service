import { NextRequest, NextResponse } from 'next/server'

// Locale constants are inlined here (rather than imported from
// `@/lib/i18n/config`) because this middleware runs on Vercel's Edge runtime,
// whose bundler rejects the aliased cross-module import at deploy time
// ("The Edge Function 'middleware' is referencing unsupported modules").
// Keep this list in sync with lib/i18n/config.ts — that remains the canonical
// source for all non-Edge app code.
const LOCALES: readonly string[] = ['lv', 'en', 'et', 'lt', 'fi', 'sv', 'no']
const DEFAULT_LOCALE = 'lv'
const isLocale = (value: string): boolean => LOCALES.includes(value)

export function middleware(request: NextRequest) {
  const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value
  const locale = cookieLocale && isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-NEXT-INTL-LOCALE', locale)

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
