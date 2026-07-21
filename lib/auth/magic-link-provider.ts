// lib/auth/magic-link-provider.ts
//
// The suite's magic-link login is a Credentials provider (lib/auth/config.ts)
// that validates a pre-issued, single-use, DB-backed token — not Auth.js's
// built-in Email provider, which needs a mail transport at authorize-time and
// doesn't fit the "issue now, consume later" shape (portal's pattern).
//
// `issueMagicLinkToken` mints the raw token and stores only its SHA-256 hash;
// the raw token is never persisted, only ever returned to the caller to embed
// in the link. `authorizeMagicLink` looks the hash up, consumes it (so a
// replayed/reused link is rejected), and resolves it to a PRE-EXISTING user
// keyed on tenant+email — it never self-provisions. FIX-2 (docs/27): the old
// auto-create let anyone holding a tenant UUID mint themselves an account the
// moment a mail transport existed.
import crypto from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

const TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes

type Db = PostgresJsDatabase<typeof schema>

export async function issueMagicLinkToken(
  db: Db,
  opts: { tenantId: string; email: string },
): Promise<{ token: string }> {
  const token = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')

  await db.insert(schema.magicLinkTokens).values({
    tokenHash,
    tenantId: opts.tenantId,
    email: opts.email,
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  })

  return { token }
}

export async function authorizeMagicLink(
  db: Db,
  opts: { token: string },
): Promise<{ id: string; email: string; tenantId: string; role: string; sessionVersion: number } | null> {
  const tokenHash = crypto.createHash('sha256').update(opts.token).digest('hex')

  // Atomic single-use consume: one UPDATE that only matches an unconsumed,
  // unexpired token and stamps consumedAt in the same statement, RETURNING the
  // row. Two concurrent calls with the same token therefore race on the row
  // lock — exactly one gets a returned row, the other gets zero rows → null.
  // (A SELECT-then-UPDATE split has a window where both callers pass the SELECT
  // before either UPDATE commits, letting a token be consumed twice — Task 14
  // review 2026-07-09.)
  const [record] = await db
    .update(schema.magicLinkTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.magicLinkTokens.tokenHash, tokenHash),
        isNull(schema.magicLinkTokens.consumedAt),
        gt(schema.magicLinkTokens.expiresAt, new Date()),
      ),
    )
    .returning()

  if (!record) return null

  // Resolve to an existing user only — a magic link authenticates, it does not
  // provision (FIX-2). The token is already consumed above, so a link for an
  // unknown email is spent without granting anything.
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, record.tenantId), eq(schema.users.email, record.email)))

  if (!user) return null

  return { id: user.id, email: user.email, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion }
}
