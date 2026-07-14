// lib/api/ext/auth.ts
//
// Bearer-token verification for the /api/ext/v1 read API, plus
// `resolveScopeCodes`: the caller's requested `customerCodes` narrow, never
// widen, the token's own customer-code scope
// (docs/08-suite-integration.md:86). Resolves an incoming request to the
// token's (tenantId, erpCompanyId) and a scope-resolution closure; route
// handlers use this instead of touching lib/api/ext/tokens-store.ts or
// lib/security/tokens.ts directly.
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { hashToken } from '@/lib/security/tokens'
import { findExtTokenByHash, touchExtToken } from '@/lib/api/ext/tokens-store'

type Db = PostgresJsDatabase<typeof schema>

export type VerifiedExt = {
  ok: true
  tenantId: string
  erpCompanyId: string
  tokenId: string
  tokenCustomerCodes: string[]
  /**
   * Resolves the customer codes a request may read, intersecting `requested`
   * with the token's own scope — never widening it. Empty token scope means
   * the token is unrestricted (all customers of the company).
   */
  resolveScopeCodes(requested?: string[]): string[]
}

export type ExtAuthError = {
  ok: false
  status: 401 | 403
  code: 'no_token' | 'invalid_token' | 'revoked'
}

/** Verifies the `Authorization: Bearer <token>` header of an ext API request. */
export async function verifyExtRequest(db: Db, req: Request): Promise<VerifiedExt | ExtAuthError> {
  const authHeader = req.headers.get('Authorization')
  const match = authHeader?.match(/^Bearer (.+)$/)
  if (!match) return { ok: false, status: 401, code: 'no_token' }

  const row = await findExtTokenByHash(db, hashToken(match[1]))
  if (!row) return { ok: false, status: 401, code: 'invalid_token' }
  if (row.revokedAt) return { ok: false, status: 401, code: 'revoked' }

  // Fire-and-forget: don't block the response on this write, and don't fail
  // the request if it errors.
  void touchExtToken(db, row.id).catch(() => {})

  const tokenCustomerCodes = row.customerCodes
  return {
    ok: true,
    tenantId: row.tenantId,
    erpCompanyId: row.erpCompanyId,
    tokenId: row.id,
    tokenCustomerCodes,
    resolveScopeCodes(requested?: string[]): string[] {
      if (tokenCustomerCodes.length === 0) return requested ?? []
      if (!requested) return tokenCustomerCodes
      return requested.filter((c) => tokenCustomerCodes.includes(c))
    },
  }
}
