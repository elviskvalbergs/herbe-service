/**
 * Turns a stored `erp_companies` row into a live ErpAdapter: decrypts the
 * creds column, merges it with adapterConfigJson into the standard_books
 * config shape, and hands it to the erp-core adapter registry. This is the
 * missing credentials -> adapter plumbing (Phase 1 ERP connection
 * foundation) — until now every test/caller instantiated an adapter from a
 * literal config, never from a stored connection.
 */

import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { getAdapter, type ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { decryptErpCredentials } from './credentials'
import type { StandardBooksConfig } from './standard-books/config-schema'
// Imported for its registerAdapter('standard_books', ...) side effect —
// without this, getAdapter() below has nothing registered for
// 'standard_books' and throws.
import './standard-books/adapter'

export async function buildAdapterForConnection(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
): Promise<ErpAdapter> {
  const [row] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
  if (!row) {
    throw new Error(`unknown erp company: ${erpCompanyId}`)
  }

  // apiCredsEncrypted is a `text` column here (the portal's equivalent is
  // `bytea`), so the keyId||nonce||ciphertext blob is base64-encoded at this
  // boundary only — encryptErpCredentials/decryptErpCredentials themselves
  // stay Buffer-in/Buffer-out, unchanged from the portal.
  const blob = row.apiCredsEncrypted ? Buffer.from(row.apiCredsEncrypted, 'base64') : null
  const creds = decryptErpCredentials(blob) as { username: string; password: string }

  const adapterConfig = row.adapterConfigJson as { baseUrl: string; companyNumber: string }
  const config: StandardBooksConfig = {
    baseUrl: adapterConfig.baseUrl,
    companyNumber: adapterConfig.companyNumber,
    auth: { kind: 'basic', username: creds.username, password: creds.password },
  }

  return getAdapter(row.adapterType, config)
}
