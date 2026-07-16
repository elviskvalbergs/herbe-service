// lib/sync/push/builders.ts
//
// Pure payload builders for the ERP push queue (WS4 outbound slice, docs/
// superpowers/plans/2026-07-16-service-phase1-erp-outbound.md decisions 5-7;
// field-by-field authority docs/04-erp-sync.md "Service Order (SVOVc)
// creation" / "Work Sheet (WSVc) creation"). No DB, no HTTP: the saga engine
// (Task 5) gathers domain rows, the live SVOVc read, and the resolved
// EMCode/Location/adapterConfigJson.push settings, then calls these.
// Throwing ErpPermanentError with an actionable message is the contract for
// an unbuildable payload — never a silent drop of a row or a field.
import { ErpPermanentError } from '@herbe/erp-core'
import { chargeTypeToItemType } from '@/lib/domain/charge-type'
import type { ChargeType } from '@/lib/domain/types'

// Formats the calendar date of `d` as observed in `timeZone`, e.g. 22:30 UTC
// on 2026-07-15 is already 2026-07-16 in Europe/Riga (UTC+3 in July). en-CA
// is just a locale whose default numeric-date order happens to be YYYY-MM-DD.
function formatDateInTimezone(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ---- SVOVc create (decision 5) ----

export interface SvoCreateRowInput {
  serialNr: string | null
  itemCode: string | null
  chargeType: ChargeType | null
}

export interface BuildSvoCreatePayloadInput {
  customerErpRef: string | null
  requestedAt: Date | null
  description: string | null
  defaultChargeType: ChargeType
  rows: SvoCreateRowInput[]
  /**
   * Must be a stable instant — the push group's `created_at`, not
   * `new Date()` at call time — so a retry rebuilds the exact same
   * TransDate and the natural-key idempotency match on the ERP side holds.
   */
  now: Date
  /**
   * IANA timezone TransDate is computed in (docs/02-data-model.md:118 — the
   * adapter converts to ERP-local date at the connection's timezone
   * boundary). Defaults to Europe/Riga, the project's established ERP
   * timezone. The engine (Task 5) should pass the connection's own
   * timezone here once per-connection tz config exists.
   */
  timezone?: string
}

export function buildSvoCreatePayload(input: BuildSvoCreatePayloadInput): Record<string, unknown> {
  if (!input.customerErpRef) {
    throw new ErpPermanentError(
      'customer has no ERP reference (CustCode) — cannot create a Service Order (SVOVc) until the customer is linked to the ERP',
    )
  }

  const rows = input.rows.map((row, index) => {
    if (row.itemCode == null && row.serialNr == null) {
      throw new ErpPermanentError(
        `service order row ${index + 1} has neither a service item code nor a serial number — cannot build its SVOVc row`,
      )
    }

    const out: Record<string, unknown> = { Quant: 1 }
    if (row.itemCode != null) out.ArtCode = row.itemCode
    if (row.serialNr != null) out.SerialNr = row.serialNr
    out.ItemType = chargeTypeToItemType(row.chargeType ?? input.defaultChargeType)
    return out
  })

  const payload: Record<string, unknown> = {
    CustCode: input.customerErpRef,
    TransDate: formatDateInTimezone(input.requestedAt ?? input.now, input.timezone ?? 'Europe/Riga'),
    rows,
  }

  // CustComplaint1 doubles as the live-test marker field (decision 5) — never
  // sent blank; a missing description simply omits the field.
  if (input.description) {
    payload.CustComplaint1 = input.description.slice(0, 60)
  }

  return payload
}

// ---- WSVc create (decision 7) ----

export interface WsCreateRowInput {
  itemCode: string | null
  description: string | null
  quantity: number | null
  price: number | null
  sum: number | null
  serial: string | null
  chargeType: ChargeType
}

export interface WsTimeEntryInput {
  minutes: number | null
}

export interface WsDistanceEntryInput {
  km: number | null
  billable: boolean | null
}

export interface WsPushConfig {
  laborItemCode?: string
  distanceItemCode?: string
  fallbackItemCode?: string
}

export interface BuildWsCreatePayloadInput {
  orderErpRef: string
  liveSvo: Record<string, unknown>
  emCode: string
  location: string
  rows: WsCreateRowInput[]
  timeEntries: WsTimeEntryInput[]
  distanceEntries: WsDistanceEntryInput[]
  config: WsPushConfig
}

// Standard Books returns boolean-ish flags as the string OR number "1"
// (mirrors the isBooksTrue helper duplicated across lib/sync/ingest/*.ts —
// none of those are exported, so this is a local copy of the same rule for
// the one flag this module reads).
function isDoneMarkSet(value: unknown): boolean {
  return value === 1 || value === '1'
}

// Header fields copied byte-for-byte from the live SVOVc read (decision 7) —
// never derived or defaulted by the adapter.
const VERBATIM_HEADER_FIELDS = [
  'CustCode',
  'Addr0',
  'CustContact',
  'Objects',
  'Phone',
  'LangCode',
  'CurncyCode',
  'FrRate',
  'ToRateB1',
  'ToRateB2',
  'BaseRate1',
  'BaseRate2',
  'InvoiceToCode',
  'CustVATCode',
  'PriceList',
  'InclVAT',
  'ExportFlag',
] as const

interface WsPayloadRow {
  ArtCode: string
  Quant: number
  ItemType: 1 | 2 | 3 | 4
  Price?: number
  Sum?: number
  SerialNr?: string
}

export function buildWsCreatePayload(input: BuildWsCreatePayloadInput): Record<string, unknown> {
  if (isDoneMarkSet(input.liveSvo.DoneMark)) {
    throw new ErpPermanentError(
      `service order ${input.orderErpRef} is already done in ERP (SVOVc.DoneMark=1) — cannot create a Work Sheet for it`,
    )
  }

  if (!input.emCode || !input.emCode.trim()) {
    throw new ErpPermanentError(
      'worksheet technician has no ERP person code (UserVc link missing) — cannot build WSVc payload',
    )
  }

  if (!input.location || !input.location.trim()) {
    throw new ErpPermanentError(
      'worksheet has no service location — configure the push.mainServiceLocation setting to build WSVc payload',
    )
  }

  const payload: Record<string, unknown> = {
    SVONr: input.orderErpRef,
    WONr: -1,
    EMCode: input.emCode,
    Location: input.location,
    UpdStockFlag: 1,
  }

  for (const field of VERBATIM_HEADER_FIELDS) {
    const value = input.liveSvo[field]
    if (value === undefined || value === null || value === '') continue
    payload[field] = value
  }

  const partRows: WsPayloadRow[] = input.rows.map((row, index) => {
    const artCode = row.itemCode ?? input.config.fallbackItemCode
    if (!artCode) {
      const label = row.description ? `"${row.description}"` : `#${index + 1}`
      throw new ErpPermanentError(
        `worksheet row ${label} has no service item code and no push.fallbackItemCode configured — cannot build its WSVc row`,
      )
    }

    const out: WsPayloadRow = {
      ArtCode: artCode,
      Quant: row.quantity ?? 1,
      ItemType: chargeTypeToItemType(row.chargeType),
    }
    if (row.price != null) out.Price = row.price
    if (row.sum != null) out.Sum = row.sum
    if (row.serial != null) out.SerialNr = row.serial
    return out
  })

  const rows: WsPayloadRow[] = [...partRows]

  // Labor: pushed only when push.laborItemCode is configured (decision 7).
  // ItemType is fixed at 1 (invoiceable) here — charging labor by the
  // worksheet's actual charge-type mix is future work, not v1.
  const laborMinutes = input.timeEntries.map((e) => e.minutes).filter((m): m is number => m != null)
  if (laborMinutes.length > 0) {
    if (!input.config.laborItemCode) {
      const noun = laborMinutes.length === 1 ? 'entry' : 'entries'
      throw new ErpPermanentError(
        `worksheet has ${laborMinutes.length} time ${noun} with recorded minutes but no push.laborItemCode configured — cannot push labor time`,
      )
    }
    const totalMinutes = laborMinutes.reduce((sum, m) => sum + m, 0)
    const hours = totalMinutes / 60
    const quarterHours = Math.ceil(hours / 0.25) * 0.25
    rows.push({ ArtCode: input.config.laborItemCode, Quant: quarterHours, ItemType: 1 })
  }

  // Distance: pushed only when push.distanceItemCode is configured (decision
  // 7). billable:false rows never count; billable:true or unset (null) does.
  const billableKm = input.distanceEntries
    .filter((e) => e.billable !== false && e.km != null)
    .map((e) => e.km as number)
  if (billableKm.length > 0) {
    if (!input.config.distanceItemCode) {
      const noun = billableKm.length === 1 ? 'entry' : 'entries'
      throw new ErpPermanentError(
        `worksheet has ${billableKm.length} billable distance ${noun} but no push.distanceItemCode configured — cannot push distance`,
      )
    }
    const totalKm = round2(billableKm.reduce((sum, km) => sum + km, 0))
    rows.push({ ArtCode: input.config.distanceItemCode, Quant: totalKm, ItemType: 1 })
  }

  payload.rows = rows

  const totals = wsSumup(rows)
  payload.Sum1 = totals.Sum1
  payload.Sum3 = totals.Sum3
  payload.Sum4 = totals.Sum4

  return payload
}

// ---- WSSumup port (decision 7) ----
//
// v1 has no VAT-code data model: Sum3 (VAT total) is always 0 and Sum4
// (gross) always equals Sum1 (net). The ERP recalculates both on the
// manager's OK — this is just enough for the un-OK'd record to be valid.
export interface WsSumRow {
  Quant?: number
  Price?: number
  Sum?: number
}

export function wsSumup(rows: WsSumRow[]): { Sum1: number; Sum3: number; Sum4: number } {
  const sum1 = rows.reduce((total, row) => {
    if (row.Sum != null) return total + row.Sum
    if (row.Price != null && row.Quant != null) return total + row.Price * row.Quant
    return total
  }, 0)

  const rounded = round2(sum1)
  return { Sum1: rounded, Sum3: 0, Sum4: rounded }
}
