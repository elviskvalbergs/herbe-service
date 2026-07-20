// lib/documents/context.ts
//
// WS12 merge-context builder for docType 'order_report' (docs/superpowers/
// plans/2026-07-20-service-phase1-ws12-documents.md decision 5, doc 12
// §Merge context): a READ-ONLY, JSON-serializable projection rooted at a
// ServiceOrder. The exported types double as the template field catalog —
// property names are the dot-paths template authors write ({order.number},
// {customer.name}, {#worksheetSections}…{/worksheetSections}).
//
// Rules baked in here:
//   - Worksheets included: status 'Approved' OR 'Synced' (a pushed worksheet
//     is 'Synced' — approval-then-push must not drop it from the report),
//     deleted_at IS NULL.
//   - Crew merge: worksheets sharing a non-null crew_group_id render as ONE
//     section; each null-crew_group_id worksheet is its own section.
//   - Determinism: worksheets sort by id (the table has no created_at);
//     sections follow first-appearance order of that sort; text fields
//     concatenate distinct non-empty values with '\n\n' in the same order.
//     No generatedAt in meta — the renderer stamps it, keeping this builder
//     deterministic for golden tests.
//   - JSON-serializable: dates → ISO strings, numeric/decimal columns
//     (drizzle returns them as strings) → numbers, undefined-valued keys
//     omitted entirely so JSON.parse(JSON.stringify(ctx)) round-trips
//     losslessly (it is stored verbatim as documents.context_snapshot).
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

export class OrderNotFoundError extends Error {
  constructor(
    readonly tenantId: string,
    readonly orderId: string,
  ) {
    super(`service order ${orderId} not found in tenant ${tenantId}`)
    this.name = 'OrderNotFoundError'
  }
}

// ——— Field catalog (template dot-paths) ————————————————————————————————

/** {order.*} — the root service order. */
export interface OrderReportOrder {
  id: string
  /** App order number; '' when none was assigned yet. */
  number: string
  status: string
  description: string
  priority: string
  /** ISO timestamp; absent when the order has none. */
  requestedAt?: string
  /** ISO timestamp; absent when no promise was made. */
  promisedDate?: string
  siteName: string
  contactName: string
}

/** {customer.*} */
export interface OrderReportCustomer {
  id: string
  name: string
}

/** {#serviceItems}…{/serviceItems} — one entry per order row with an item. */
export interface OrderReportServiceItem {
  id: string
  name: string
  serial?: string
  /** Coverage payload of the order row, passed through as-is (jsonb). */
  coverage?: unknown
  symptom?: string
  workType?: string
  /** Row charge type; falls back to the order's defaultChargeType. */
  chargeType: string
}

/** {#worksheetSections}{#technicians}…{/technicians}{/worksheetSections} */
export interface OrderReportTechnician {
  id: string
  /** Display name — users have no name column yet, so this is the email. */
  name: string
}

/** {#rows}…{/rows} inside a section — merged worksheet rows. */
export interface OrderReportRow {
  description: string
  quantity?: number
  unit?: string
  serial?: string
  chargeType: string
  price?: number
  sum?: number
}

/** One report section: a solo worksheet or a merged crew group. */
export interface OrderReportSection {
  technicians: OrderReportTechnician[]
  /** True when the section is a crew group (non-null crew_group_id). */
  crew: boolean
  workDescription: string
  fault: string
  cause: string
  remedy: string
  /** True if ANY worksheet in the group was signed on site. */
  signedOnSite: boolean
  rows: OrderReportRow[]
  /** All time entries (work + travel + anything else) in minutes. */
  timeTotalMinutes: number
  workMinutes: number
  travelMinutes: number
  distanceKm: number
}

/** {totals.*} — across all sections. */
export interface OrderReportTotals {
  timeTotalMinutes: number
  distanceKm: number
  rowCount: number
}

/** {meta.*}. generatedAt is deliberately absent — the renderer stamps it. */
export interface OrderReportMeta {
  /** Included (Approved/Synced) worksheets — may exceed section count. */
  worksheetCount: number
  tenantId: string
  orderId: string
}

export interface OrderReportContext {
  order: OrderReportOrder
  customer: OrderReportCustomer
  serviceItems: OrderReportServiceItem[]
  worksheetSections: OrderReportSection[]
  totals: OrderReportTotals
  /** Reserved for WS6's computed-field sandbox output — always {} here. */
  computed: Record<string, unknown>
  meta: OrderReportMeta
}

// ——— Builder ————————————————————————————————————————————————————————————

const INCLUDED_WORKSHEET_STATUSES = ['Approved', 'Synced'] as const

/** Drizzle numeric/decimal columns arrive as strings; null → undefined. */
function num(value: string | null): number | undefined {
  return value == null ? undefined : Number(value)
}

/** Drop undefined-valued keys so the object JSON-round-trips losslessly. */
function compact<T extends object>(obj: T): T {
  const record = obj as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key]
  }
  return obj
}

/** Distinct non-empty values joined with '\n\n', input order preserved. */
function concatDistinct(values: (string | null)[]): string {
  return [...new Set(values.filter((v): v is string => v != null && v !== ''))].join('\n\n')
}

export interface BuildOrderReportContextInput {
  tenantId: string
  orderId: string
}

export async function buildOrderReportContext(
  db: Db,
  { tenantId, orderId }: BuildOrderReportContextInput,
): Promise<OrderReportContext> {
  const [order] = await db
    .select()
    .from(schema.serviceOrders)
    .where(
      and(
        eq(schema.serviceOrders.id, orderId),
        eq(schema.serviceOrders.tenantId, tenantId),
        isNull(schema.serviceOrders.deletedAt),
      ),
    )
  if (!order) throw new OrderNotFoundError(tenantId, orderId)

  const [customer] = await db
    .select({ id: schema.customers.id, name: schema.customers.name })
    .from(schema.customers)
    .where(eq(schema.customers.id, order.customerId))

  const orderRows = await db
    .select({ row: schema.serviceOrderRows, item: schema.serviceItems })
    .from(schema.serviceOrderRows)
    .innerJoin(schema.serviceItems, eq(schema.serviceOrderRows.serviceItemId, schema.serviceItems.id))
    .where(eq(schema.serviceOrderRows.orderId, orderId))
    .orderBy(asc(schema.serviceOrderRows.id))

  const serviceItems: OrderReportServiceItem[] = orderRows.map(({ row, item }) =>
    compact({
      id: item.id,
      name: item.name,
      serial: item.serialNr ?? undefined,
      coverage: row.coverage ?? undefined,
      symptom: row.symptom ?? undefined,
      workType: row.workType ?? undefined,
      chargeType: row.chargeType ?? order.defaultChargeType,
    }),
  )

  // Deterministic base order: by worksheet id (no created_at column exists).
  const worksheets = await db
    .select()
    .from(schema.worksheets)
    .where(
      and(
        eq(schema.worksheets.orderId, orderId),
        inArray(schema.worksheets.status, [...INCLUDED_WORKSHEET_STATUSES]),
        isNull(schema.worksheets.deletedAt),
      ),
    )
    .orderBy(asc(schema.worksheets.id))

  const worksheetIds = worksheets.map((w) => w.id)
  const technicianIds = [
    ...new Set(worksheets.map((w) => w.technicianUserId).filter((id): id is string => id != null)),
  ]

  const [technicianRows, rows, times, distances] = await Promise.all([
    technicianIds.length
      ? db
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(inArray(schema.users.id, technicianIds))
      : Promise.resolve([]),
    worksheetIds.length
      ? db
          .select()
          .from(schema.worksheetRows)
          .where(inArray(schema.worksheetRows.worksheetId, worksheetIds))
          .orderBy(asc(schema.worksheetRows.id))
      : Promise.resolve([]),
    worksheetIds.length
      ? db
          .select()
          .from(schema.timeEntries)
          .where(inArray(schema.timeEntries.worksheetId, worksheetIds))
      : Promise.resolve([]),
    worksheetIds.length
      ? db
          .select()
          .from(schema.distanceEntries)
          .where(inArray(schema.distanceEntries.worksheetId, worksheetIds))
      : Promise.resolve([]),
  ])

  const technicianNameById = new Map(technicianRows.map((u) => [u.id, u.email]))
  const rowsByWorksheet = groupBy(rows, (r) => r.worksheetId)
  const timesByWorksheet = groupBy(times, (t) => t.worksheetId)
  const distancesByWorksheet = groupBy(distances, (d) => d.worksheetId)

  // Group into sections: shared non-null crewGroupId merges into one crew
  // section; each null-crewGroupId worksheet stands alone. Section order =
  // first appearance in the by-id worksheet sort above.
  const groups: schema.WorksheetRow[][] = []
  const crewSectionByGroupId = new Map<string, schema.WorksheetRow[]>()
  for (const ws of worksheets) {
    if (ws.crewGroupId == null) {
      groups.push([ws])
      continue
    }
    const existing = crewSectionByGroupId.get(ws.crewGroupId)
    if (existing) {
      existing.push(ws)
    } else {
      const group = [ws]
      crewSectionByGroupId.set(ws.crewGroupId, group)
      groups.push(group)
    }
  }

  const worksheetSections: OrderReportSection[] = groups.map((group) => {
    const technicians: OrderReportTechnician[] = []
    for (const ws of group) {
      if (ws.technicianUserId == null) continue
      if (technicians.some((t) => t.id === ws.technicianUserId)) continue
      technicians.push({
        id: ws.technicianUserId,
        name: technicianNameById.get(ws.technicianUserId) ?? ws.technicianUserId,
      })
    }

    let timeTotalMinutes = 0
    let workMinutes = 0
    let travelMinutes = 0
    let distanceKm = 0
    const sectionRows: OrderReportRow[] = []
    for (const ws of group) {
      for (const entry of timesByWorksheet.get(ws.id) ?? []) {
        const minutes = entry.minutes ?? 0
        timeTotalMinutes += minutes
        if (entry.kind === 'work') workMinutes += minutes
        else if (entry.kind === 'travel') travelMinutes += minutes
      }
      for (const entry of distancesByWorksheet.get(ws.id) ?? []) {
        distanceKm += Number(entry.km ?? 0)
      }
      for (const row of rowsByWorksheet.get(ws.id) ?? []) {
        sectionRows.push(
          compact({
            description: row.description ?? '',
            quantity: num(row.quantity),
            unit: row.unit ?? undefined,
            serial: row.serial ?? undefined,
            chargeType: row.chargeType,
            price: num(row.price),
            sum: num(row.sum),
          }),
        )
      }
    }

    return {
      technicians,
      crew: group[0].crewGroupId != null,
      workDescription: concatDistinct(group.map((w) => w.workDescription)),
      fault: concatDistinct(group.map((w) => w.fault)),
      cause: concatDistinct(group.map((w) => w.cause)),
      remedy: concatDistinct(group.map((w) => w.remedy)),
      signedOnSite: group.some((w) => w.signedOnSite),
      rows: sectionRows,
      timeTotalMinutes,
      workMinutes,
      travelMinutes,
      distanceKm,
    }
  })

  const totals: OrderReportTotals = {
    timeTotalMinutes: worksheetSections.reduce((acc, s) => acc + s.timeTotalMinutes, 0),
    distanceKm: worksheetSections.reduce((acc, s) => acc + s.distanceKm, 0),
    rowCount: worksheetSections.reduce((acc, s) => acc + s.rows.length, 0),
  }

  return {
    order: compact({
      id: order.id,
      number: order.orderNumber ?? '',
      status: order.status,
      description: order.description ?? '',
      priority: order.priority ?? '',
      requestedAt: order.requestedAt?.toISOString(),
      promisedDate: order.promisedDate?.toISOString(),
      siteName: order.siteName ?? '',
      contactName: order.contactName ?? '',
    }),
    customer: { id: customer.id, name: customer.name },
    serviceItems,
    worksheetSections,
    totals,
    // Reserved for WS6's computed-field sandbox — merged in by the renderer
    // once that lands; always {} from this builder.
    computed: {},
    meta: { worksheetCount: worksheets.length, tenantId, orderId },
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const bucket = map.get(k)
    if (bucket) bucket.push(item)
    else map.set(k, [item])
  }
  return map
}
