// lib/api/ext/rate-limit.ts
//
// Token-keyed rate limiter for the /api/ext/v1 read API
// (docs/08-suite-integration.md §"Phase 1 (framework only)": "...rate
// limiting from day one (429 + Retry-After; calendar's lib/rateLimit.ts
// pattern)"). Fixed 60s window, backed by the ext_rate_limit counter table
// (Task 6 migration; drizzle/schema.ts extRateLimit) keyed on
// (tokenId, endpoint, windowStart). Each call does one atomic
// upsert-increment via ON CONFLICT DO UPDATE ... RETURNING count, so
// concurrent requests within the same window can't race past the cap.
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

const WINDOW_MS = 60_000

const DEFAULT_POLICY = { maxPerMinute: 120 }

const POLICY: Record<string, { maxPerMinute: number }> = {
  'service-items': { maxPerMinute: 120 },
  'service-items.detail': { maxPerMinute: 240 },
  'service-items.history': { maxPerMinute: 240 },
  orders: { maxPerMinute: 120 },
  'orders.detail': { maxPerMinute: 240 },
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number }

/**
 * Fixed 60s window counter keyed on (tokenId, endpoint). Increments the
 * bucket for the current window and compares the returned count against the
 * endpoint's policy (falls back to DEFAULT_POLICY for unlisted endpoints).
 * Pass `nowMs` for deterministic tests; defaults to Date.now().
 */
export async function checkExtRateLimit(
  db: Db,
  tokenId: string,
  endpoint: string,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const policy = POLICY[endpoint] ?? DEFAULT_POLICY
  const windowStartMs = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS
  const windowStart = new Date(windowStartMs)

  const [row] = await db
    .insert(schema.extRateLimit)
    .values({ tokenId, endpoint, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [schema.extRateLimit.tokenId, schema.extRateLimit.endpoint, schema.extRateLimit.windowStart],
      set: { count: sql`${schema.extRateLimit.count} + 1` },
    })
    .returning({ count: schema.extRateLimit.count })

  if (row.count <= policy.maxPerMinute) return { allowed: true }

  const retryAfterSec = Math.ceil((windowStartMs + WINDOW_MS - nowMs) / 1000)
  return { allowed: false, retryAfterSec }
}
