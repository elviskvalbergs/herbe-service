// lib/sync/ingest/key-sweep.ts
//
// Key-sweep reconciliation: the ONLY deletion path for domain tables
// (docs/04-erp-sync.md §"Deletion detection" — `deletes_after` is confirmed
// unreliable on the live ERP, do not build on it). Pages all live erpRefs
// from the adapter (paging, if any, is the adapter's concern — this function
// just consumes the full live set it returns), diffs against stored,
// non-deleted erpRefs for the company, and soft-deletes (sets deletedAt) the
// ones no longer present. Also doubles as sequence-reset recovery, since it's
// a full re-derivation rather than an incremental diff.
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

export interface RefListingAdapter {
  listLiveRefs(register: string): Promise<string[]>
}

type Register = 'CUVc' | 'INVc' | 'SVOSerVc'

// Exhaustive register -> domain-table map. The `satisfies` annotation makes a
// missing register a compile error, replacing the earlier two-way ternary the
// project CLAUDE.md flags as a footgun. SVOSerVc reconciles against
// service_items by stored erpRef (= SerialNr) vs the adapter's live serials.
const REGISTER_TABLE = {
  CUVc: schema.customers,
  INVc: schema.items,
  SVOSerVc: schema.serviceItems,
} satisfies Record<Register, PgTable & { erpRef: unknown; erpCompanyId: unknown; deletedAt: unknown }>

export async function keySweepReconcile(
  db: PostgresJsDatabase<typeof schema>,
  adapter: RefListingAdapter,
  erpCompanyId: string,
  register: Register,
): Promise<{ tombstoned: string[] }> {
  // All three mapped tables share erp_ref/erp_company_id/deleted_at columns, so
  // the column-level SQL is identical. Drizzle's operators can't unify a union
  // of table types (service_items.erpRef is nullable, the others notNull), so
  // pin the static type to one member — the generated SQL is column-name based
  // and correct for whichever table the map actually selected.
  const table = REGISTER_TABLE[register] as typeof schema.customers

  const storedRows = await db
    .select({ erpRef: table.erpRef })
    .from(table)
    // isNotNull guards service_items: app-created (non-ERP) rows have a null
    // erpRef and must never be swept. A no-op for customers/items (notNull).
    .where(and(eq(table.erpCompanyId, erpCompanyId), isNotNull(table.erpRef), isNull(table.deletedAt)))

  const liveRefs = new Set(await adapter.listLiveRefs(register))
  const tombstoned: string[] = []

  for (const row of storedRows) {
    if (!liveRefs.has(row.erpRef)) {
      // Scope by erpCompanyId too — erpRef is only unique per company, so two
      // companies can legitimately share the same code.
      await db
        .update(table)
        .set({ deletedAt: new Date() })
        .where(and(eq(table.erpCompanyId, erpCompanyId), eq(table.erpRef, row.erpRef)))
      tombstoned.push(row.erpRef)
    }
  }

  return { tombstoned }
}
