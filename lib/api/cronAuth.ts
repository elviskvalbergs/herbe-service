import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time compare of `Authorization: Bearer <secret>`.
 *
 * Length-checks before comparing so `timingSafeEqual` (which throws on
 * mismatched buffer lengths) is never called with unequal-length buffers.
 * Copied from herbe-calendar's lib/api/cronAuth.ts.
 *
 * Returns true when the header matches. Pass either the raw `Authorization`
 * header value or null.
 */
export function bearerMatches(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false
  const expected = `Bearer ${secret}`
  const a = Buffer.from(authHeader)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
