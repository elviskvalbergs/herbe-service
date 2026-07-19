// lib/sync/push/gather.ts
//
// Domain-state assembly for the push saga engine (WS4 outbound slice, docs/
// superpowers/plans/2026-07-16-service-phase1-erp-outbound.md decisions 3/5/7):
// collects the current DB rows (+ the two ERP reads the WSVc builder needs —
// the live SVOVc header and, best-effort, MainStockBlock) into the exact
// input shape buildSvoCreatePayload/buildWsCreatePayload expect. No queue
// state, no retries, no putErpRef/markStep here — that orchestration lives
// in engine.ts, which is this module's only caller. Split out purely because
// engine.ts was getting large (Task 5 self-review), not because this is
// independently reusable.
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ErpPermanentError, ErpTransientError, type ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import type { ServiceItemRow } from '@/drizzle/schema'
import { getServiceOrderById, getServiceOrderRowsForOrders } from '@/lib/domain/stores/service-orders'
import { getServiceItemsByIds } from '@/lib/domain/stores/service-items'
import { getCustomerById } from '@/lib/domain/stores/customers'
import { getErpRefs } from '@/lib/domain/stores/erp-refs'
import { getErpIdentityLink } from '@/lib/domain/stores/identity-links'
import {
  getWorksheetById,
  getWorksheetRowsForWorksheets,
  getTimeEntriesForWorksheet,
  getDistanceEntriesForWorksheet,
} from '@/lib/domain/stores/worksheets'
import type { ChargeType } from '@/lib/domain/types'
import type {
  BuildSvoCreatePayloadInput,
  BuildWsCreatePayloadInput,
  SvoCreateRowInput,
  WsCreateRowInput,
  WsTimeEntryInput,
  WsDistanceEntryInput,
} from './builders'

type Db = PostgresJsDatabase<typeof schema>

export interface PushConfig {
  mainServiceLocation?: string
  laborItemCode?: string
  distanceItemCode?: string
  fallbackItemCode?: string
  timezone?: string
}

// erp_companies.adapterConfigJson.push (this slice DEFINES the convention —
// docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md task
// brief). Read defensively: an untouched connection has no `push` key at all.
export async function getPushConfig(db: Db, erpCompanyId: string): Promise<PushConfig> {
  const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
  if (!company) {
    throw new Error(`gather: unknown erpCompanyId ${erpCompanyId}`)
  }
  const config = (company.adapterConfigJson ?? {}) as Record<string, unknown>
  return (config.push as PushConfig | undefined) ?? {}
}

function readItemCode(item: ServiceItemRow | undefined): string | null {
  if (!item) return null
  const attrs = (item.attributes ?? {}) as Record<string, unknown>
  // ingestServiceItems (lib/sync/ingest/service-items.ts) stores the ERP's
  // ItemCode field as attributes.itemCode (lowercase camelCase, verified by
  // its own DB-backed test) — NOT the PascalCase `ItemCode` the raw ERP row
  // uses. Found live in Task 7: reading the wrong casing here silently
  // nulled ArtCode for every real ERP-ingested service item.
  const code = attrs.itemCode
  return typeof code === 'string' && code ? code : null
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// ---- SVOVc create gather (decision 5) ----

export async function gatherSvoCreateInput(
  db: Db,
  tenantId: string,
  erpCompanyId: string,
  orderId: string,
  now: Date,
): Promise<BuildSvoCreatePayloadInput> {
  const order = await getServiceOrderById(db, tenantId, orderId)
  if (!order) {
    throw new ErpPermanentError(`service order ${orderId} not found — cannot build its SVOVc create payload`)
  }

  const customer = await getCustomerById(db, tenantId, order.customerId)

  const orderRows = await getServiceOrderRowsForOrders(db, [orderId])
  const serviceItemIds = orderRows.map((r) => r.serviceItemId).filter((id): id is string => id != null)
  const serviceItems = await getServiceItemsByIds(db, tenantId, serviceItemIds)
  const itemById = new Map(serviceItems.map((si) => [si.id, si]))

  const rows: SvoCreateRowInput[] = orderRows.map((r) => {
    const item = r.serviceItemId ? itemById.get(r.serviceItemId) : undefined
    return {
      serialNr: item?.serialNr ?? null,
      itemCode: readItemCode(item),
      chargeType: (r.chargeType as ChargeType | null) ?? null,
    }
  })

  const pushConfig = await getPushConfig(db, erpCompanyId)

  return {
    customerErpRef: customer?.erpRef ?? null,
    requestedAt: order.requestedAt,
    description: order.description,
    defaultChargeType: order.defaultChargeType as ChargeType,
    rows,
    now,
    timezone: pushConfig.timezone,
  }
}

// ---- WSVc create gather (decision 7) ----

export async function gatherWsCreateInput(
  db: Db,
  adapter: ErpAdapter,
  tenantId: string,
  erpCompanyId: string,
  worksheetId: string,
): Promise<BuildWsCreatePayloadInput> {
  const worksheet = await getWorksheetById(db, tenantId, worksheetId)
  if (!worksheet) {
    throw new ErpPermanentError(`worksheet ${worksheetId} not found — cannot build its WSVc create payload`)
  }

  const orderRefs = await getErpRefs(db, tenantId, 'service_order', worksheet.orderId)
  const orderPrimary = orderRefs.find((r) => r.purpose === 'primary')
  if (!orderPrimary) {
    throw new ErpPermanentError(
      `worksheet ${worksheetId}'s service order has no primary SVOVc erp_ref yet — the order-create step must run before the worksheet step`,
    )
  }
  const orderErpRef = orderPrimary.recordRef

  const liveSvoRecords = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderErpRef })
  const liveSvo = liveSvoRecords[0]
  if (!liveSvo) {
    throw new ErpTransientError(`service order ${orderErpRef} not yet visible in ERP — retrying`)
  }

  let emCode = ''
  if (worksheet.technicianUserId) {
    const identityLink = await getErpIdentityLink(db, tenantId, worksheet.technicianUserId, erpCompanyId)
    emCode = identityLink?.externalId ?? ''
  }

  const pushConfig = await getPushConfig(db, erpCompanyId)
  let location = pushConfig.mainServiceLocation ?? ''
  if (!location) {
    const mainStockRows = await adapter.fetchRecords('MainStockBlock', {})
    const first = mainStockRows[0] as Record<string, unknown> | undefined
    location = first?.MainStock != null ? String(first.MainStock) : ''
  }

  const lineRows = await getWorksheetRowsForWorksheets(db, [worksheetId])
  const serviceItemIds = lineRows.map((l) => l.serviceItemId).filter((id): id is string => id != null)
  const serviceItems = await getServiceItemsByIds(db, tenantId, serviceItemIds)
  const itemById = new Map(serviceItems.map((si) => [si.id, si]))

  const rows: WsCreateRowInput[] = lineRows.map((line) => ({
    itemCode: line.serviceItemId ? readItemCode(itemById.get(line.serviceItemId)) : null,
    description: line.description,
    quantity: toNumber(line.quantity),
    price: toNumber(line.price),
    sum: toNumber(line.sum),
    serial: line.serial,
    chargeType: line.chargeType as ChargeType,
  }))

  const timeEntryRows = await getTimeEntriesForWorksheet(db, worksheetId)
  const timeEntries: WsTimeEntryInput[] = timeEntryRows.map((t) => ({ minutes: t.minutes }))

  const distanceEntryRows = await getDistanceEntriesForWorksheet(db, worksheetId)
  const distanceEntries: WsDistanceEntryInput[] = distanceEntryRows.map((d) => ({
    km: toNumber(d.km),
    billable: d.billable,
  }))

  return {
    orderErpRef,
    liveSvo,
    emCode,
    location,
    rows,
    timeEntries,
    distanceEntries,
    config: {
      laborItemCode: pushConfig.laborItemCode,
      distanceItemCode: pushConfig.distanceItemCode,
      fallbackItemCode: pushConfig.fallbackItemCode,
    },
  }
}
