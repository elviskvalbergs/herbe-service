// proxy.ts is Next 16's renamed middleware convention (see the file's own
// comment for why this repo uses `proxy.ts` instead of `middleware.ts`).
// `NextResponse.next({ request: { headers } })` doesn't expose the forwarded
// request headers directly on the response — Next encodes them as
// `x-middleware-request-<lowercased-header-name>` response headers, which the
// framework's internal request-patching machinery reads back out. That's the
// seam this test asserts against (verified empirically against the installed
// `next` package rather than assumed).
import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { proxy } from './proxy'

const INTL_HEADER_ON_RESPONSE = 'x-middleware-request-x-next-intl-locale'

function requestWithCookie(cookie?: string): NextRequest {
  return new NextRequest(new URL('http://localhost/some/path'), {
    headers: cookie ? new Headers({ cookie }) : undefined,
  })
}

describe('proxy locale resolution', () => {
  it('forwards the locale from a valid NEXT_LOCALE cookie', () => {
    const res = proxy(requestWithCookie('NEXT_LOCALE=en'))
    expect(res.headers.get(INTL_HEADER_ON_RESPONSE)).toBe('en')
  })

  it('falls back to the default locale (lv) when no cookie is present', () => {
    const res = proxy(requestWithCookie())
    expect(res.headers.get(INTL_HEADER_ON_RESPONSE)).toBe('lv')
  })

  it('falls back to the default locale (lv) for an invalid locale code', () => {
    const res = proxy(requestWithCookie('NEXT_LOCALE=xx'))
    expect(res.headers.get(INTL_HEADER_ON_RESPONSE)).toBe('lv')
  })

  it.each(['lv', 'en', 'et', 'lt', 'fi', 'sv', 'no'])('forwards locale %s unchanged', (locale) => {
    const res = proxy(requestWithCookie(`NEXT_LOCALE=${locale}`))
    expect(res.headers.get(INTL_HEADER_ON_RESPONSE)).toBe(locale)
  })
})
