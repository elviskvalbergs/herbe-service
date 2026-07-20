// lib/documents/number-series.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), mirroring
// lib/domain/stores/erp-refs.test.ts. Covers the WS12 number-series store
// (docs/superpowers/plans/2026-07-20-service-phase1-ws12-documents.md
// decision 4): auto-seeding with default prefixes, atomic UPDATE…RETURNING
// increment, and — the point of the design — race safety under truly
// concurrent callers. The race tests run each concurrent call on a SEPARATE
// postgres() client so the two assigns are guaranteed to be distinct
// Postgres backend sessions, not queries serialized on one connection.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import {
  assignNumber,
  DEFAULT_PREFIXES,
  defaultPrefixFor,
  formatDocumentNumber,
} from './number-series'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let sql2: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let db2: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string

async function newTenant(slug: string): Promise<string> {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  return tenant.id
}

async function seriesRow(forTenantId: string, docType: string) {
  const [row] = await db
    .select()
    .from(schema.documentNumberSeries)
    .where(
      and(
        eq(schema.documentNumberSeries.tenantId, forTenantId),
        eq(schema.documentNumberSeries.docType, docType),
      ),
    )
  return row
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  sql2 = postgres(testDb.url)
  db = drizzle(sql, { schema })
  db2 = drizzle(sql2, { schema })
  tenantId = await newTenant('t1')
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await sql2?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('formatDocumentNumber', () => {
  it('pads the counter to 5 digits', () => {
    expect(formatDocumentNumber('SR', 2026, 142)).toBe('SR-2026-00142')
  })

  it('pads 1 to 00001', () => {
    expect(formatDocumentNumber('SR', 2026, 1)).toBe('SR-2026-00001')
  })

  it('does not truncate counters wider than 5 digits', () => {
    expect(formatDocumentNumber('OC', 2027, 123456)).toBe('OC-2027-123456')
  })
})

describe('DEFAULT_PREFIXES / defaultPrefixFor', () => {
  it('maps the known doc types', () => {
    expect(DEFAULT_PREFIXES.order_report).toBe('SR')
    expect(DEFAULT_PREFIXES.order_confirmation).toBe('OC')
  })

  it('derives uppercase initials for unmapped doc types', () => {
    expect(defaultPrefixFor('delivery_note')).toBe('DN')
    expect(defaultPrefixFor('invoice')).toBe('I')
  })

  it("falls back to 'DOC' when no initials can be derived", () => {
    expect(defaultPrefixFor('')).toBe('DOC')
  })
})

describe('assignNumber', () => {
  it('auto-seeds on first call and returns SR-2026-00001 for order_report', async () => {
    const t = await newTenant('t-first')
    const { number, seriesId } = await assignNumber(db, {
      tenantId: t,
      docType: 'order_report',
      year: 2026,
    })
    expect(number).toBe('SR-2026-00001')

    const row = await seriesRow(t, 'order_report')
    expect(row).toBeDefined()
    expect(row.id).toBe(seriesId)
    expect(row.prefix).toBe('SR')
    expect(row.nextCounter).toBe(2)
  })

  it('sequential calls increment: 00001 then 00002, same series', async () => {
    const t = await newTenant('t-seq')
    const first = await assignNumber(db, { tenantId: t, docType: 'order_report', year: 2026 })
    const second = await assignNumber(db, { tenantId: t, docType: 'order_report', year: 2026 })
    expect(first.number).toBe('SR-2026-00001')
    expect(second.number).toBe('SR-2026-00002')
    expect(second.seriesId).toBe(first.seriesId)
  })

  it('distinct docTypes get independent counters and prefixes', async () => {
    const t = await newTenant('t-types')
    const report = await assignNumber(db, { tenantId: t, docType: 'order_report', year: 2026 })
    const confirmation = await assignNumber(db, {
      tenantId: t,
      docType: 'order_confirmation',
      year: 2026,
    })
    const report2 = await assignNumber(db, { tenantId: t, docType: 'order_report', year: 2026 })

    expect(report.number).toBe('SR-2026-00001')
    expect(confirmation.number).toBe('OC-2026-00001') // own counter, own prefix
    expect(report2.number).toBe('SR-2026-00002') // unaffected by the OC assign
    expect(confirmation.seriesId).not.toBe(report.seriesId)
  })

  it('derives uppercase initials for unmapped docTypes', async () => {
    const t = await newTenant('t-derived')
    const { number } = await assignNumber(db, { tenantId: t, docType: 'delivery_note', year: 2026 })
    expect(number).toBe('DN-2026-00001')
  })

  it('distinct tenants get independent series for the same docType', async () => {
    const a = await newTenant('t-iso-a')
    const b = await newTenant('t-iso-b')
    const first = await assignNumber(db, { tenantId: a, docType: 'order_report', year: 2026 })
    const second = await assignNumber(db, { tenantId: b, docType: 'order_report', year: 2026 })
    expect(first.number).toBe('SR-2026-00001')
    expect(second.number).toBe('SR-2026-00001')
    expect(first.seriesId).not.toBe(second.seriesId)
  })

  it('works inside a drizzle transaction', async () => {
    const t = await newTenant('t-tx')
    const number = await db.transaction(async (tx) => {
      const res = await assignNumber(tx, { tenantId: t, docType: 'order_report', year: 2026 })
      return res.number
    })
    expect(number).toBe('SR-2026-00001')
  })

  it('RACE: two concurrent assigns on separate connections return distinct numbers, next_counter ends at 3', async () => {
    const t = await newTenant('t-race')
    // Pre-seed so this test isolates the increment race from the seed race.
    await assignNumber(db, { tenantId: t, docType: 'order_report', year: 2026 })

    const [a, b] = await Promise.all([
      assignNumber(db, { tenantId: t, docType: 'order_report', year: 2026 }),
      assignNumber(db2, { tenantId: t, docType: 'order_report', year: 2026 }),
    ])

    expect(a.number).not.toBe(b.number)
    expect([a.number, b.number].sort()).toEqual(['SR-2026-00002', 'SR-2026-00003'])
    const row = await seriesRow(t, 'order_report')
    expect(row.nextCounter).toBe(4)
  })

  it('RACE: two concurrent first calls on an unseeded (tenant, docType) both succeed with distinct numbers', async () => {
    const t = await newTenant('t-seed-race')

    const [a, b] = await Promise.all([
      assignNumber(db, { tenantId: t, docType: 'order_report', year: 2026 }),
      assignNumber(db2, { tenantId: t, docType: 'order_report', year: 2026 }),
    ])

    expect(a.number).not.toBe(b.number)
    expect([a.number, b.number].sort()).toEqual(['SR-2026-00001', 'SR-2026-00002'])
    expect(a.seriesId).toBe(b.seriesId) // exactly one series row was seeded

    const row = await seriesRow(t, 'order_report')
    expect(row.nextCounter).toBe(3)
  })
})
