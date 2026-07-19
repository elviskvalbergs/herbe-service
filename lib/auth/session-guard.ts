import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { auth } from '@/lib/auth'
import type { Session } from 'next-auth'

type Db = PostgresJsDatabase<typeof schema>

export async function bumpSessionVersion(db: Db, userId: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, userId))
}

// Routes that must honor revocation (role change, device wipe, offboarding)
// call this instead of `auth()` directly. jwtCallback/sessionCallback stay
// pure and forward the sign-in-time sessionVersion unchanged (same pattern
// as authTime) — this is the one place that compares it against the
// current DB value.
export async function getVerifiedSession(db: Db): Promise<Session | null> {
  const session = await auth()
  const sessionVersion = (session?.user as { sessionVersion?: number } | undefined)?.sessionVersion
  if (!session?.user?.id || typeof sessionVersion !== 'number') return null

  const [row] = await db.select({ sessionVersion: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, session.user.id))
  if (!row || row.sessionVersion !== sessionVersion) return null

  return session
}
