// lib/offline/db.spike.test.ts
//
// ADR 0002 spike evidence: proves Dexie's bulkPut is not a limiting factor
// for the offline delta-pull workload (customers today; items/orders in
// Phase 1), which is the concrete question that motivated comparing Dexie
// against RxDB. Not production logic — kept as a small regression guard per
// the ADR (delete only if this ever proves flaky).
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { OfflineDb } from './db'

describe('Dexie spike: bulk upsert performance', () => {
  it('bulk-upserts 1000 customer records well within the offline-pull budget', async () => {
    const db = new OfflineDb()
    const records = Array.from({ length: 1000 }, (_, i) => ({
      id: `c${i}`,
      erpRef: `CUST${i}`,
      name: `Customer ${i}`,
      changeSeq: String(i),
    }))

    const start = performance.now()
    await db.customers.bulkPut(records)
    const elapsedMs = performance.now() - start

    expect(await db.customers.count()).toBe(1000)
    expect(elapsedMs).toBeLessThan(2000) // generous CI-safe ceiling
    await db.delete()
  })
})
