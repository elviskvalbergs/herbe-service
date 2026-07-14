// lib/api/ext/tokens-store.ts
//
// Store for ext_tokens (Task 1 migration; drizzle/schema.ts extTokens /
// ExtTokenRow) — the scoped bearer tokens for the /api/ext/v1 read API
// (docs/08-suite-integration.md §4). Mints a raw token, persists only its
// sha256 hash (lib/security/tokens.ts), and returns the raw value once so
// callers can show it to the admin at mint time.
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { ExtTokenRow } from '@/drizzle/schema'
import { generateToken, hashToken } from '@/lib/security/tokens'

type Db = PostgresJsDatabase<typeof schema>

export interface MintExtTokenInput {
  tenantId: string
  erpCompanyId: string
  name: string
  customerCodes?: string[]
}

export interface MintExtTokenResult {
  id: string
  raw: string
}

/**
 * Generates a new token, persists its hash, and returns `{ id, raw }`. The
 * raw value is never stored — this is the only place it is available.
 */
export async function mintExtToken(db: Db, input: MintExtTokenInput): Promise<MintExtTokenResult> {
  const raw = generateToken()
  const tokenHash = hashToken(raw)

  const [row] = await db
    .insert(schema.extTokens)
    .values({
      tenantId: input.tenantId,
      erpCompanyId: input.erpCompanyId,
      name: input.name,
      tokenHash,
      customerCodes: input.customerCodes ?? [],
    })
    .returning()

  return { id: row.id, raw }
}

export async function findExtTokenByHash(db: Db, hash: string): Promise<ExtTokenRow | null> {
  const [row] = await db.select().from(schema.extTokens).where(eq(schema.extTokens.tokenHash, hash))
  return row ?? null
}

export async function touchExtToken(db: Db, id: string): Promise<void> {
  await db.update(schema.extTokens).set({ lastUsedAt: new Date() }).where(eq(schema.extTokens.id, id))
}

export async function revokeExtToken(db: Db, id: string): Promise<void> {
  await db.update(schema.extTokens).set({ revokedAt: new Date() }).where(eq(schema.extTokens.id, id))
}
