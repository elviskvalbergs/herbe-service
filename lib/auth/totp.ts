import crypto from 'node:crypto'
import { Secret, TOTP } from 'otpauth'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { hashPassword, verifyPassword } from './password'
import { decryptMfaSecret, encryptMfaSecret, type StoredMfaSecret } from './totp-secret'
import { bumpSessionVersion } from './session-guard'

type Db = PostgresJsDatabase<typeof schema>

const ISSUER = 'herbe.service'
const RECOVERY_CODE_COUNT = 10

function buildTotp(secretBase32: string, email: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: email,
    issuerInLabel: true,
    secret: Secret.fromBase32(secretBase32),
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  })
}

// 16 random bytes -> 32 hex chars -> 4 dash-joined groups of 8
// (e.g. "a1b2c3d4-e5f6a7b8-c9d0e1f2-a3b4c5d6").
function generateRecoveryCode(): string {
  const hex = crypto.randomBytes(16).toString('hex')
  return hex.match(/.{1,8}/g)!.join('-')
}

export interface EnrollResult {
  otpauthUri: string
  secretBase32: string
  recoveryCodes: string[]
}

// Does NOT set mfaEnabled — confirmTotpEnrollment does, only after the
// caller proves they can generate a valid code from the just-issued secret.
export async function enrollTotp(db: Db, userId: string, email: string): Promise<EnrollResult> {
  const secret = new Secret({ size: 20 })
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode)
  const recoveryHashes = await Promise.all(recoveryCodes.map((c) => hashPassword(c)))

  const stored: StoredMfaSecret = { secretBase32: secret.base32, recoveryHashes }
  await db.update(schema.users).set({ mfaSecretEncrypted: encryptMfaSecret(stored) }).where(eq(schema.users.id, userId))

  const totp = buildTotp(secret.base32, email)
  return { otpauthUri: totp.toString(), secretBase32: secret.base32, recoveryCodes }
}

export async function confirmTotpEnrollment(db: Db, userId: string, code: string): Promise<boolean> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  if (!user?.mfaSecretEncrypted) return false

  const stored = decryptMfaSecret(user.mfaSecretEncrypted)
  const totp = buildTotp(stored.secretBase32, user.email)
  const delta = totp.validate({ token: code.trim(), window: 1 })
  if (delta === null) return false

  await db.update(schema.users).set({ mfaEnabled: true }).where(eq(schema.users.id, userId))
  return true
}

// bumpSession defaults to true: a successful verify (other than at login,
// which passes bumpSession:false) invalidates any other live session for
// this user — turning MFA on, or re-verifying it, should force a stale or
// already-compromised session elsewhere to re-authenticate.
export async function verifyTotp(
  db: Db,
  userId: string,
  code: string,
  opts: { bumpSession?: boolean } = {},
): Promise<boolean> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId))
  if (!user?.mfaSecretEncrypted) return false

  const stored = decryptMfaSecret(user.mfaSecretEncrypted)
  const totp = buildTotp(stored.secretBase32, user.email)
  const delta = totp.validate({ token: code.trim(), window: 1 })
  if (delta === null) return false

  // Absolute epoch index (not the raw delta) so two separate requests at
  // delta=0 don't look identical without a stable reference point. Atomic
  // conditional UPDATE: only a strictly-increasing epoch claims the row, so
  // two concurrent submissions of the same valid code can't both succeed.
  const epochIndex = Math.floor(Date.now() / 1000 / 30) + delta
  const claimed = await db
    .update(schema.users)
    .set({ mfaTotpLastUsedEpoch: epochIndex })
    .where(
      and(
        eq(schema.users.id, userId),
        or(isNull(schema.users.mfaTotpLastUsedEpoch), lt(schema.users.mfaTotpLastUsedEpoch, epochIndex)),
      ),
    )
    .returning({ id: schema.users.id })
  if (claimed.length === 0) return false

  if (opts.bumpSession ?? true) await bumpSessionVersion(db, userId)
  return true
}

export async function consumeRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).for('update')
    if (!user?.mfaSecretEncrypted) return false

    const stored = decryptMfaSecret(user.mfaSecretEncrypted)
    let matchedIdx = -1
    for (let i = 0; i < stored.recoveryHashes.length; i++) {
      if (await verifyPassword(stored.recoveryHashes[i], code.trim())) {
        matchedIdx = i
        break
      }
    }
    if (matchedIdx === -1) return false

    const nextHashes = stored.recoveryHashes.filter((_, i) => i !== matchedIdx)
    await tx
      .update(schema.users)
      .set({ mfaSecretEncrypted: encryptMfaSecret({ ...stored, recoveryHashes: nextHashes }) })
      .where(eq(schema.users.id, userId))
    return true
  })
}

export async function disableTotp(db: Db, userId: string, code: string): Promise<boolean> {
  const valid = (await verifyTotp(db, userId, code, { bumpSession: false })) || (await consumeRecoveryCode(db, userId, code))
  if (!valid) return false

  await db.update(schema.users).set({ mfaSecretEncrypted: null, mfaEnabled: false }).where(eq(schema.users.id, userId))
  await bumpSessionVersion(db, userId)
  return true
}
