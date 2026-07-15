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
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { ServiceItemRow, ItemModelRow } from '@/drizzle/schema'
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
  customerId?: string
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
      customerId: input.customerId,
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

// Task 2 (docs/superpowers/sdd/task-2-brief.md): customer-scoped,
// changeSeq-paginated read for the /api/ext/v1 read API. customerIds comes
// from resolveCustomerIdsByCodes (lib/domain/stores/customers.ts) — an
// empty list means the caller's token resolved to no known customer, so
// this returns [] rather than falling through to an unscoped scan.
export interface ScanServiceItemsForCustomerInput {
  tenantId: string
  customerIds: string[]
  after?: bigint
  limit: number
}

export async function scanServiceItemsForCustomer(
  db: Db,
  { tenantId, customerIds, after, limit }: ScanServiceItemsForCustomerInput,
): Promise<ServiceItemRow[]> {
  if (customerIds.length === 0) return []

  const conditions = [
    eq(schema.serviceItems.tenantId, tenantId),
    inArray(schema.serviceItems.customerId, customerIds),
    isNull(schema.serviceItems.deletedAt),
  ]
  if (after !== undefined) {
    conditions.push(gt(schema.serviceItems.changeSeq, after))
  }

  return db
    .select()
    .from(schema.serviceItems)
    .where(and(...conditions))
    .orderBy(schema.serviceItems.changeSeq)
    .limit(limit)
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

// Task 8 (docs/08-suite-integration.md §4a, "labelId= QR resolution"): the
// route.ts's labelId= lookup path is a QR-driven single-item resolve, so it
// looks up by the unique labelId (unique().on(t.labelId) above) rather than
// by primary key — same tenant/deletedAt scoping as getServiceItemById.
export async function getServiceItemByLabelId(db: Db, tenantId: string, labelId: string): Promise<ServiceItemRow | null> {
  const [row] = await db
    .select()
    .from(schema.serviceItems)
    .where(
      and(
        eq(schema.serviceItems.labelId, labelId),
        eq(schema.serviceItems.tenantId, tenantId),
        isNull(schema.serviceItems.deletedAt),
      ),
    )

  return row ?? null
}

// Task 8: batch model lookup for the /api/ext/v1/service-items routes'
// `itemModels` join (lib/api/ext/mappers.ts's `mapServiceItemSummary`/
// `mapServiceItemDetail` take an optional model row). Callers collect the
// distinct, non-null `modelId`s off however many ServiceItemRows they have
// (one for a detail route, many for a list) and pass them here in one call
// rather than round-tripping per row.
export async function getItemModelsByIds(db: Db, tenantId: string, ids: string[]): Promise<ItemModelRow[]> {
  if (ids.length === 0) return []

  return db
    .select()
    .from(schema.itemModels)
    .where(
      and(
        eq(schema.itemModels.tenantId, tenantId),
        inArray(schema.itemModels.id, ids),
        isNull(schema.itemModels.deletedAt),
      ),
    )
}

// Task 9: batch id lookup, same batch idiom as getItemModelsByIds above —
// the /api/ext/v1/orders routes collect the distinct serviceItemIds off a
// service_order_rows batch (getServiceOrderRowsForOrders,
// lib/domain/stores/service-orders.ts) and resolve their names/serials here
// in one query rather than per-row.
export async function getServiceItemsByIds(db: Db, tenantId: string, ids: string[]): Promise<ServiceItemRow[]> {
  if (ids.length === 0) return []

  return db
    .select()
    .from(schema.serviceItems)
    .where(
      and(
        eq(schema.serviceItems.tenantId, tenantId),
        inArray(schema.serviceItems.id, ids),
        isNull(schema.serviceItems.deletedAt),
      ),
    )
}
