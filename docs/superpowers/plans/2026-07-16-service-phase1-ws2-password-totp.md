# herbe.service Phase 1 — WS2 extension: password + TOTP for admin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the `docs/05-users-auth.md` §Login-methods line "Optional per tenant: password (argon2) + TOTP for admin roles" — scoped to the literal `admin` role, no tenant-config toggle (none exists yet).

**Architecture:** password hashing via the `argon2` package already in this repo (used today for PIN hashing); TOTP secret + recovery-code hashes packed as one JSON blob and encrypted through the **already-existing** `lib/security/envelope.ts` (ported from portal by WS3, proven live) using the exact same `keyId(16)||nonce(12)||ciphertext` base64-text packing `lib/erp/credentials.ts` already established — no new crypto primitive, no new storage convention. A second NextAuth `Credentials` provider sits alongside the existing `magic_link` one; `jwtCallback`/`sessionCallback` need no changes since they already generically carry whatever `{id,email,tenantId,role,sessionVersion}` any provider's `authorize` returns (built in the roles/session-revocation slice this extends).

**Tech Stack:** `argon2` (already a dependency), `otpauth` (new dependency, same version portal uses), Drizzle/Postgres, Vitest.

Continues on branch `feature/service-phase1-ws2-roles-identity` (already pushed once as the roles/session-revocation/device-registry/identity-link slice; this extends the same PR since doc21 §WS2 lists password+TOTP as the same workstream's own deliverable, and it depends on that slice's `role`/`hasCapability`/`getVerifiedSession`/`bumpSessionVersion`).
Worktree: `/Users/elviskvalbergs/AI/herbe-service/.claude/worktrees/service-phase1-ws2-roles-identity`.

## Global Constraints

- `pnpm exec tsc --noEmit` clean after every task.
- `pnpm exec vitest run` all green after every task.
- `pnpm exec vitest run --coverage` exit 0. Overall gate 80%; nothing here touches the 90%-gated paths.
- Migrations: `scripts/migrations/NNNN_*.sql`, next free number is **0019** (0018 is the last existing one, added earlier in this same branch), idempotent (`IF NOT EXISTS`).
- No comments explaining *what* code does, only non-obvious *why*.
- **Scope is admin-only.** Every enrollment/login-provider check enforces `role === 'admin'` literally. Do not build this generically for all roles — doc05 and the user's own request both scope it to admin.
- **No UI in this slice** (same boundary the rest of WS2 used for the device registry) — API/lib only. No `qrcode` dependency (nothing renders a QR code yet); the enroll/start route returns the raw `otpauthUri` + `secretBase32` for a future UI to render.
- **Timing-safe by construction:** every `authorizeCredentials` call path — user not found, no password set, wrong password, non-admin role — must run exactly one real `argon2.verify` call (against the real hash or a memoized dummy hash), so response time doesn't leak which failure occurred.
- Security: never log a password, TOTP code, TOTP secret, or recovery code anywhere. Recovery codes are returned to the caller exactly once (at `enroll/start`) and never persisted or logged in plaintext — only their argon2 hashes are stored.

---

## Context (verified by reading the actual code)

- **`lib/security/envelope.ts`** already exists (ported from portal by WS3, live-proven): `encrypt(plaintext: Buffer|string): EncryptedBlob` / `decrypt(record: EncryptedBlob): Buffer`, `EncryptedBlob = {ciphertext, nonce, keyId, algoVersion}`, `ALGO_VERSION = 1`. Reuse directly, no changes.
- **`lib/erp/credentials.ts`** is the exact packing convention to mirror for a *new* encrypted-blob column: `Buffer.concat([Buffer.from(blob.keyId,'utf8'), blob.nonce, blob.ciphertext])`, and on read: slice `keyId` (first 16 bytes as utf8), `nonce` (next 12 bytes), remainder is ciphertext — stored as a `text` column via `.toString('base64')` (**herbe-service's own convention — not portal's `bytea`**, per doc24 §2's note that this repo already diverged from portal's storage type here).
- **`argon2` package (v0.44, already a dependency — used today in `lib/auth/device-enrollment.ts` for PIN hashing)**: `argon2.hash(password, options)` / `argon2.verify(hash, password)`. Options shape: `{ type: argon2.argon2id, memoryCost, timeCost, parallelism }` (verify these exact option names against the installed package's type definitions at implementation time — `node_modules/argon2/argon2.d.ts` — before writing `password.ts`, since this plan's numbers are carried over from a sibling app's `@node-rs/argon2` usage, a *different* npm package with likely-but-not-guaranteed-identical option names).
- **Current `users` table** (this branch's tip, after the roles/session-revocation slice): `id, tenantId, email, role (text, default 'technician'), sessionVersion (integer, default 1), createdAt`. This task adds four more nullable/defaulted columns — no existing column changes.
- **Current `lib/auth/config.ts`**: one `Credentials` provider (`id: 'magic_link'`). `jwtCallback`/`sessionCallback` already carry `role`/`sessionVersion` generically from whatever `user` object a provider's `authorize` returns — confirmed by reading the file: the `signIn` branch does `token.role = user.role; token.sessionVersion = user.sessionVersion ?? 1` unconditionally, not gated to a specific provider id. **Adding a second provider requires zero changes to the callbacks.**
- **`getVerifiedSession`/`bumpSessionVersion`** (`lib/auth/session-guard.ts`) and **`hasCapability`/`Role`** (`lib/auth/roles.ts`) already exist from earlier in this same branch — reuse both.
- **Reference implementation researched from herbe-portal** (a sibling app, NOT this repo — adapt, don't copy verbatim; file paths below are in the *portal* repo, for pattern reference only):
  - `lib/auth/totp.ts` — `otpauth`'s `Secret`/`TOTP` classes: `new Secret({size:20})`, `Secret.fromBase32(base32)`, `new TOTP({issuer,label,issuerInLabel:true,secret,algorithm:'SHA1',digits:6,period:30})`, `totp.toString()` → `otpauth://...` URI, `totp.validate({token,window:1})` → `-1|0|1|null` (±1 step = ±30s tolerance).
  - Replay guard: an integer column storing the **absolute epoch index** (`Math.floor(Date.now()/1000/30) + delta`, not the raw delta) claimed via a single atomic `UPDATE ... WHERE lastEpoch IS NULL OR lastEpoch < epochIndex`, so two concurrent submissions of the same valid code can't both succeed.
  - Recovery-code consumption: row-locked transaction (`.for('update')` — verify this exact drizzle-orm API against the installed version at implementation time), splice the matched hash out of the array, re-encrypt, rewrite — prevents a race where two concurrent requests both match the same code before either write commits.
  - Portal's own recovery-code doc-comment and its own test disagreed on the exact byte-count/grouping (a real inconsistency in the reference implementation) — **do not copy that regex blindly**; this plan specifies its own format below, self-consistent.
  - Portal hardcodes a dummy Argon2 hash string for timing parity. **This plan does it differently and more robustly**: compute the dummy hash once, lazily, via the *same* `hashPassword` function used everywhere else (`dummyHashPromise ??= hashPassword('...')`), guaranteeing identical cost parameters and sidestepping any cross-package PHC-string-format question.
- **No password-reset-by-email flow exists or is being built** (Phase 0 has no email transport, per the existing `magic-link/request/route.ts` comment) — bootstrapping a password is self-service: an admin who's already signed in via magic link calls `POST /api/auth/password/set` to set one.

---

## Task 1 — Password hashing + migration

**Files:**
- Create: `scripts/migrations/0019_users_password_totp.sql`
- Modify: `drizzle/schema.ts` (add 4 columns to the `users` table block)
- Create: `lib/auth/password.ts`
- Create: `lib/auth/password.test.ts`

**`scripts/migrations/0019_users_password_totp.sql`:**

```sql
-- scripts/migrations/0019_users_password_totp.sql
--
-- WS2 (docs/05-users-auth.md "Login methods are role-shaped" — "Optional
-- per tenant: password (argon2) + TOTP for admin roles"). Scoped to the
-- admin role in application code only (no DB-level role constraint, same
-- as the rest of this repo's role handling). mfa_secret_encrypted packs
-- {secretBase32, recoveryHashes} as JSON through the same envelope
-- convention lib/erp/credentials.ts already uses for api_creds_encrypted:
-- keyId(16)||nonce(12)||ciphertext, base64-encoded into this text column.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret_encrypted" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_totp_last_used_epoch" integer;
```

**`drizzle/schema.ts`** — add these four fields to the existing `users` pgTable block (after `sessionVersion`, before `createdAt`):

```typescript
    passwordHash: text('password_hash'),
    mfaSecretEncrypted: text('mfa_secret_encrypted'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaTotpLastUsedEpoch: integer('mfa_totp_last_used_epoch'),
```

**`lib/auth/password.ts`** — the full file (verify `argon2`'s option names against `node_modules/argon2`'s types before finalizing; adjust if they differ from what's shown):

```typescript
import argon2 from 'argon2'

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

let dummyHashPromise: Promise<string> | null = null

// Timing-parity decoy for authorizeCredentials (Task 3): computed once via
// the SAME hashPassword function used for real passwords, so a "no such
// user" / "no password set" path costs exactly one real argon2.verify call,
// identical to a real wrong-password path — no branch-timing signal for
// account enumeration.
export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('dummy-password-for-timing-parity-never-matches-anything')
  return dummyHashPromise
}
```

- [ ] **Step 1: Write `lib/auth/password.test.ts` first**

```typescript
import { describe, expect, it } from 'vitest'
import { getDummyPasswordHash, hashPassword, verifyPassword } from './password'

describe('hashPassword / verifyPassword', () => {
  it('round-trips: a hashed password verifies against the original', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword(hash, 'wrong password')).toBe(false)
  })

  it('returns false (not throw) for a malformed hash', async () => {
    expect(await verifyPassword('not-a-real-argon2-hash', 'anything')).toBe(false)
  })

  it('produces a different hash string each time (random salt), both still verifying', async () => {
    const a = await hashPassword('same input')
    const b = await hashPassword('same input')
    expect(a).not.toBe(b)
    expect(await verifyPassword(a, 'same input')).toBe(true)
    expect(await verifyPassword(b, 'same input')).toBe(true)
  })
})

describe('getDummyPasswordHash', () => {
  it('memoizes: returns the exact same hash on repeated calls', async () => {
    const first = await getDummyPasswordHash()
    const second = await getDummyPasswordHash()
    expect(first).toBe(second)
  })

  it('never verifies against a real-looking password', async () => {
    const dummy = await getDummyPasswordHash()
    expect(await verifyPassword(dummy, 'correct horse battery staple')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it, confirm it fails** (`password.ts` doesn't exist) — `pnpm exec vitest run lib/auth/password.test.ts`.
- [ ] **Step 3: Add the migration**, add the 4 columns to `drizzle/schema.ts`, create `lib/auth/password.ts` with the content above (after checking argon2's actual option names).
- [ ] **Step 4: Run `pnpm exec vitest run lib/auth/password.test.ts`** — all 6 pass.
- [ ] **Step 5: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 6: Commit**

```bash
git add scripts/migrations/0019_users_password_totp.sql drizzle/schema.ts lib/auth/password.ts lib/auth/password.test.ts
git commit -m "feat(auth): argon2 password hashing + users password/TOTP columns"
```

---

## Task 2 — TOTP secret packing + core TOTP logic

**Files:**
- Modify: `package.json` (add `"otpauth": "^9.3.6"`)
- Create: `lib/auth/totp-secret.ts`
- Create: `lib/auth/totp-secret.test.ts`
- Create: `lib/auth/totp.ts`
- Create: `lib/auth/totp.test.ts`

**Interfaces consumed:** `encrypt`/`decrypt`/`ALGO_VERSION` from `@/lib/security/envelope` (existing). `hashPassword`/`verifyPassword` from `./password` (Task 1). `bumpSessionVersion` from `./session-guard` (existing, earlier in this branch).

**Step 1: `pnpm add otpauth@^9.3.6`** (from the worktree root).

**`lib/auth/totp-secret.ts`** — the full file:

```typescript
import { ALGO_VERSION, decrypt, encrypt } from '@/lib/security/envelope'

const KEY_ID_BYTES = 16
const NONCE_BYTES = 12

export interface StoredMfaSecret {
  secretBase32: string
  recoveryHashes: string[]
}

// Same packing convention as lib/erp/credentials.ts's encryptErpCredentials:
// keyId(16) || nonce(12) || ciphertext, base64-encoded into one text column.
export function encryptMfaSecret(secret: StoredMfaSecret): string {
  const blob = encrypt(JSON.stringify(secret))
  return Buffer.concat([Buffer.from(blob.keyId, 'utf8'), blob.nonce, blob.ciphertext]).toString('base64')
}

export function decryptMfaSecret(packedBase64: string): StoredMfaSecret {
  const packed = Buffer.from(packedBase64, 'base64')
  const keyId = packed.subarray(0, KEY_ID_BYTES).toString('utf8')
  const nonce = packed.subarray(KEY_ID_BYTES, KEY_ID_BYTES + NONCE_BYTES)
  const ciphertext = packed.subarray(KEY_ID_BYTES + NONCE_BYTES)
  const plaintext = decrypt({ keyId, nonce, ciphertext, algoVersion: ALGO_VERSION }).toString('utf8')
  return JSON.parse(plaintext) as StoredMfaSecret
}
```

- [ ] **Step 2: Write `lib/auth/totp-secret.test.ts` first** (no DB needed — pure, but needs `MASTER_ENCRYPTION_KEY` set, same as any envelope-consuming test):

```typescript
import { beforeAll, describe, expect, it } from 'vitest'
import { decryptMfaSecret, encryptMfaSecret } from './totp-secret'

beforeAll(() => {
  process.env.MASTER_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4)
})

describe('encryptMfaSecret / decryptMfaSecret', () => {
  it('round-trips secretBase32 and recoveryHashes', () => {
    const original = { secretBase32: 'JBSWY3DPEHPK3PXP', recoveryHashes: ['hash-one', 'hash-two'] }
    const packed = encryptMfaSecret(original)
    expect(decryptMfaSecret(packed)).toEqual(original)
  })

  it('produces a different packed blob each time (random nonce), both still decrypting to the same value', () => {
    const original = { secretBase32: 'JBSWY3DPEHPK3PXP', recoveryHashes: [] }
    const a = encryptMfaSecret(original)
    const b = encryptMfaSecret(original)
    expect(a).not.toBe(b)
    expect(decryptMfaSecret(a)).toEqual(original)
    expect(decryptMfaSecret(b)).toEqual(original)
  })
})
```

- [ ] **Step 3: Run it, confirm it fails, then implement `totp-secret.ts`, confirm it passes.**

**`lib/auth/totp.ts`** — the full file (verify `otpauth`'s exact export names/API and drizzle-orm's `.transaction()`/`.for('update')` support against installed packages before finalizing — this plan's shapes are carried over from a sibling app's usage of the same `otpauth` version, but confirm signatures match):

```typescript
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
// (e.g. "a1b2c3d4-e5f6a7b8-c9d0e1f2-a3b4c5d6"). Self-consistent with the
// test below — unlike the sibling app's reference implementation, whose
// doc-comment and test disagreed on the grouping.
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
```

- [ ] **Step 4: Write `lib/auth/totp.test.ts` first** (DB-backed, mirrors `lib/auth/identity-link.test.ts`'s `createTestDatabase()` harness):

```typescript
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { TOTP, Secret } from 'otpauth'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { consumeRecoveryCode, confirmTotpEnrollment, disableTotp, enrollTotp, verifyTotp } from './totp'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  process.env.MASTER_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4)
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeAdminUser() {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `totp-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email: 'admin@example.test', role: 'admin' })
    .returning()
  return user
}

function currentCodeFor(secretBase32: string, email: string): string {
  const totp = new TOTP({ issuer: 'herbe.service', label: email, issuerInLabel: true, secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
  return totp.generate()
}

describe('TOTP enrollment + verification', () => {
  it('enrollTotp issues an otpauth URI, a base32 secret, and 10 dash-grouped recovery codes; mfaEnabled stays false', async () => {
    const user = await makeAdminUser()
    const result = await enrollTotp(db, user.id, user.email)

    expect(result.otpauthUri).toContain('otpauth://totp/')
    expect(result.recoveryCodes).toHaveLength(10)
    for (const code of result.recoveryCodes) {
      expect(code).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/)
    }

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(false)
    expect(row.mfaSecretEncrypted).toBeTruthy()
  })

  it('confirmTotpEnrollment activates mfaEnabled only with a valid current code', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)

    expect(await confirmTotpEnrollment(db, user.id, '000000')).toBe(false)
    let [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(false)

    const validCode = currentCodeFor(enrolled.secretBase32, user.email)
    expect(await confirmTotpEnrollment(db, user.id, validCode)).toBe(true)
    ;[row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(true)
  })

  it('verifyTotp accepts a valid code once and rejects the identical code on replay', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const code = currentCodeFor(enrolled.secretBase32, user.email)
    expect(await verifyTotp(db, user.id, code, { bumpSession: false })).toBe(true)
    expect(await verifyTotp(db, user.id, code, { bumpSession: false })).toBe(false)
  })

  it('verifyTotp bumps session_version by default, but not when bumpSession:false', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    await verifyTotp(db, user.id, currentCodeFor(enrolled.secretBase32, user.email), { bumpSession: false })
    let [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.sessionVersion).toBe(1)

    await verifyTotp(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))
    ;[row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.sessionVersion).toBe(2)
  })

  it('consumeRecoveryCode accepts a valid code once and rejects it on reuse', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const [code] = enrolled.recoveryCodes
    expect(await consumeRecoveryCode(db, user.id, code)).toBe(true)
    expect(await consumeRecoveryCode(db, user.id, code)).toBe(false)
  })

  it('disableTotp clears the secret, flips mfaEnabled false, and bumps session_version', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const ok = await disableTotp(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))
    expect(ok).toBe(true)

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, user.id))
    expect(row.mfaEnabled).toBe(false)
    expect(row.mfaSecretEncrypted).toBeNull()
    expect(row.sessionVersion).toBe(2)
  })

  it('disableTotp accepts a recovery code instead of a TOTP code', async () => {
    const user = await makeAdminUser()
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const ok = await disableTotp(db, user.id, enrolled.recoveryCodes[1])
    expect(ok).toBe(true)
  })
})
```

- [ ] **Step 5: Run it, confirm it fails, then implement `totp.ts`, confirm all 7 tests pass.**
- [ ] **Step 6: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml lib/auth/totp-secret.ts lib/auth/totp-secret.test.ts lib/auth/totp.ts lib/auth/totp.test.ts
git commit -m "feat(auth): TOTP enrollment, verification (replay-guarded), recovery codes"
```

---

## Task 3 — password + TOTP Credentials provider

**Files:**
- Create: `lib/auth/credentials-provider.ts`
- Create: `lib/auth/credentials-provider.test.ts`
- Modify: `lib/auth/config.ts` (add the second provider — no callback changes)

**Interfaces consumed:** `hashPassword`/`verifyPassword`/`getDummyPasswordHash` (Task 1), `verifyTotp`/`consumeRecoveryCode` (Task 2).

**`lib/auth/credentials-provider.ts`** — the full file:

```typescript
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
```

**`lib/auth/config.ts` modification** — add a second entry to the existing `providers` array (after the `magic_link` one), no other changes:

```typescript
    Credentials({
      id: 'credentials',
      name: 'Email + Password',
      credentials: {
        tenantId: { type: 'text' },
        email: { type: 'email' },
        password: { type: 'password' },
        totp: { type: 'text' },
      },
      authorize: async (credentials) => {
        return authorizeCredentials(db, {
          tenantId: credentials.tenantId as string,
          email: credentials.email as string,
          password: credentials.password as string,
          totp: credentials.totp as string | undefined,
        })
      },
    }),
```

Add `import { authorizeCredentials } from './credentials-provider'` to `config.ts`'s existing imports.

- [ ] **Step 1: Write `lib/auth/credentials-provider.test.ts` first** (DB-backed):

```typescript
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { TOTP, Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { hashPassword } from './password'
import { enrollTotp, confirmTotpEnrollment } from './totp'
import { authorizeCredentials } from './credentials-provider'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  process.env.MASTER_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4)
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

async function makeUser(opts: { role: string; password?: string }) {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `cred-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const passwordHash = opts.password ? await hashPassword(opts.password) : null
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email: 'user@example.test', role: opts.role, passwordHash })
    .returning()
  return { user, tenantId: tenant.id }
}

function currentCodeFor(secretBase32: string, email: string): string {
  const totp = new TOTP({ issuer: 'herbe.service', label: email, issuerInLabel: true, secret: Secret.fromBase32(secretBase32), algorithm: 'SHA1', digits: 6, period: 30 })
  return totp.generate()
}

describe('authorizeCredentials', () => {
  it('returns the user for a correct admin password with no MFA enabled', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    const result = await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple' })
    expect(result).toEqual({ id: user.id, email: user.email, tenantId, role: 'admin', sessionVersion: 1 })
  })

  it('returns null for a wrong password', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'wrong' })).toBeNull()
  })

  it('returns null for an email with no corresponding user', async () => {
    const { tenantId } = await makeUser({ role: 'admin', password: 'x' })
    expect(await authorizeCredentials(db, { tenantId, email: 'nobody@example.test', password: 'anything' })).toBeNull()
  })

  it('returns null for a user with no password set', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin' })
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'anything' })).toBeNull()
  })

  it('returns null for a non-admin role even with the correct password', async () => {
    const { user, tenantId } = await makeUser({ role: 'technician', password: 'correct horse battery staple' })
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple' })).toBeNull()
  })

  it('requires a valid totp code when MFA is enabled, and rejects a missing/wrong one', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple' })).toBeNull()
    expect(await authorizeCredentials(db, { tenantId, email: user.email, password: 'correct horse battery staple', totp: '000000' })).toBeNull()

    const result = await authorizeCredentials(db, {
      tenantId,
      email: user.email,
      password: 'correct horse battery staple',
      totp: currentCodeFor(enrolled.secretBase32, user.email),
    })
    expect(result?.id).toBe(user.id)
  })

  it('accepts a recovery code in place of a totp code when MFA is enabled', async () => {
    const { user, tenantId } = await makeUser({ role: 'admin', password: 'correct horse battery staple' })
    const enrolled = await enrollTotp(db, user.id, user.email)
    await confirmTotpEnrollment(db, user.id, currentCodeFor(enrolled.secretBase32, user.email))

    const result = await authorizeCredentials(db, {
      tenantId,
      email: user.email,
      password: 'correct horse battery staple',
      totp: enrolled.recoveryCodes[0],
    })
    expect(result?.id).toBe(user.id)
  })
})
```

- [ ] **Step 2: Run it, confirm it fails, then implement `credentials-provider.ts` + the `config.ts` addition, confirm all 7 tests pass.**
- [ ] **Step 3: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 4: Commit**

```bash
git add lib/auth/credentials-provider.ts lib/auth/credentials-provider.test.ts lib/auth/config.ts
git commit -m "feat(auth): password+TOTP Credentials provider, admin-only"
```

---

## Task 4 — password/TOTP self-service routes

**Files:**
- Create: `app/api/auth/password/set/route.ts` + `route.test.ts`
- Create: `app/api/auth/totp/enroll/start/route.ts` + `route.test.ts`
- Create: `app/api/auth/totp/enroll/finish/route.ts` + `route.test.ts`
- Create: `app/api/auth/totp/disable/route.ts` + `route.test.ts`

**Interfaces consumed:** `getVerifiedSession` (existing, `lib/auth/session-guard.ts`), `hashPassword` (Task 1), `enrollTotp`/`confirmTotpEnrollment`/`verifyTotp`/`disableTotp` (Task 2). Test harness mirrors `app/api/auth/devices/route.test.ts`'s `vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))` pattern (since `getVerifiedSession` calls `auth()` internally).

**`POST /api/auth/password/set`** — self-service, admin-only, sets/replaces the caller's own password:

```typescript
// app/api/auth/password/set/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hashPassword } from '@/lib/auth/password'

const MIN_PASSWORD_LENGTH = 12

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })
  if (session.user.role !== 'admin') return new Response('Forbidden', { status: 403 })

  const { password } = (await request.json()) as { password?: string }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return Response.json({ error: 'password_too_short' }, { status: 400 })
  }

  const passwordHash = await hashPassword(password)
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, session.user.id))

  return Response.json({ status: 'ok' })
}
```

**`POST /api/auth/totp/enroll/start`** — admin-only; if MFA is already enabled, requires the current valid code before allowing re-enrollment (prevents a hijacked session from silently swapping the secret):

```typescript
// app/api/auth/totp/enroll/start/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { enrollTotp, verifyTotp } from '@/lib/auth/totp'

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })
  if (session.user.role !== 'admin') return new Response('Forbidden', { status: 403 })

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, session.user.id))
  if (!user) return new Response('Unauthorized', { status: 401 })

  if (user.mfaEnabled) {
    const { currentCode } = (await request.json().catch(() => ({}))) as { currentCode?: string }
    if (!currentCode || !(await verifyTotp(db, user.id, currentCode, { bumpSession: false }))) {
      return new Response('Forbidden', { status: 403 })
    }
  }

  const result = await enrollTotp(db, user.id, user.email)
  return Response.json(result)
}
```

**`POST /api/auth/totp/enroll/finish`** — admin-only, body `{code}`:

```typescript
// app/api/auth/totp/enroll/finish/route.ts
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { confirmTotpEnrollment } from '@/lib/auth/totp'

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })
  if (session.user.role !== 'admin') return new Response('Forbidden', { status: 403 })

  const { code } = (await request.json()) as { code?: string }
  if (typeof code !== 'string') return new Response('Bad Request', { status: 400 })

  const ok = await confirmTotpEnrollment(db, session.user.id, code)
  if (!ok) return Response.json({ error: 'invalid_code' }, { status: 400 })

  return Response.json({ status: 'ok' })
}
```

**`POST /api/auth/totp/disable`** — self-service, no role gate needed (only admins can ever have MFA enabled in the first place, since only the admin-gated enroll routes can turn it on):

```typescript
// app/api/auth/totp/disable/route.ts
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { disableTotp } from '@/lib/auth/totp'

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 })

  const { code } = (await request.json()) as { code?: string }
  if (typeof code !== 'string') return new Response('Bad Request', { status: 400 })

  const ok = await disableTotp(db, session.user.id, code)
  if (!ok) return Response.json({ error: 'invalid_code' }, { status: 400 })

  return Response.json({ status: 'ok' })
}
```

- [ ] **Step 1: Write all four `route.test.ts` files first**, mirroring `app/api/auth/devices/route.test.ts`'s exact harness (`vi.mock('@/lib/auth', ...)`, `authMock`, `createTestDatabase`). Cover per route:
  - `password/set`: 401 no session; 403 non-admin; 400 password under 12 chars; 200 + `passwordHash` set and verifiable on success.
  - `totp/enroll/start`: 401 no session; 403 non-admin; 200 with `otpauthUri`/`secretBase32`/10 `recoveryCodes` when MFA not yet enabled; when MFA already enabled, 403 without a valid `currentCode`, 200 (re-enrolled, new secret) with a valid one.
  - `totp/enroll/finish`: 401 no session; 403 non-admin; 400 `invalid_code` for a wrong code; 200 + `mfaEnabled` true in the DB for a correct code.
  - `totp/disable`: 401 no session; 400 `invalid_code` for a wrong code; 200 + `mfaEnabled` false and `sessionVersion` bumped for a correct TOTP code; 200 for a correct recovery code too.
- [ ] **Step 2: Run all four, confirm they fail** (routes don't exist).
- [ ] **Step 3: Create the four route files** with the content above.
- [ ] **Step 4: Run `pnpm exec vitest run app/api/auth/password app/api/auth/totp`** — all green.
- [ ] **Step 5: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 6: Commit**

```bash
git add app/api/auth/password app/api/auth/totp
git commit -m "feat(auth): password set + TOTP enroll/disable routes, admin-only"
```

---

## Task 5 — doc24 update + push

- [ ] **Step 1:** Edit `docs/24-phase1-status-and-parallel-handoff.md`:
  - §5 (added by the earlier part of this same slice): add a paragraph noting password (argon2) + TOTP for admin is now done — `lib/auth/password.ts`, `lib/auth/totp.ts`, `lib/auth/totp-secret.ts` (reusing `lib/security/envelope.ts`, no new crypto primitive), the `credentials` NextAuth provider, and the 4 self-service routes. Note explicitly: admin-only, no UI (routes return raw `otpauthUri`/secret for a future UI to render as a QR code), no password-reset-by-email flow (bootstrapped via `POST /api/auth/password/set` while already signed in via magic link).
  - Remove "TOTP + password" from the "Deferred out of this slice" list — only WebAuthn, Baltic eID, Entra ID OIDC, and seat/license enforcement remain deferred.
  - Refresh the "Last updated" line.
- [ ] **Step 2: Commit**

```bash
git add docs/24-phase1-status-and-parallel-handoff.md
git commit -m "docs(service): WS2 password+TOTP for admin done"
```

- [ ] **Step 3: Push** (same branch, already tracks `origin/feature/service-phase1-ws2-roles-identity`):

```bash
git push
```

## Self-Review checklist

- [ ] Every function signature used across tasks (`hashPassword`, `verifyPassword`, `getDummyPasswordHash`, `encryptMfaSecret`, `decryptMfaSecret`, `enrollTotp`, `confirmTotpEnrollment`, `verifyTotp`, `consumeRecoveryCode`, `disableTotp`, `authorizeCredentials`) matches identically everywhere it's called.
- [ ] No password, TOTP code, TOTP secret, or recovery code ever appears in a `console.log`/test-failure-message anywhere.
- [ ] Admin-only gating is enforced at every entry point that can enable/disable/use MFA or set a password (the Credentials provider itself, `password/set`, `totp/enroll/start`, `totp/enroll/finish`) — `totp/disable` is deliberately self-service without a role re-check, since only an admin could have gotten MFA enabled in the first place.
