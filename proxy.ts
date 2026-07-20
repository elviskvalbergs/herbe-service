import { NextRequest, NextResponse } from 'next/server'
import { defaultLocale, isLocale } from '@/lib/i18n/config'

// Next 16 renamed the `middleware` file convention to `proxy` (see
// nextjs.org/docs/messages/middleware-to-proxy). Crucially, `proxy.ts` defaults
// to the Node.js runtime (not Edge), which is why this replaces the old
// middleware.ts: under the webpack build (forced for next-pwa), the Edge
// middleware bundle pulled in a CommonJS module referencing `__dirname` and
// threw "ReferenceError: __dirname is not defined" at runtime on every page.
// Node has __dirname, so the Node-runtime proxy sidesteps it. Do NOT set a
// `runtime` config key here — proxy files throw if `runtime` is specified.
//
// WS1 Task 2 (i18n wiring): reads the NEXT_LOCALE cookie, validates it against
// the canonical locale list (`@/lib/i18n/config`), falls back to
// `defaultLocale`, and forwards the result via INTL_LOCALE_HEADER. next-intl's
// own `HEADER_LOCALE_NAME` constant (verified against the installed
// next-intl@4.13.1 source) is literally 'X-NEXT-INTL-LOCALE', which is also
// herbe-portal's constant name/value for the same header — kept identical
// here so the convention is recognizable suite-wide. `requestLocale` in
// `lib/i18n/request.ts` needs no change: next-intl's `getRequestConfig` reads
// the request locale from this exact header when present.
const NEXT_LOCALE_COOKIE = 'NEXT_LOCALE'
const INTL_LOCALE_HEADER = 'X-NEXT-INTL-LOCALE'

export function proxy(request: NextRequest) {
  const cookieLocale = request.cookies.get(NEXT_LOCALE_COOKIE)?.value
  const locale = cookieLocale && isLocale(cookieLocale) ? cookieLocale : defaultLocale

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set(INTL_LOCALE_HEADER, locale)

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
