// lib/auth/rate-limit.ts
//
// FIX-7 (docs/27): rate limiter for the auth endpoints. The /api/ext limiter
// (lib/api/ext/rate-limit.ts) is keyed on an ext-token uuid, which auth
// requests don't have — they must throttle by IP+tenant+email. Same fixed 60s
// window, atomic upsert-increment shape (429 + Retry-After), against a
// text-keyed table (auth_rate_limit, migration 0025). Kept separate from the
// ext limiter rather than generalized: the ext table's uuid key can't hold a
// composite text key, and the two limiters have independent policies.
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

const WINDOW_MS = 60_000

const DEFAULT_POLICY = { maxPerMinute: 10 }

const POLICY: Record<string, { maxPerMinute: number }> = {
  // A real caller requests a magic link once or twice; anything above this is
  // enumeration / token-row flooding.
  'magic-link': { maxPerMinute: 5 },
  // Login runs one argon2.verify per attempt (the CPU-DoS lever) and gates the
  // TOTP check; 10/min per identity leaves room for fat-fingered retries.
  login: { maxPerMinute: 10 },
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number }

/**
 * Fixed 60s window counter keyed on (key, endpoint). `key` is an opaque
 * composite the caller builds — for the auth endpoints that's
 * `${ip}|${tenantId}|${email}`. Increments the bucket for the current window
 * and compares the returned count against the endpoint's policy (falls back to
 * DEFAULT_POLICY for unlisted endpoints). Pass `nowMs` for deterministic
 * tests; defaults to Date.now().
 */
export async function checkAuthRateLimit(
  db: Db,
  key: string,
  endpoint: string,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const policy = POLICY[endpoint] ?? DEFAULT_POLICY
  const windowStartMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
  const windowStart = new Date(windowStartMs)

  const [row] = await db
    .insert(schema.authRateLimit)
    .values({ key, endpoint, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [schema.authRateLimit.key, schema.authRateLimit.endpoint, schema.authRateLimit.windowStart],
      set: { count: sql`${schema.authRateLimit.count} + 1` },
    })
    .returning({ count: schema.authRateLimit.count })

  if (row.count <= policy.maxPerMinute) return { allowed: true }

  const retryAfterSec = Math.ceil((windowStartMs + WINDOW_MS - nowMs) / 1000)
  return { allowed: false, retryAfterSec }
}

/**
 * Best-effort client IP for rate-limit keying. Behind Vercel / most proxies
 * the left-most x-forwarded-for hop is the client; fall back to x-real-ip,
 * then a constant so the limiter still buckets by tenant+email with no IP.
 */
export function clientIpFrom(request?: Request): string {
  const xff = request?.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return request?.headers.get('x-real-ip') ?? 'unknown'
}
