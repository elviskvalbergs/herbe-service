// tests/unit/api/ext/mappers.test.ts
//
// Task 7 (docs/superpowers/plans/2026-07-14-service-phase1-ext-read-api.md):
// pure domain→portal mapper tests. No DB — representative Drizzle row shapes
// are built by hand and fed straight into the mappers; every mapper output
// is asserted to `.parse()` cleanly under its `lib/api/ext/dto.ts` schema
// (herbe.service's mirror of the portal's frozen `lib/service/dto.ts`).
import { describe, expect, it } from 'vitest'
import type {
  ServiceItemRow,
  ItemModelRow,
  ServiceOrderRow,
  WorksheetRow,
  WorksheetLineRow,
  HistoryEventRow,
} from '@/drizzle/schema'
import {
  serviceItemSummarySchema,
  serviceItemDetailSchema,
  historyEventSchema,
  orderSummarySchema,
  orderDetailSchema,
  worksheetSummarySchema,
} from '@/lib/api/ext/dto'
import {
  mapServiceItemSummary,
  mapServiceItemDetail,
  mapHistoryEvent,
  mapOrderSummary,
  mapOrderDetail,
  mapWorksheetSummary,
} from '@/lib/api/ext/mappers'

function serviceItem(overrides: Partial<ServiceItemRow> = {}): ServiceItemRow {
  return {
    id: 'si-1',
    tenantId: 't-1',
    erpCompanyId: 'erp-1',
    erpRef: 'REF-1',
    parentId: null,
    customerId: 'cust-1',
    kind: 'unit',
    name: 'Compressor A',
    serialNr: 'SN-123',
    secondarySerial: null,
    quantity: null,
    modelId: null,
    path: '/root/compressor-a',
    positionCode: null,
    labelId: 'LBL-001',
    attributes: {},
    siteName: 'Warehouse 1',
    warrantyUntil: null,
    warrantyLaborCovered: false,
    warrantyPartsCovered: false,
    changeSeq: BigInt(1),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

function itemModel(overrides: Partial<ItemModelRow> = {}): ItemModelRow {
  return {
    id: 'model-1',
    tenantId: 't-1',
    make: 'Acme',
    model: 'X100',
    category: 'Compressor',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    changeSeq: BigInt(1),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

function serviceOrder(overrides: Partial<ServiceOrderRow> = {}): ServiceOrderRow {
  return {
    id: 'order-1',
    tenantId: 't-1',
    erpCompanyId: 'erp-1',
    customerId: 'cust-1',
    siteName: 'Site A',
    contactName: 'John Doe',
    description: 'Fix the thing',
    priority: 'normal',
    requestedAt: new Date('2026-02-01T00:00:00Z'),
    promisedDate: new Date('2026-02-05T00:00:00Z'),
    status: 'New',
    defaultChargeType: 'invoiceable',
    orderNumber: 'SO-1001',
    crewGroupId: null,
    changeSeq: BigInt(1),
    updatedAt: new Date('2026-02-02T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

function worksheet(overrides: Partial<WorksheetRow> = {}): WorksheetRow {
  return {
    id: 'ws-1',
    tenantId: 't-1',
    erpCompanyId: 'erp-1',
    orderId: 'order-1',
    technicianUserId: 'user-1',
    crewGroupId: null,
    status: 'Approved',
    workDescription: 'Replaced filter',
    fault: null,
    cause: null,
    remedy: null,
    signedOnSite: true,
    signatureLockedAt: null,
    revision: 1,
    rejectedReason: null,
    changeSeq: BigInt(1),
    updatedAt: new Date('2026-02-03T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  }
}

function worksheetLine(overrides: Partial<WorksheetLineRow> = {}): WorksheetLineRow {
  return {
    id: 'row-1',
    worksheetId: 'ws-1',
    serviceItemId: 'si-1',
    description: 'Air filter',
    quantity: '2',
    unit: 'pcs',
    serial: null,
    chargeType: 'invoiceable',
    stockLocation: 'VAN-1',
    price: '15.5',
    sum: '31',
    ...overrides,
  }
}

function historyEvent(overrides: Partial<HistoryEventRow> = {}): HistoryEventRow {
  return {
    id: 'hist-1',
    tenantId: 't-1',
    serviceItemId: 'si-1',
    key: 'ws-1:work_done:1',
    at: new Date('2026-02-03T12:00:00Z'),
    kind: 'work_done',
    summary: 'Filter replaced',
    orderId: 'order-1',
    worksheetId: 'ws-1',
    coverageCovered: null,
    coverageOf: null,
    createdAt: new Date('2026-02-03T12:05:00Z'),
    ...overrides,
  }
}

describe('mapServiceItemSummary', () => {
  it('parses cleanly and derives status "active" from a live row', () => {
    const mapped = mapServiceItemSummary(serviceItem())
    expect(() => serviceItemSummarySchema.parse(mapped)).not.toThrow()
    expect(mapped.status).toBe('active')
  })

  it('derives status "inactive" from a soft-deleted row', () => {
    const mapped = mapServiceItemSummary(serviceItem({ deletedAt: new Date('2026-03-01T00:00:00Z') }))
    expect(mapped.status).toBe('inactive')
  })

  it('maps model when the ItemModel row is present', () => {
    const mapped = mapServiceItemSummary(serviceItem(), itemModel())
    expect(mapped.model).toEqual({ make: 'Acme', model: 'X100', category: 'Compressor' })
  })

  it('omits model when no ItemModel row is joined', () => {
    const mappedUndefined = mapServiceItemSummary(serviceItem())
    const mappedNull = mapServiceItemSummary(serviceItem(), null)
    expect(mappedUndefined).not.toHaveProperty('model')
    expect(mappedNull).not.toHaveProperty('model')
  })

  it('derives warranty.status "in_warranty" when warrantyUntil is in the future', () => {
    const mapped = mapServiceItemSummary(serviceItem({ warrantyUntil: new Date(Date.now() + 86_400_000) }))
    expect(mapped.warranty?.status).toBe('in_warranty')
  })

  it('derives warranty.status "expired" when warrantyUntil is in the past', () => {
    const mapped = mapServiceItemSummary(serviceItem({ warrantyUntil: new Date(Date.now() - 86_400_000) }))
    expect(mapped.warranty?.status).toBe('expired')
  })

  it('omits warranty.status (and .until) when there is no warrantyUntil, but keeps coverage flags', () => {
    const mapped = mapServiceItemSummary(serviceItem({ warrantyUntil: null, warrantyLaborCovered: true }))
    expect(mapped.warranty).toEqual({ laborCovered: true, partsCovered: false })
    expect(mapped.warranty).not.toHaveProperty('status')
    expect(mapped.warranty).not.toHaveProperty('until')
  })

  it('omits serial/secondarySerial/siteName/quantity when null', () => {
    const mapped = mapServiceItemSummary(
      serviceItem({ serialNr: null, secondarySerial: null, siteName: null, quantity: null }),
    )
    expect(mapped).not.toHaveProperty('serial')
    expect(mapped).not.toHaveProperty('secondarySerial')
    expect(mapped).not.toHaveProperty('siteName')
    expect(mapped).not.toHaveProperty('quantity')
  })
})

describe('mapServiceItemDetail', () => {
  it('parses cleanly, sets documents to [], and includes everything from the summary mapper', () => {
    const mapped = mapServiceItemDetail(serviceItem(), itemModel())
    expect(() => serviceItemDetailSchema.parse(mapped)).not.toThrow()
    expect(mapped.documents).toEqual([])
    expect(mapped.model).toEqual({ make: 'Acme', model: 'X100', category: 'Compressor' })
  })

  it('maps parentId when present, omits when null', () => {
    const withParent = mapServiceItemDetail(serviceItem({ parentId: 'parent-1' }))
    const withoutParent = mapServiceItemDetail(serviceItem({ parentId: null }))
    expect(withParent.parentId).toBe('parent-1')
    expect(withoutParent).not.toHaveProperty('parentId')
  })
})

describe('mapHistoryEvent', () => {
  it('parses cleanly', () => {
    const mapped = mapHistoryEvent(historyEvent())
    expect(() => historyEventSchema.parse(mapped)).not.toThrow()
  })

  it('falls back to createdAt when at is null', () => {
    const row = historyEvent({ at: null, createdAt: new Date('2026-04-01T09:00:00Z') })
    const mapped = mapHistoryEvent(row)
    expect(mapped.at).toBe('2026-04-01T09:00:00.000Z')
  })

  it('uses at over createdAt when at is present', () => {
    const mapped = mapHistoryEvent(historyEvent())
    expect(mapped.at).toBe('2026-02-03T12:00:00.000Z')
  })

  it('includes coverage when both coverageCovered and coverageOf are present', () => {
    const mapped = mapHistoryEvent(historyEvent({ coverageCovered: 5, coverageOf: 8 }))
    expect(mapped.coverage).toEqual({ covered: 5, of: 8 })
  })

  it('omits coverage when either half is missing', () => {
    const mapped = mapHistoryEvent(historyEvent({ coverageCovered: 5, coverageOf: null }))
    expect(mapped).not.toHaveProperty('coverage')
  })

  it('passes orderNumber through when provided by the caller', () => {
    const mapped = mapHistoryEvent(historyEvent(), 'SO-1001')
    expect(mapped.orderNumber).toBe('SO-1001')
  })
})

describe('mapOrderSummary', () => {
  const opts = { customerStatus: 'work_done' as const, serviceItems: [{ id: 'si-1', name: 'Compressor A', serial: 'SN-123' }] }

  it('parses cleanly and projects status to exactly the caller-supplied 6-value status', () => {
    const mapped = mapOrderSummary(serviceOrder(), opts)
    expect(() => orderSummarySchema.parse(mapped)).not.toThrow()
    expect(mapped.status).toBe('work_done')
  })

  it('falls back orderNumber to id when the domain column is null', () => {
    const mapped = mapOrderSummary(serviceOrder({ orderNumber: null }), opts)
    expect(mapped.orderNumber).toBe('order-1')
  })

  it('falls back requestedAt to updatedAt when the domain column is null', () => {
    const mapped = mapOrderSummary(
      serviceOrder({ requestedAt: null, updatedAt: new Date('2026-02-09T00:00:00Z') }),
      opts,
    )
    expect(mapped.requestedAt).toBe('2026-02-09T00:00:00.000Z')
  })

  it('maps serviceItems through field-for-field', () => {
    const mapped = mapOrderSummary(serviceOrder(), opts)
    expect(mapped.serviceItems).toEqual([{ id: 'si-1', name: 'Compressor A', serial: 'SN-123' }])
  })
})

describe('mapOrderDetail', () => {
  const worksheetSummary = mapWorksheetSummary(worksheet(), [worksheetLine()])
  const opts = {
    customerStatus: 'completed' as const,
    serviceItems: [{ id: 'si-1', name: 'Compressor A' }],
    worksheets: [worksheetSummary],
  }

  it('parses cleanly with timeline and invoices as empty required arrays', () => {
    const mapped = mapOrderDetail(serviceOrder(), opts)
    expect(() => orderDetailSchema.parse(mapped)).not.toThrow()
    expect(mapped.timeline).toEqual([])
    expect(mapped.invoices).toEqual([])
  })

  it('passes worksheets through', () => {
    const mapped = mapOrderDetail(serviceOrder(), opts)
    expect(mapped.worksheets).toEqual([worksheetSummary])
  })

  it('omits booking/feedback/confirmation', () => {
    const mapped = mapOrderDetail(serviceOrder(), opts)
    expect(mapped).not.toHaveProperty('booking')
    expect(mapped).not.toHaveProperty('feedback')
    expect(mapped).not.toHaveProperty('confirmation')
  })
})

describe('mapWorksheetSummary', () => {
  it('parses cleanly', () => {
    const mapped = mapWorksheetSummary(worksheet(), [worksheetLine()])
    expect(() => worksheetSummarySchema.parse(mapped)).not.toThrow()
  })

  it('maps rows field-for-field, converting numeric-string columns to numbers', () => {
    const mapped = mapWorksheetSummary(worksheet(), [worksheetLine()])
    expect(mapped.rows).toEqual([
      { description: 'Air filter', quantity: 2, unit: 'pcs', chargeType: 'invoiceable', price: 15.5, sum: 31 },
    ])
  })

  it('defaults quantity to 0 and omits price/sum/unit/serial when null', () => {
    const mapped = mapWorksheetSummary(worksheet(), [
      worksheetLine({ quantity: null, unit: null, serial: null, price: null, sum: null }),
    ])
    expect(mapped.rows[0]).toEqual({ description: 'Air filter', quantity: 0, chargeType: 'invoiceable' })
  })

  it('always reports signedOnSite from the row and reportPdf as false', () => {
    const mapped = mapWorksheetSummary(worksheet({ signedOnSite: false }), [])
    expect(mapped.signedOnSite).toBe(false)
    expect(mapped.reportPdf).toBe(false)
  })

  it('omits leadName/crewSize/timeTotalMinutes (no source available to this mapper)', () => {
    const mapped = mapWorksheetSummary(worksheet(), [])
    expect(mapped).not.toHaveProperty('leadName')
    expect(mapped).not.toHaveProperty('crewSize')
    expect(mapped).not.toHaveProperty('timeTotalMinutes')
  })
})
