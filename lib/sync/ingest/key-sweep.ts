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
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

export interface RefListingAdapter {
  listLiveRefs(register: string): Promise<string[]>
}

type Register = 'CUVc' | 'INVc'

export async function keySweepReconcile(
  db: PostgresJsDatabase<typeof schema>,
  adapter: RefListingAdapter,
  erpCompanyId: string,
  register: Register,
): Promise<{ tombstoned: string[] }> {
  const table = register === 'CUVc' ? schema.customers : schema.items

  const storedRows = await db
    .select({ erpRef: table.erpRef })
    .from(table)
    .where(and(eq(table.erpCompanyId, erpCompanyId), isNull(table.deletedAt)))

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
