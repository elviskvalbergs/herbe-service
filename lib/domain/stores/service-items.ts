// lib/domain/stores/service-items.ts
//
// Store for the service-item location tree (docs/11-service-items-and-parts.md
// "Part 1 — The service item hierarchy"). Tenant-scoped reads follow the
// customers/items idiom (lib/sync/ingest/customers.ts): every lookup filters
// on tenantId so a cross-tenant id never resolves, and on deletedAt IS NULL
// so a tombstoned row reads as absent. changeSeq is bumped exclusively by the
// bump_change_seq() trigger (0009_service_items.sql) — the explicit
// `changeSeq: BigInt(0)` below is overwritten before the row is written, same
// as ingestCustomers.
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { ServiceItemRow } from '@/drizzle/schema'
import type { NodeKind } from '@/lib/domain/types'

type Db = PostgresJsDatabase<typeof schema>

export interface InsertServiceItemInput {
  tenantId: string
  kind: NodeKind
  name: string
  labelId: string
  erpCompanyId?: string
  erpRef?: string
  parentId?: string
  serialNr?: string
  secondarySerial?: string
  quantity?: number
  modelId?: string
  path?: string
  positionCode?: string
  attributes?: Record<string, unknown>
  siteName?: string
  warrantyUntil?: Date
  warrantyLaborCovered?: boolean
  warrantyPartsCovered?: boolean
}

export async function insertServiceItem(db: Db, input: InsertServiceItemInput): Promise<ServiceItemRow> {
  const [row] = await db
    .insert(schema.serviceItems)
    .values({
      tenantId: input.tenantId,
      erpCompanyId: input.erpCompanyId,
      erpRef: input.erpRef,
      parentId: input.parentId,
      kind: input.kind,
      name: input.name,
      serialNr: input.serialNr,
      secondarySerial: input.secondarySerial,
      quantity: input.quantity,
      modelId: input.modelId,
      path: input.path,
      positionCode: input.positionCode,
      labelId: input.labelId,
      attributes: input.attributes,
      siteName: input.siteName,
      warrantyUntil: input.warrantyUntil,
      warrantyLaborCovered: input.warrantyLaborCovered,
      warrantyPartsCovered: input.warrantyPartsCovered,
      changeSeq: BigInt(0), // overwritten by bump_change_seq() before the row is written
    })
    .returning()

  return row
}

export async function getServiceItemById(db: Db, tenantId: string, id: string): Promise<ServiceItemRow | null> {
  const [row] = await db
    .select()
    .from(schema.serviceItems)
    .where(
      and(
        eq(schema.serviceItems.id, id),
        eq(schema.serviceItems.tenantId, tenantId),
        isNull(schema.serviceItems.deletedAt),
      ),
    )

  return row ?? null
}

export async function scanServiceItemsForTenant(db: Db, tenantId: string): Promise<ServiceItemRow[]> {
  return db
    .select()
    .from(schema.serviceItems)
    .where(and(eq(schema.serviceItems.tenantId, tenantId), isNull(schema.serviceItems.deletedAt)))
}

export async function getChildren(db: Db, tenantId: string, parentId: string): Promise<ServiceItemRow[]> {
  return db
    .select()
    .from(schema.serviceItems)
    .where(
      and(
        eq(schema.serviceItems.tenantId, tenantId),
        eq(schema.serviceItems.parentId, parentId),
        isNull(schema.serviceItems.deletedAt),
      ),
    )
}
