// lib/sync/ingest/customers.ts
//
// Cache -> domain mapping for the CUVc register (docs/04-erp-sync.md §"Ingest
// (cache -> domain)"). Upserts are keyed by (erpCompanyId, erpRef), so ingest
// is idempotent. ERP-mastered fields (name) always overwrite. changeSeq is
// bumped exclusively by the bump_change_seq() plpgsql trigger (0002
// migration) — it fires on both the plain INSERT path and the implicit
// UPDATE Postgres performs for ON CONFLICT DO UPDATE, so this is the single
// source of monotonicity; no explicit nextval() here.
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ChangeSet } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'

interface CuvcRow {
  Code: string
  Name: string
}

export async function ingestCustomers(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  changeSet: ChangeSet<Record<string, unknown>>,
): Promise<void> {
  const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
  if (!company) {
    throw new Error(`ingestCustomers: unknown erpCompanyId ${erpCompanyId}`)
  }

  for (const raw of changeSet.upserts as unknown as CuvcRow[]) {
    await db
      .insert(schema.customers)
      .values({
        tenantId: company.tenantId,
        erpCompanyId,
        erpRef: raw.Code,
        name: raw.Name,
        changeSeq: BigInt(0), // overwritten by bump_change_seq() before the row is written
      })
      .onConflictDoUpdate({
        target: [schema.customers.erpCompanyId, schema.customers.erpRef],
        set: { name: raw.Name },
      })
  }
}
