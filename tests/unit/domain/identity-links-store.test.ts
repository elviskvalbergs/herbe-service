// tests/unit/domain/identity-links-store.test.ts
//
// Task 3 (docs/superpowers/sdd/task-3-brief.md): DB-backed tests for
// listLinkedTechnicians — the technician/team_lead x identity_links join
// the booking route (Task 4) uses to offer only technicians who can
// eventually reach worksheet approval (approveWorksheet requires an
// identity_links entry — lib/sync/push/enqueue.ts:69-74). Uses the
// local-Postgres test harness (lib/test-support/db.ts), same bootstrap as
// tests/unit/domain/orders-worksheets-store.test.ts.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { listLinkedTechnicians } from '@/lib/domain/stores/identity-links'

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

  const [tenant] = await db.insert(schema.tenants).values({ slug: 'ils-t1', name: 'ILS T1' }).returning()
  tenantId = tenant.id

  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'ILS Co', adapterType: 'standard_books' })
    .returning()
  erpCompanyId = company.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('listLinkedTechnicians', () => {
  it('returns only technician/team_lead users with an erp identity link for the given company', async () => {
    const [tech] = await db.insert(schema.users).values({ tenantId, email: 'tech1@example.com', role: 'technician' }).returning()
    const [lead] = await db.insert(schema.users).values({ tenantId, email: 'lead1@example.com', role: 'team_lead' }).returning()
    const [dispatcher] = await db.insert(schema.users).values({ tenantId, email: 'dispatcher1@example.com', role: 'dispatcher' }).returning()
    const [unlinkedTech] = await db.insert(schema.users).values({ tenantId, email: 'unlinked1@example.com', role: 'technician' }).returning()

    await db.insert(schema.identityLinks).values({ tenantId, userId: tech.id, provider: 'erp', erpCompanyId, externalId: 'EM-TECH-1', linkedBy: 'test' })
    await db.insert(schema.identityLinks).values({ tenantId, userId: lead.id, provider: 'erp', erpCompanyId, externalId: 'EM-LEAD-1', linkedBy: 'test' })
    await db.insert(schema.identityLinks).values({ tenantId, userId: dispatcher.id, provider: 'erp', erpCompanyId, externalId: 'EM-DISP-1', linkedBy: 'test' })
    // unlinkedTech deliberately has no identity_links row

    const rows = await listLinkedTechnicians(db, tenantId, erpCompanyId)
    const ids = rows.map((r) => r.id)
    expect(ids.sort()).toEqual([tech.id, lead.id].sort())
    expect(ids).not.toContain(dispatcher.id)
    expect(ids).not.toContain(unlinkedTech.id)
  })

  it('excludes links scoped to a different erp company', async () => {
    const [otherCompany] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId, displayName: 'ILS Other Co', adapterType: 'standard_books' })
      .returning()
    const [tech] = await db.insert(schema.users).values({ tenantId, email: 'tech2@example.com', role: 'technician' }).returning()
    await db.insert(schema.identityLinks).values({ tenantId, userId: tech.id, provider: 'erp', erpCompanyId: otherCompany.id, externalId: 'EM-TECH-2', linkedBy: 'test' })

    const rows = await listLinkedTechnicians(db, tenantId, erpCompanyId)
    expect(rows.map((r) => r.id)).not.toContain(tech.id)
  })

  it('excludes links for a different tenant', async () => {
    const [otherTenant] = await db.insert(schema.tenants).values({ slug: 'ils-t2', name: 'ILS T2' }).returning()
    const [otherTech] = await db.insert(schema.users).values({ tenantId: otherTenant.id, email: 'tech3@example.com', role: 'technician' }).returning()
    await db.insert(schema.identityLinks).values({ tenantId: otherTenant.id, userId: otherTech.id, provider: 'erp', erpCompanyId, externalId: 'EM-TECH-3', linkedBy: 'test' })

    const rows = await listLinkedTechnicians(db, tenantId, erpCompanyId)
    expect(rows.map((r) => r.id)).not.toContain(otherTech.id)
  })
})
