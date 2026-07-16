// lib/sync/sync-connection.test.ts
//
// DB-backed orchestrator test: fake-ERP server + local-Postgres test harness
// (same idiom as the per-register ingest tests, e.g. service-orders.test.ts).
// Exercises the full register sequence in one pass — CUVc -> DelAddrVc ->
// SVOSerVc -> SVOVc -> WSVc — including the cross-register DelAddrVc ->
// SVOVc siteName resolution, sync_state bookkeeping, per-register error
// isolation, and idempotent re-runs.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeErpServer } from '@herbe/fake-erp'
import type { ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { createStandardBooksAdapter } from '@/lib/erp/standard-books/adapter'
import { syncConnection } from './sync-connection'

let server: Awaited<ReturnType<typeof startFakeErpServer>>
let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string

beforeAll(async () => {
  server = await startFakeErpServer({ port: 0 })
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'sync-t1', name: 'Sync T1' }).returning()
  tenantId = tenant.id
}, 60_000)

afterAll(async () => {
  await server.close()
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

function buildAdapter(): ErpAdapter {
  return createStandardBooksAdapter({
    baseUrl: server.url,
    companyNumber: '1',
    auth: { kind: 'basic', username: 'test', password: 'test' },
  })
}

// Wraps a real adapter so one named register's full-list pull always
// throws — simulates an adapter-level failure (e.g. a network error on one
// register) without touching any ingest module, to exercise syncConnection's
// per-register error isolation.
function adapterWithFailingRegister(base: ErpAdapter, failingRegister: string): ErpAdapter {
  return {
    ...base,
    async pullFullList(register: string) {
      if (register === failingRegister) throw new Error(`simulated failure for ${failingRegister}`)
      return base.pullFullList(register)
    },
  }
}

async function insertCompany(displayName: string): Promise<string> {
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName, adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return company.id
}

async function syncStateRows(erpCompanyId: string) {
  return db.select().from(schema.erpSyncState).where(eq(schema.erpSyncState.erpCompanyId, erpCompanyId))
}

async function countsFor(erpCompanyId: string) {
  const [customers, serviceItems, orders, worksheets] = await Promise.all([
    db.select().from(schema.customers).where(eq(schema.customers.erpCompanyId, erpCompanyId)),
    db.select().from(schema.serviceItems).where(eq(schema.serviceItems.erpCompanyId, erpCompanyId)),
    db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.erpCompanyId, erpCompanyId)),
    db.select().from(schema.worksheets).where(eq(schema.worksheets.erpCompanyId, erpCompanyId)),
  ])
  return {
    customers: customers.length,
    serviceItems: serviceItems.length,
    orders: orders.length,
    worksheets: worksheets.length,
  }
}

describe('syncConnection', () => {
  it('ingests every register, resolves siteName via DelAddrVc, and stamps sync_state per register', async () => {
    const erpCompanyId = await insertCompany('Full Sync Co')
    const adapter = buildAdapter()

    const summary = await syncConnection(db, adapter, erpCompanyId)

    expect(summary.perRegister.CUVc?.error).toBeUndefined()
    expect(summary.perRegister.DelAddrVc?.error).toBeUndefined()
    expect(summary.perRegister.SVOSerVc?.error).toBeUndefined()
    expect(summary.perRegister.SVOVc?.error).toBeUndefined()
    expect(summary.perRegister.WSVc?.error).toBeUndefined()

    expect(summary.perRegister.CUVc?.ingested).toBeGreaterThan(0)
    expect(summary.perRegister.SVOSerVc?.ingested).toBeGreaterThan(0)
    expect(summary.perRegister.SVOVc?.ingested).toBeGreaterThan(0)
    expect(summary.perRegister.WSVc?.ingested).toBeGreaterThan(0)

    const counts = await countsFor(erpCompanyId)
    expect(counts.customers).toBeGreaterThan(0)
    expect(counts.serviceItems).toBeGreaterThan(0)
    expect(counts.orders).toBeGreaterThan(0)
    expect(counts.worksheets).toBeGreaterThan(0)

    // svovc.json's SerNr 5001 carries DelAddrCode "DEL001", which
    // deladdrvc.json maps to "Riga Service Site" — the cross-register
    // resolution this orchestrator exists to wire up (DelAddrVc -> SVOVc).
    const orders = await db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.erpCompanyId, erpCompanyId))
    const order5001 = orders.find((o) => o.orderNumber === '5001')
    expect(order5001?.siteName).toBe('Riga Service Site')

    const states = await syncStateRows(erpCompanyId)
    expect(states).toHaveLength(5)
    for (const state of states) {
      expect(state.syncStatus).toBe('idle')
      expect(state.lastSyncAt).toBeInstanceOf(Date)
      expect(state.errorMessage).toBeNull()
    }

    // Delta registers persist the adapter's returned cursor (fake-ERP's
    // @sequence high-water mark), which is non-zero for both fixtures.
    expect(states.find((s) => s.register === 'CUVc')?.syncCursor).not.toBe('0')
    expect(states.find((s) => s.register === 'DelAddrVc')?.syncCursor).not.toBe('0')

    // No-delta registers stamp lastFullSyncAt on every run.
    for (const register of ['SVOSerVc', 'SVOVc', 'WSVc']) {
      expect(states.find((s) => s.register === register)?.lastFullSyncAt).toBeInstanceOf(Date)
    }
    // Delta registers never set lastFullSyncAt — they have no "full pull" concept.
    expect(states.find((s) => s.register === 'CUVc')?.lastFullSyncAt).toBeNull()
    expect(states.find((s) => s.register === 'DelAddrVc')?.lastFullSyncAt).toBeNull()
  })

  it('re-running syncConnection against the same company does not duplicate rows', async () => {
    const erpCompanyId = await insertCompany('Idempotent Co')
    const adapter = buildAdapter()

    await syncConnection(db, adapter, erpCompanyId)
    const countsAfterFirst = await countsFor(erpCompanyId)

    await syncConnection(db, adapter, erpCompanyId)
    const countsAfterSecond = await countsFor(erpCompanyId)

    expect(countsAfterSecond).toEqual(countsAfterFirst)
  })

  it('isolates a single register failure — its sync_state records error while the rest stay idle', async () => {
    const erpCompanyId = await insertCompany('Partial Failure Co')
    const adapter = adapterWithFailingRegister(buildAdapter(), 'WSVc')

    const summary = await syncConnection(db, adapter, erpCompanyId)

    expect(summary.perRegister.WSVc?.error).toMatch(/simulated failure for WSVc/)
    expect(summary.perRegister.CUVc?.error).toBeUndefined()
    expect(summary.perRegister.DelAddrVc?.error).toBeUndefined()
    expect(summary.perRegister.SVOSerVc?.error).toBeUndefined()
    expect(summary.perRegister.SVOVc?.error).toBeUndefined()

    const states = await syncStateRows(erpCompanyId)
    const wsvcState = states.find((s) => s.register === 'WSVc')
    expect(wsvcState?.syncStatus).toBe('error')
    expect(wsvcState?.errorMessage).toMatch(/simulated failure for WSVc/)

    for (const register of ['CUVc', 'DelAddrVc', 'SVOSerVc', 'SVOVc']) {
      expect(states.find((s) => s.register === register)?.syncStatus).toBe('idle')
    }

    // WSVc's own failure must not have blocked registers earlier in the
    // sequence — orders (SVOVc, ingested before WSVc) are still present,
    // while worksheets (WSVc itself) never got written.
    const counts = await countsFor(erpCompanyId)
    expect(counts.orders).toBeGreaterThan(0)
    expect(counts.worksheets).toBe(0)
  })

  it('throws for an unknown erpCompanyId', async () => {
    const adapter = buildAdapter()
    await expect(syncConnection(db, adapter, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /unknown erpCompanyId/,
    )
  })
})
