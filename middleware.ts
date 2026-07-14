import { NextRequest, NextResponse } from 'next/server'
import { defaultLocale, isLocale } from '@/lib/i18n/config'

export function middleware(request: NextRequest) {
  const cookieLocale = request.cookies.get('NEXT_LOCALE')?.value
  const locale = cookieLocale && isLocale(cookieLocale) ? cookieLocale : defaultLocale

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('X-NEXT-INTL-LOCALE', locale)

  return NextResponse.next({ request: { headers: requestHeaders } })
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
