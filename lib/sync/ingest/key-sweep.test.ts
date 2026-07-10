// lib/sync/ingest/key-sweep.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
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
    const adapter: RefListingAdapter = { listLiveRefs: vi.fn().mockResolvedValue(['CUST010']) }

    const result = await keySweepReconcile(db, adapter, erpCompanyId, 'CUVc')

    expect(result.tombstoned).toEqual(['CUST011'])

    const rows = await db.select().from(schema.customers).where(eq(schema.customers.erpCompanyId, erpCompanyId))
    const stays = rows.find((r) => r.erpRef === 'CUST010')
    const goes = rows.find((r) => r.erpRef === 'CUST011')
    expect(stays?.deletedAt).toBeNull()
    expect(goes?.deletedAt).toBeInstanceOf(Date)
  })

  it('does not tombstone another company\'s row that happens to share the same erpRef', async () => {
    const [otherTenant] = await db.insert(schema.tenants).values({ slug: 'sweep-t2', name: 'Sweep T2' }).returning()
    const [otherCompany] = await db
      .insert(schema.erpCompanies)
      .values({
        tenantId: otherTenant.id,
        displayName: 'Sweep C2',
        adapterType: 'standard_books',
        adapterConfigJson: {},
      })
      .returning()

    // Same erpRef as the already-tombstoned CUST011 from the first test, but
    // in a different erp_company_id — must not get swept by that company's run.
    await ingestCustomers(db, otherCompany.id, {
      upserts: [{ Code: 'CUST011', Name: 'Different company, same code' }],
      deletedRefs: [],
      cursor: '1',
    })

    const adapter: RefListingAdapter = { listLiveRefs: vi.fn().mockResolvedValue(['CUST010']) }
    await keySweepReconcile(db, adapter, erpCompanyId, 'CUVc')

    const [otherRow] = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.erpCompanyId, otherCompany.id))
    expect(otherRow.deletedAt).toBeNull()
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
})
