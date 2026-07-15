// lib/sync/ingest/key-sweep.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { ingestCustomers } from './customers'
import { keySweepReconcile, type RefListingAdapter } from './key-sweep'

describe('keySweepReconcile (unit, fake db + fake adapter)', () => {
  it('tombstones erpRefs that are no longer present in the ERP', async () => {
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ erpRef: 'CUST001' }, { erpRef: 'CUST002' }]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      }),
    }

    const fakeAdapter: RefListingAdapter = {
      listLiveRefs: vi.fn().mockResolvedValue(['CUST001']), // CUST002 no longer exists in the ERP
    }

    const result = await keySweepReconcile(fakeDb as never, fakeAdapter, 'company-1', 'CUVc')

    expect(result.tombstoned).toEqual(['CUST002'])
  })
})

describe('keySweepReconcile (integration, real harness DB)', () => {
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let tenantId: string
  let erpCompanyId: string

  beforeAll(async () => {
    testDb = await createTestDatabase()
    await runMigrations(testDb.url)
    sql = postgres(testDb.url)
    db = drizzle(sql, { schema })

    const [tenant] = await db.insert(schema.tenants).values({ slug: 'sweep-t1', name: 'Sweep T1' }).returning()
    tenantId = tenant.id
    const [company] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId: tenant.id, displayName: 'Sweep C1', adapterType: 'standard_books', adapterConfigJson: {} })
      .returning()
    erpCompanyId = company.id

    await ingestCustomers(db, erpCompanyId, {
      upserts: [
        { Code: 'CUST010', Name: 'Stays' },
        { Code: 'CUST011', Name: 'Goes' },
      ],
      deletedRefs: [],
      cursor: '1',
    })
  }, 60_000)

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('soft-deletes rows whose erpRef is no longer live and leaves the rest alone', async () => {
    const before = await db.select().from(schema.customers).where(eq(schema.customers.erpCompanyId, erpCompanyId))
    const goesBefore = before.find((r) => r.erpRef === 'CUST011')

    const adapter: RefListingAdapter = { listLiveRefs: vi.fn().mockResolvedValue(['CUST010']) }

    const result = await keySweepReconcile(db, adapter, erpCompanyId, 'CUVc')

    expect(result.tombstoned).toEqual(['CUST011'])

    const rows = await db.select().from(schema.customers).where(eq(schema.customers.erpCompanyId, erpCompanyId))
    const stays = rows.find((r) => r.erpRef === 'CUST010')
    const goes = rows.find((r) => r.erpRef === 'CUST011')
    expect(stays?.deletedAt).toBeNull()
    expect(goes?.deletedAt).toBeInstanceOf(Date)
    // The tombstone UPDATE must fire bump_change_seq() the same as any other
    // write — devices polling `change_seq > X` rely on this to see deletions.
    expect(goes?.changeSeq).toBeGreaterThan(goesBefore!.changeSeq)
  })

  it('does not tombstone another company\'s row that happens to share the same erpRef (isolated fixture)', async () => {
    // Fresh companies + a fresh erpRef untouched by any other test in this
    // file, so keySweepReconcile's `storedRows` query (deletedAt IS NULL)
    // genuinely has BOTH companies' live rows to consider — unlike a shared
    // erpRef that a prior test already tombstoned, where the row is filtered
    // out of storedRows before the tombstone UPDATE is ever invoked, and the
    // "isolation" assertion would pass trivially regardless of the update's
    // WHERE clause.
    const [tenantA] = await db.insert(schema.tenants).values({ slug: 'sweep-ta', name: 'Sweep TA' }).returning()
    const [companyA] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId: tenantA.id, displayName: 'Sweep CA', adapterType: 'standard_books', adapterConfigJson: {} })
      .returning()
    const [tenantB] = await db.insert(schema.tenants).values({ slug: 'sweep-tb', name: 'Sweep TB' }).returning()
    const [companyB] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId: tenantB.id, displayName: 'Sweep CB', adapterType: 'standard_books', adapterConfigJson: {} })
      .returning()

    // Same erpRef in two different companies, both live (deletedAt null).
    await ingestCustomers(db, companyA.id, {
      upserts: [{ Code: 'SHARED001', Name: 'Company A copy' }],
      deletedRefs: [],
      cursor: '1',
    })
    await ingestCustomers(db, companyB.id, {
      upserts: [{ Code: 'SHARED001', Name: 'Company B copy' }],
      deletedRefs: [],
      cursor: '1',
    })

    // Company A's live set from the ERP does not include SHARED001 -> it must
    // be tombstoned for company A only.
    const adapter: RefListingAdapter = { listLiveRefs: vi.fn().mockResolvedValue([]) }
    const result = await keySweepReconcile(db, adapter, companyA.id, 'CUVc')
    expect(result.tombstoned).toEqual(['SHARED001'])

    const [rowA] = await db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.erpCompanyId, companyA.id), eq(schema.customers.erpRef, 'SHARED001')))
    const [rowB] = await db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.erpCompanyId, companyB.id), eq(schema.customers.erpRef, 'SHARED001')))

    expect(rowA.deletedAt).toBeInstanceOf(Date)
    // Company B's row with the same erpRef must remain untouched — this is
    // the assertion that fails if `eq(table.erpCompanyId, erpCompanyId)` is
    // ever removed from the tombstone UPDATE's WHERE clause.
    expect(rowB.deletedAt).toBeNull()
  })

  it('sweeps the items table (not customers) when register is INVc', async () => {
    await db.insert(schema.items).values([
      { tenantId, erpCompanyId, erpRef: 'ITEM01', name: 'Stays', changeSeq: BigInt(0) },
      { tenantId, erpCompanyId, erpRef: 'ITEM02', name: 'Goes', changeSeq: BigInt(0) },
    ])

    const adapter: RefListingAdapter = { listLiveRefs: vi.fn().mockResolvedValue(['ITEM01']) }
    const result = await keySweepReconcile(db, adapter, erpCompanyId, 'INVc')

    expect(result.tombstoned).toEqual(['ITEM02'])

    const rows = await db.select().from(schema.items).where(eq(schema.items.erpCompanyId, erpCompanyId))
    expect(rows.find((r) => r.erpRef === 'ITEM01')?.deletedAt).toBeNull()
    expect(rows.find((r) => r.erpRef === 'ITEM02')?.deletedAt).toBeInstanceOf(Date)
  })

  it('sweeps the service_items table by serial when register is SVOSerVc', async () => {
    await db.insert(schema.serviceItems).values([
      { tenantId, erpCompanyId, erpRef: 'SN-STAYS', kind: 'unit', name: 'Stays', labelId: `erp:${erpCompanyId}:SN-STAYS`, changeSeq: BigInt(0) },
      { tenantId, erpCompanyId, erpRef: 'SN-GOES', kind: 'unit', name: 'Goes', labelId: `erp:${erpCompanyId}:SN-GOES`, changeSeq: BigInt(0) },
    ])

    const adapter: RefListingAdapter = { listLiveRefs: vi.fn().mockResolvedValue(['SN-STAYS']) }
    const result = await keySweepReconcile(db, adapter, erpCompanyId, 'SVOSerVc')

    expect(result.tombstoned).toEqual(['SN-GOES'])

    const rows = await db.select().from(schema.serviceItems).where(eq(schema.serviceItems.erpCompanyId, erpCompanyId))
    expect(rows.find((r) => r.erpRef === 'SN-STAYS')?.deletedAt).toBeNull()
    expect(rows.find((r) => r.erpRef === 'SN-GOES')?.deletedAt).toBeInstanceOf(Date)
  })
})
