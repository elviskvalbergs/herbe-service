import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { getDummyPasswordHash, verifyPassword } from './password'
import { consumeRecoveryCode, verifyTotp } from './totp'

type Db = PostgresJsDatabase<typeof schema>

export interface AuthorizedCredentialsUser {
  id: string
  email: string
  tenantId: string
  role: string
  sessionVersion: number
}

// Every path — no such user, no password set, wrong password, non-admin
// role — runs exactly one real argon2.verify call (against the real hash or
// the memoized dummy hash) before branching, so response time never signals
// which failure occurred.
export async function authorizeCredentials(
  db: Db,
  opts: { tenantId: string; email: string; password: string; totp?: string },
): Promise<AuthorizedCredentialsUser | null> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, opts.tenantId), eq(schema.users.email, opts.email)))

  const hashToCheck = user?.passwordHash ?? (await getDummyPasswordHash())
  const passwordOk = await verifyPassword(hashToCheck, opts.password)

  if (!user || !user.passwordHash || !passwordOk) return null
  if (user.role !== 'admin') return null

  if (user.mfaEnabled) {
    if (!opts.totp) return null
    const ok = (await verifyTotp(db, user.id, opts.totp, { bumpSession: false })) || (await consumeRecoveryCode(db, user.id, opts.totp))
    if (!ok) return null
  }

  return { id: user.id, email: user.email, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion }
}
