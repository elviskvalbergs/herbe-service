// lib/domain/stores/erp-refs.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), mirroring
// lib/sync/ingest/customers.test.ts. Focused on findEntityIdByErpRef — the
// reverse lookup that service_orders ingest (lib/sync/ingest/service-orders.ts)
// relies on since service_orders has no scalar erpRef column to onConflict
// against (docs/superpowers/plans/2026-07-15-service-phase1-svovc-orders.md).
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { findEntityIdByErpRef, putErpRef } from './erp-refs'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string
let otherErpCompanyId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
  const [otherCompany] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C2', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  otherErpCompanyId = otherCompany.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('findEntityIdByErpRef', () => {
  it('round-trips through putErpRef: finds the entityId for the (erpCompanyId, entityType, purpose, recordRef) it was put under', async () => {
    const entityId = crypto.randomUUID()
    await putErpRef(db, {
      tenantId,
      erpCompanyId,
      entityType: 'service_order',
      entityId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: 'SVO-1000',
    })

    const found = await findEntityIdByErpRef(db, {
      erpCompanyId,
      entityType: 'service_order',
      purpose: 'primary',
      recordRef: 'SVO-1000',
    })
    expect(found).toBe(entityId)
  })

  it('returns null when no ref matches', async () => {
    const found = await findEntityIdByErpRef(db, {
      erpCompanyId,
      entityType: 'service_order',
      purpose: 'primary',
      recordRef: 'SVO-DOES-NOT-EXIST',
    })
    expect(found).toBeNull()
  })

  it('does not match a ref recorded under a different purpose or entityType', async () => {
    const entityId = crypto.randomUUID()
    await putErpRef(db, {
      tenantId,
      erpCompanyId,
      entityType: 'service_order',
      entityId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: 'SVO-2000',
    })

    expect(
      await findEntityIdByErpRef(db, {
        erpCompanyId,
        entityType: 'service_order',
        purpose: 'orderShadow',
        recordRef: 'SVO-2000',
      }),
    ).toBeNull()

    expect(
      await findEntityIdByErpRef(db, {
        erpCompanyId,
        entityType: 'worksheet',
        purpose: 'primary',
        recordRef: 'SVO-2000',
      }),
    ).toBeNull()
  })

  it('does not match a ref recorded under a different erpCompanyId', async () => {
    const entityId = crypto.randomUUID()
    await putErpRef(db, {
      tenantId,
      erpCompanyId,
      entityType: 'service_order',
      entityId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: 'SVO-3000',
    })

    expect(
      await findEntityIdByErpRef(db, {
        erpCompanyId: otherErpCompanyId,
        entityType: 'service_order',
        purpose: 'primary',
        recordRef: 'SVO-3000',
      }),
    ).toBeNull()
  })
})
