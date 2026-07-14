// lib/domain/stores/worksheets.ts
//
// Store for worksheets (docs/02-data-model.md, 11-service-items-and-parts.md).
// Tenant-scoped reads follow the same idiom as
// lib/domain/stores/service-orders.ts. changeSeq is bumped exclusively by
// the bump_change_seq() trigger (0011_worksheets.sql).
//
// setWorksheetStatus is a THIN persistence setter, same contract as
// setOrderStatus — no transition rules here; those live in
// lib/domain/worksheet-status.ts (a later task).
//
// insertWorksheet relies on the DB-level partial unique index
// worksheets_order_tech_uniq (order_id, technician_user_id) WHERE
// deleted_at IS NULL AND technician_user_id IS NOT NULL
// (0011_worksheets.sql) to enforce one worksheet per (order x technician) —
// a second insert for the same pair raises a unique_violation (Postgres
// error 23505), which this store does not catch or translate; the caller
// decides how to surface it.
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { WorksheetRow } from '@/drizzle/schema'
import type { WorksheetStatus } from '@/lib/domain/types'

type Db = PostgresJsDatabase<typeof schema>

export interface InsertWorksheetInput {
  tenantId: string
  orderId: string
  erpCompanyId?: string
  technicianUserId?: string
  crewGroupId?: string
  workDescription?: string
  fault?: string
  cause?: string
  remedy?: string
}

export async function insertWorksheet(db: Db, input: InsertWorksheetInput): Promise<WorksheetRow> {
  const [row] = await db
    .insert(schema.worksheets)
    .values({
      tenantId: input.tenantId,
      erpCompanyId: input.erpCompanyId,
      orderId: input.orderId,
      technicianUserId: input.technicianUserId,
      crewGroupId: input.crewGroupId,
      workDescription: input.workDescription,
      fault: input.fault,
      cause: input.cause,
      remedy: input.remedy,
      changeSeq: BigInt(0), // overwritten by bump_change_seq() before the row is written
    })
    .returning()

  return row
}

export async function getWorksheetById(db: Db, tenantId: string, id: string): Promise<WorksheetRow | null> {
  const [row] = await db
    .select()
    .from(schema.worksheets)
    .where(
      and(
        eq(schema.worksheets.id, id),
        eq(schema.worksheets.tenantId, tenantId),
        isNull(schema.worksheets.deletedAt),
      ),
    )

  return row ?? null
}

export async function getWorksheetsForOrder(db: Db, tenantId: string, orderId: string): Promise<WorksheetRow[]> {
  return db
    .select()
    .from(schema.worksheets)
    .where(
      and(
        eq(schema.worksheets.tenantId, tenantId),
        eq(schema.worksheets.orderId, orderId),
        isNull(schema.worksheets.deletedAt),
      ),
    )
}

export async function setWorksheetStatus(
  db: Db,
  tenantId: string,
  id: string,
  status: WorksheetStatus,
): Promise<void> {
  await db
    .update(schema.worksheets)
    .set({ status })
    .where(and(eq(schema.worksheets.id, id), eq(schema.worksheets.tenantId, tenantId)))
}
