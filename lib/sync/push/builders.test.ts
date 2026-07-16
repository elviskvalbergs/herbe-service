// lib/sync/push/builders.test.ts
//
// Pure unit tests for the SVOVc/WSVc push payload builders (WS4 outbound
// slice, docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decisions 5/7). No DB, no HTTP — every input is plain data, matching what
// the saga engine (Task 5) will supply.
import { describe, expect, it } from 'vitest'
import { ErpPermanentError } from '@herbe/erp-core'
import { buildSvoCreatePayload, buildWsCreatePayload, wsSumup } from './builders'

describe('buildSvoCreatePayload', () => {
  const baseInput = {
    customerErpRef: 'CUST001',
    requestedAt: null as Date | null,
    description: null as string | null,
    defaultChargeType: 'invoiceable' as const,
    rows: [] as Array<{ serialNr: string | null; itemCode: string | null; chargeType: 'invoiceable' | 'warranty' | 'contract' | 'goodwill' | null }>,
    now: new Date('2026-07-16T12:00:00Z'),
  }

  it('throws an actionable ErpPermanentError when the customer has no ERP reference (null)', () => {
    expect(() => buildSvoCreatePayload({ ...baseInput, customerErpRef: null })).toThrow(ErpPermanentError)
    expect(() => buildSvoCreatePayload({ ...baseInput, customerErpRef: null })).toThrow(/customer/i)
  })

  it('throws the same error when the customer ERP reference is an empty string', () => {
    expect(() => buildSvoCreatePayload({ ...baseInput, customerErpRef: '' })).toThrow(ErpPermanentError)
  })

  it('sets CustCode to the customer ERP reference', () => {
    const payload = buildSvoCreatePayload(baseInput)
    expect(payload.CustCode).toBe('CUST001')
  })

  it('TransDate uses the order requestedAt date (YYYY-MM-DD) when present', () => {
    const payload = buildSvoCreatePayload({ ...baseInput, requestedAt: new Date('2026-07-01T08:30:00Z') })
    expect(payload.TransDate).toBe('2026-07-01')
  })

  it('TransDate falls back to now when requestedAt is null', () => {
    const payload = buildSvoCreatePayload({ ...baseInput, requestedAt: null })
    expect(payload.TransDate).toBe('2026-07-16')
  })

  it('omits CustComplaint1 entirely when there is no description', () => {
    const payload = buildSvoCreatePayload({ ...baseInput, description: null })
    expect('CustComplaint1' in payload).toBe(false)
  })

  it('sets CustComplaint1 to the description when 60 chars or fewer', () => {
    const payload = buildSvoCreatePayload({ ...baseInput, description: 'Unit not cooling' })
    expect(payload.CustComplaint1).toBe('Unit not cooling')
  })

  it('truncates CustComplaint1 to the first 60 characters of a longer description', () => {
    const longDescription = 'A'.repeat(80)
    const payload = buildSvoCreatePayload({ ...baseInput, description: longDescription })
    expect(payload.CustComplaint1).toBe('A'.repeat(60))
  })

  it('never includes a SerNr field — the ERP allocates the number', () => {
    const payload = buildSvoCreatePayload({
      ...baseInput,
      rows: [{ serialNr: 'SN1', itemCode: 'ITEM1', chargeType: 'invoiceable' }],
    })
    expect('SerNr' in payload).toBe(false)
  })

  it('builds a row with ArtCode, Quant:1, SerialNr and the ItemType integer', () => {
    const payload = buildSvoCreatePayload({
      ...baseInput,
      rows: [{ serialNr: 'SN1', itemCode: 'ITEM1', chargeType: 'warranty' }],
    })
    expect(payload.rows).toEqual([{ ArtCode: 'ITEM1', Quant: 1, SerialNr: 'SN1', ItemType: 2 }])
  })

  it('omits ArtCode on a row when itemCode is null but keeps SerialNr', () => {
    const payload = buildSvoCreatePayload({
      ...baseInput,
      rows: [{ serialNr: 'SN1', itemCode: null, chargeType: 'invoiceable' }],
    })
    const row = (payload.rows as Record<string, unknown>[])[0]
    expect('ArtCode' in row).toBe(false)
    expect(row.SerialNr).toBe('SN1')
  })

  it('omits SerialNr on a row when serialNr is null but keeps ArtCode', () => {
    const payload = buildSvoCreatePayload({
      ...baseInput,
      rows: [{ serialNr: null, itemCode: 'ITEM1', chargeType: 'invoiceable' }],
    })
    const row = (payload.rows as Record<string, unknown>[])[0]
    expect('SerialNr' in row).toBe(false)
    expect(row.ArtCode).toBe('ITEM1')
  })

  it('throws an actionable ErpPermanentError naming the row when BOTH itemCode and serialNr are null', () => {
    expect(() =>
      buildSvoCreatePayload({ ...baseInput, rows: [{ serialNr: null, itemCode: null, chargeType: null }] }),
    ).toThrow(ErpPermanentError)
    expect(() =>
      buildSvoCreatePayload({ ...baseInput, rows: [{ serialNr: null, itemCode: null, chargeType: null }] }),
    ).toThrow(/row 1/i)
  })

  it('uses the row chargeType for ItemType when present, mapped via chargeTypeToItemType', () => {
    const payload = buildSvoCreatePayload({
      ...baseInput,
      defaultChargeType: 'invoiceable',
      rows: [{ serialNr: 'SN1', itemCode: 'ITEM1', chargeType: 'contract' }],
    })
    const row = (payload.rows as Record<string, unknown>[])[0]
    expect(row.ItemType).toBe(3)
  })

  it('falls back to the order defaultChargeType for ItemType when the row has no chargeType', () => {
    const payload = buildSvoCreatePayload({
      ...baseInput,
      defaultChargeType: 'goodwill',
      rows: [{ serialNr: 'SN1', itemCode: 'ITEM1', chargeType: null }],
    })
    const row = (payload.rows as Record<string, unknown>[])[0]
    expect(row.ItemType).toBe(4)
  })

  it('reports both-null errors by 1-based row index across multiple rows', () => {
    expect(() =>
      buildSvoCreatePayload({
        ...baseInput,
        rows: [
          { serialNr: 'SN1', itemCode: 'ITEM1', chargeType: 'invoiceable' },
          { serialNr: null, itemCode: null, chargeType: null },
        ],
      }),
    ).toThrow(/row 2/i)
  })
})

describe('buildWsCreatePayload', () => {
  const baseInput = {
    orderErpRef: '230022',
    liveSvo: {} as Record<string, unknown>,
    emCode: 'TECH1',
    location: 'VAN-1',
    rows: [] as Array<{
      itemCode: string | null
      description: string | null
      quantity: number | null
      price: number | null
      sum: number | null
      serial: string | null
      chargeType: 'invoiceable' | 'warranty' | 'contract' | 'goodwill'
    }>,
    timeEntries: [] as Array<{ minutes: number | null }>,
    distanceEntries: [] as Array<{ km: number | null; billable: boolean | null }>,
    config: {} as { laborItemCode?: string; distanceItemCode?: string; fallbackItemCode?: string },
  }

  it('throws an actionable ErpPermanentError when the live SVOVc DoneMark is the string "1"', () => {
    expect(() => buildWsCreatePayload({ ...baseInput, liveSvo: { DoneMark: '1' } })).toThrow(ErpPermanentError)
    expect(() => buildWsCreatePayload({ ...baseInput, liveSvo: { DoneMark: '1' } })).toThrow(/done/i)
  })

  it('throws the same error when DoneMark is the number 1', () => {
    expect(() => buildWsCreatePayload({ ...baseInput, liveSvo: { DoneMark: 1 } })).toThrow(ErpPermanentError)
  })

  it('does not throw when DoneMark is "0", 0, or absent', () => {
    expect(() => buildWsCreatePayload({ ...baseInput, liveSvo: { DoneMark: '0' } })).not.toThrow()
    expect(() => buildWsCreatePayload({ ...baseInput, liveSvo: { DoneMark: 0 } })).not.toThrow()
    expect(() => buildWsCreatePayload({ ...baseInput, liveSvo: {} })).not.toThrow()
  })

  it('always sets SVONr, WONr:-1, EMCode, Location and UpdStockFlag:1', () => {
    const payload = buildWsCreatePayload(baseInput)
    expect(payload.SVONr).toBe('230022')
    expect(payload.WONr).toBe(-1)
    expect(payload.EMCode).toBe('TECH1')
    expect(payload.Location).toBe('VAN-1')
    expect(payload.UpdStockFlag).toBe(1)
  })

  it('never includes a SerNr field — this is a create', () => {
    const payload = buildWsCreatePayload(baseInput)
    expect('SerNr' in payload).toBe(false)
  })

  it('copies verbatim header fields from the live SVOVc when present and non-empty', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      liveSvo: {
        CustCode: 'CUST001',
        Addr0: 'Street 1',
        CustContact: 'Jane',
        Objects: 'OBJ1',
        Phone: '+371...',
        LangCode: 'EN',
        CurncyCode: 'EUR',
        FrRate: 1,
        ToRateB1: 1,
        ToRateB2: 1,
        BaseRate1: 1,
        BaseRate2: 1,
        InvoiceToCode: 'INV1',
        CustVATCode: 'VAT1',
        PriceList: 'PL1',
        InclVAT: 1,
        ExportFlag: 0,
      },
    })
    expect(payload.CustCode).toBe('CUST001')
    expect(payload.Addr0).toBe('Street 1')
    expect(payload.CustContact).toBe('Jane')
    expect(payload.Objects).toBe('OBJ1')
    expect(payload.Phone).toBe('+371...')
    expect(payload.LangCode).toBe('EN')
    expect(payload.CurncyCode).toBe('EUR')
    expect(payload.FrRate).toBe(1)
    expect(payload.ToRateB1).toBe(1)
    expect(payload.ToRateB2).toBe(1)
    expect(payload.BaseRate1).toBe(1)
    expect(payload.BaseRate2).toBe(1)
    expect(payload.InvoiceToCode).toBe('INV1')
    expect(payload.CustVATCode).toBe('VAT1')
    expect(payload.PriceList).toBe('PL1')
    expect(payload.InclVAT).toBe(1)
    // ExportFlag: 0 is present-and-non-empty — must be copied, not skipped.
    expect(payload.ExportFlag).toBe(0)
  })

  it('skips verbatim-copy fields that are empty string, null, or absent on the live SVOVc', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      liveSvo: { CustCode: 'CUST001', Addr0: '', CustContact: null },
    })
    expect(payload.CustCode).toBe('CUST001')
    expect('Addr0' in payload).toBe(false)
    expect('CustContact' in payload).toBe(false)
    expect('Objects' in payload).toBe(false) // absent on liveSvo entirely
  })

  it('builds a part row with ArtCode from itemCode, Quant defaulting to 1, and ItemType via chargeTypeToItemType', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      rows: [
        {
          itemCode: 'PART1',
          description: 'Filter',
          quantity: null,
          price: null,
          sum: null,
          serial: null,
          chargeType: 'warranty',
        },
      ],
    })
    expect(payload.rows).toEqual([{ ArtCode: 'PART1', Quant: 1, ItemType: 2 }])
  })

  it('uses the given quantity, price, sum and serial on a row when present', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      rows: [
        {
          itemCode: 'PART1',
          description: 'Filter',
          quantity: 3,
          price: 10.5,
          sum: 31.5,
          serial: 'SN9',
          chargeType: 'invoiceable',
        },
      ],
    })
    expect(payload.rows).toEqual([
      { ArtCode: 'PART1', Quant: 3, Price: 10.5, Sum: 31.5, SerialNr: 'SN9', ItemType: 1 },
    ])
  })

  it('falls back to config.fallbackItemCode when a row has no itemCode', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      rows: [
        {
          itemCode: null,
          description: 'Misc part',
          quantity: 1,
          price: null,
          sum: null,
          serial: null,
          chargeType: 'invoiceable',
        },
      ],
      config: { fallbackItemCode: 'MISC' },
    })
    const row = (payload.rows as Record<string, unknown>[])[0]
    expect(row.ArtCode).toBe('MISC')
  })

  it('throws an actionable ErpPermanentError naming the row when itemCode AND fallbackItemCode are both missing', () => {
    const input = {
      ...baseInput,
      rows: [
        {
          itemCode: null,
          description: 'Misc part',
          quantity: 1,
          price: null,
          sum: null,
          serial: null,
          chargeType: 'invoiceable' as const,
        },
      ],
    }
    expect(() => buildWsCreatePayload(input)).toThrow(ErpPermanentError)
    expect(() => buildWsCreatePayload(input)).toThrow(/Misc part/)
  })

  it('names the row by position when it has no description either', () => {
    const input = {
      ...baseInput,
      rows: [
        { itemCode: null, description: null, quantity: 1, price: null, sum: null, serial: null, chargeType: 'invoiceable' as const },
      ],
    }
    expect(() => buildWsCreatePayload(input)).toThrow(/row #1|row 1/i)
  })

  it('produces no labor row and no error when there are no time entries with minutes, even without laborItemCode configured', () => {
    const payload = buildWsCreatePayload({ ...baseInput, timeEntries: [{ minutes: null }] })
    expect(payload.rows).toEqual([])
  })

  it('throws an actionable ErpPermanentError naming push.laborItemCode when time entries have minutes but the setting is missing', () => {
    const input = { ...baseInput, timeEntries: [{ minutes: 30 }] }
    expect(() => buildWsCreatePayload(input)).toThrow(ErpPermanentError)
    expect(() => buildWsCreatePayload(input)).toThrow(/push\.laborItemCode/)
  })

  it('pluralizes the missing-labor-setting message for more than one time entry', () => {
    const input = { ...baseInput, timeEntries: [{ minutes: 30 }, { minutes: 20 }] }
    expect(() => buildWsCreatePayload(input)).toThrow(/2 time entries/)
  })

  it('adds one labor row with hours rounded UP to the nearest 0.25 (61 minutes -> 1.25)', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      timeEntries: [{ minutes: 61 }],
      config: { laborItemCode: 'LABOR' },
    })
    expect(payload.rows).toEqual([{ ArtCode: 'LABOR', Quant: 1.25, ItemType: 1 }])
  })

  it('sums multiple time entries before rounding, ignoring entries with null minutes', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      timeEntries: [{ minutes: 30 }, { minutes: 31 }, { minutes: null }],
      config: { laborItemCode: 'LABOR' },
    })
    const row = (payload.rows as Record<string, unknown>[])[0]
    expect(row.Quant).toBe(1.25) // 61 total minutes -> same as the single-entry case
  })

  it('does not round up when the total hours already land exactly on a quarter-hour boundary', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      timeEntries: [{ minutes: 90 }],
      config: { laborItemCode: 'LABOR' },
    })
    const row = (payload.rows as Record<string, unknown>[])[0]
    expect(row.Quant).toBe(1.5)
  })

  it('produces no distance row and no error when there are no billable km, even without distanceItemCode configured', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      distanceEntries: [
        { km: 10, billable: false },
        { km: null, billable: true },
      ],
    })
    expect(payload.rows).toEqual([])
  })

  it('throws an actionable ErpPermanentError naming push.distanceItemCode when billable km exist but the setting is missing', () => {
    const input = { ...baseInput, distanceEntries: [{ km: 12, billable: true }] }
    expect(() => buildWsCreatePayload(input)).toThrow(ErpPermanentError)
    expect(() => buildWsCreatePayload(input)).toThrow(/push\.distanceItemCode/)
  })

  it('pluralizes the missing-distance-setting message for more than one billable distance entry', () => {
    const input = { ...baseInput, distanceEntries: [{ km: 12, billable: true }, { km: 3, billable: null }] }
    expect(() => buildWsCreatePayload(input)).toThrow(/2 billable distance entries/)
  })

  it('sums billable distance (billable:true or billable:null), skipping billable:false, into one row', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      distanceEntries: [
        { km: 10, billable: true },
        { km: 5, billable: null },
        { km: 100, billable: false },
      ],
      config: { distanceItemCode: 'DIST' },
    })
    expect(payload.rows).toEqual([{ ArtCode: 'DIST', Quant: 15, ItemType: 1 }])
  })

  it('assembles part, labor and distance rows together with totals from wsSumup', () => {
    const payload = buildWsCreatePayload({
      ...baseInput,
      rows: [
        { itemCode: 'PART1', description: null, quantity: 2, price: 10, sum: 20, serial: null, chargeType: 'invoiceable' },
      ],
      timeEntries: [{ minutes: 60 }],
      distanceEntries: [{ km: 8, billable: true }],
      config: { laborItemCode: 'LABOR', distanceItemCode: 'DIST' },
    })
    expect(payload.rows).toEqual([
      { ArtCode: 'PART1', Quant: 2, Price: 10, Sum: 20, ItemType: 1 },
      { ArtCode: 'LABOR', Quant: 1, ItemType: 1 },
      { ArtCode: 'DIST', Quant: 8, ItemType: 1 },
    ])
    // Only the part row has a Sum; labor/distance rows contribute 0 (no price data yet).
    expect(payload.Sum1).toBe(20)
    expect(payload.Sum3).toBe(0)
    expect(payload.Sum4).toBe(20)
  })
})

describe('wsSumup', () => {
  it('sums row Sum values for Sum1, sets Sum3 to 0 and Sum4 equal to Sum1', () => {
    expect(wsSumup([{ Sum: 10 }, { Sum: 5 }])).toEqual({ Sum1: 15, Sum3: 0, Sum4: 15 })
  })

  it('falls back to Price*Quant for a row lacking Sum when both are present', () => {
    expect(wsSumup([{ Price: 10.5, Quant: 3 }])).toEqual({ Sum1: 31.5, Sum3: 0, Sum4: 31.5 })
  })

  it('prefers an explicit Sum over Price*Quant when both are present', () => {
    expect(wsSumup([{ Sum: 15, Price: 999, Quant: 999 }])).toEqual({ Sum1: 15, Sum3: 0, Sum4: 15 })
  })

  it('contributes 0 for a row with neither Sum nor a Price+Quant pair', () => {
    expect(wsSumup([{ Quant: 5 }])).toEqual({ Sum1: 0, Sum3: 0, Sum4: 0 })
    expect(wsSumup([{ Price: 5 }])).toEqual({ Sum1: 0, Sum3: 0, Sum4: 0 })
    expect(wsSumup([{}])).toEqual({ Sum1: 0, Sum3: 0, Sum4: 0 })
  })

  it('rounds Sum1/Sum4 to 2 decimals, absorbing floating-point noise', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in raw JS floating point.
    expect(wsSumup([{ Sum: 0.1 }, { Sum: 0.2 }])).toEqual({ Sum1: 0.3, Sum3: 0, Sum4: 0.3 })
  })

  it('sums across a mix of Sum rows and Price*Quant fallback rows', () => {
    expect(wsSumup([{ Sum: 20 }, { Price: 2.5, Quant: 4 }])).toEqual({ Sum1: 30, Sum3: 0, Sum4: 30 })
  })
})
