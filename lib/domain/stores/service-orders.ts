// lib/domain/stores/service-orders.ts
//
// Store for service orders (docs/02-data-model.md, 11-service-items-and-parts.md).
// Tenant-scoped reads follow the customers/items/service-items idiom
// (lib/domain/stores/service-items.ts): every lookup filters on tenantId so
// a cross-tenant id never resolves, and on deletedAt IS NULL so a
// tombstoned row reads as absent. changeSeq is bumped exclusively by the
// bump_change_seq() trigger (0010_service_orders.sql) — the explicit
// `changeSeq: BigInt(0)` below is overwritten before the row is written,
// same as insertServiceItem.
//
// setOrderStatus is a THIN persistence setter: it writes the status column
// and nothing else. Transition rules (which statuses may follow which) live
// in lib/domain/order-status.ts (a later task) and call this setter — this
// store never validates a transition.
import { and, eq, gt, inArray, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { ServiceOrderRow, ServiceOrderLineRow } from '@/drizzle/schema'
import type { ChargeType, OrderStatus } from '@/lib/domain/types'

type Db = PostgresJsDatabase<typeof schema>

export interface InsertServiceOrderInput {
  tenantId: string
  customerId: string
  erpCompanyId?: string
  siteName?: string
  contactName?: string
  description?: string
  priority?: string
  requestedAt?: Date
  promisedDate?: Date
  defaultChargeType?: ChargeType
  orderNumber?: string
  crewGroupId?: string
}

export async function insertServiceOrder(db: Db, input: InsertServiceOrderInput): Promise<ServiceOrderRow> {
  const [row] = await db
    .insert(schema.serviceOrders)
    .values({
      tenantId: input.tenantId,
      erpCompanyId: input.erpCompanyId,
      customerId: input.customerId,
      siteName: input.siteName,
      contactName: input.contactName,
      description: input.description,
      priority: input.priority,
      requestedAt: input.requestedAt,
      promisedDate: input.promisedDate,
      defaultChargeType: input.defaultChargeType,
      orderNumber: input.orderNumber,
      crewGroupId: input.crewGroupId,
      changeSeq: BigInt(0), // overwritten by bump_change_seq() before the row is written
    })
    .returning()

  return row
}

export async function getServiceOrderById(db: Db, tenantId: string, id: string): Promise<ServiceOrderRow | null> {
  const [row] = await db
    .select()
    .from(schema.serviceOrders)
    .where(
      and(
        eq(schema.serviceOrders.id, id),
        eq(schema.serviceOrders.tenantId, tenantId),
        isNull(schema.serviceOrders.deletedAt),
      ),
    )

  return row ?? null
}

export async function scanServiceOrdersForTenant(db: Db, tenantId: string): Promise<ServiceOrderRow[]> {
  return db
    .select()
    .from(schema.serviceOrders)
    .where(and(eq(schema.serviceOrders.tenantId, tenantId), isNull(schema.serviceOrders.deletedAt)))
}

// Task 2 (docs/superpowers/sdd/task-2-brief.md): customer-scoped,
// changeSeq-paginated read for the /api/ext/v1 read API, mirroring
// scanServiceItemsForCustomer's shape. customerIds comes from
// resolveCustomerIdsByCodes (lib/domain/stores/customers.ts) — an empty
// list means the caller's token resolved to no known customer, so this
// returns [] rather than falling through to an unscoped scan. `status` is
// an optional exact-match filter on the internal OrderStatus column.
export interface ScanServiceOrdersForCustomerInput {
  tenantId: string
  customerIds: string[]
  after?: bigint
  limit: number
  status?: OrderStatus
}

export async function scanServiceOrdersForCustomer(
  db: Db,
  { tenantId, customerIds, after, limit, status }: ScanServiceOrdersForCustomerInput,
): Promise<ServiceOrderRow[]> {
  if (customerIds.length === 0) return []

  const conditions = [
    eq(schema.serviceOrders.tenantId, tenantId),
    inArray(schema.serviceOrders.customerId, customerIds),
    isNull(schema.serviceOrders.deletedAt),
  ]
  if (after !== undefined) {
    conditions.push(gt(schema.serviceOrders.changeSeq, after))
  }
  if (status !== undefined) {
    conditions.push(eq(schema.serviceOrders.status, status))
  }

  return db
    .select()
    .from(schema.serviceOrders)
    .where(and(...conditions))
    .orderBy(schema.serviceOrders.changeSeq)
    .limit(limit)
}

// Task 9 (docs/08-suite-integration.md §4): batch fetch of service_order_rows
// across one or more orders, for the /api/ext/v1/orders routes'
// serviceItems[] join (mapOrderSummary/mapOrderDetail). Batches across every
// order on a list page — or the single order on a detail page — in one
// query rather than round-tripping per order, same batch idiom as
// getItemModelsByIds (service-items.ts). No tenant filter here: orderId
// itself is already tenant-scoped by the caller (scanServiceOrdersForCustomer
// / getServiceOrderById), same as worksheet rows below.
export async function getServiceOrderRowsForOrders(db: Db, orderIds: string[]): Promise<ServiceOrderLineRow[]> {
  if (orderIds.length === 0) return []

  return db
    .select()
    .from(schema.serviceOrderRows)
    .where(inArray(schema.serviceOrderRows.orderId, orderIds))
}

export async function setOrderStatus(
  db: Db,
  tenantId: string,
  id: string,
  status: OrderStatus,
): Promise<void> {
  await db
    .update(schema.serviceOrders)
    .set({ status })
    .where(and(eq(schema.serviceOrders.id, id), eq(schema.serviceOrders.tenantId, tenantId)))
}

// SEED/TEST-ONLY. In production, 'Invoiced'/'Closed' are ERP-owned states
// (docs/02-data-model.md:64-72 — Closed via SVOVc.DoneMark, Invoiced via a
// linked IVVc) that only ever arrive through the real ERP sync pipeline,
// never through application code calling setOrderStatus directly. That sync
// path doesn't exist yet, so seed/test code has no legitimate way to put an
// order in one of these states — this helper is that bypass. It is
// deliberately not tenant-scoped (unlike setOrderStatus) since it is never
// meant to be called from request-handling code; do not call it outside
// seed scripts or tests.
export async function setErpOwnedState(
  db: Db,
  orderId: string,
  status: Extract<OrderStatus, 'Invoiced' | 'Closed'>,
): Promise<void> {
  await db.update(schema.serviceOrders).set({ status }).where(eq(schema.serviceOrders.id, orderId))
}
