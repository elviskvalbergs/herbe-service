import { NextRequest, NextResponse } from 'next/server'

// Next 16 renamed the `middleware` file convention to `proxy` (see
// nextjs.org/docs/messages/middleware-to-proxy). Crucially, `proxy.ts` defaults
// to the Node.js runtime (not Edge), which is why this replaces the old
// middleware.ts: under the webpack build (forced for next-pwa), the Edge
// middleware bundle pulled in a CommonJS module referencing `__dirname` and
// threw "ReferenceError: __dirname is not defined" at runtime on every page.
// Node has __dirname, so the Node-runtime proxy sidesteps it. Do NOT set a
// `runtime` config key here — proxy files throw if `runtime` is specified.
//
// Locale constants are inlined (kept self-contained) rather than imported from
// `@/lib/i18n/config`; that remains the canonical source for all other app code.
const LOCALES: readonly string[] = ['lv', 'en', 'et', 'lt', 'fi', 'sv', 'no']
const DEFAULT_LOCALE = 'lv'
const isLocale = (value: string): boolean => LOCALES.includes(value)

export function proxy(request: NextRequest) {
  const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value
  const locale = cookieLocale && isLocale(cookieLocale) ? cookieLocale : DEFAULT_LOCALE

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-NEXT-INTL-LOCALE', locale)

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
