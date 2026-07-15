// lib/sync/ingest/service-items.test.ts
//
// DB-backed ingest test for the SVOSerVc register, mirroring
// customers.test.ts (local-Postgres harness, hand-built ChangeSet). SVOSerVc
// is a no-delta register keyed by SerialNr, so erpRef = SerialNr.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { ingestServiceItems } from './service-items'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string

// A ChangeSet of SVOSerVc rows exercising every resolution branch:
//  - SN-1000: top-level unit, CustCode resolves, warranty flags set (string '1')
//  - SN-1001: child unit, MotherNr -> SN-1000 (parent present), CustCode absent
//             (customerId null), warranty flags off (int 0 / string '0'),
//             secondarySerial falls back to AlternateDeviceID
//  - SN-1002: dangling MotherNr (parent not present -> parentId null),
//             warranty flags set via int 1
//  - '' :     empty SerialNr -> skipped entirely
function buildChangeSet() {
  return {
    upserts: [
      {
        SerialNr: 'SN-1000',
        ItemCode: 'AHU-500',
        ItemName: 'Air Handler 500',
        CustCode: 'CUST001',
        CustName: 'Test Client OÜ',
        WarrantyUntil: '2027-06-30',
        LaborCovered: '1',
        PartCovered: '1',
        SecondarySerialNr: 'SEC-1000',
        MotherNr: '',
        WarrantyStatus: 'InWarranty',
        CoverageStartDate: '2025-06-30',
        CoverageEndDate: '2027-06-30',
        ContractType: 'Gold',
        Contract: 'C-77',
        SoldDate: '2025-06-30',
      },
      {
        SerialNr: 'SN-1001',
        ItemCode: 'FAN-200',
        ItemName: 'Fan Module 200',
        CustCode: 'CUST999',
        CustName: 'Unknown Co',
        WarrantyUntil: '',
        LaborCovered: 0,
        PartCovered: '0',
        AlternateDeviceID: 'ALT-1001',
        MotherNr: 'SN-1000',
      },
      {
        SerialNr: 'SN-1002',
        ItemName: 'Orphan Unit',
        CustCode: 'CUST001',
        LaborCovered: 1,
        PartCovered: 1,
        MotherNr: 'SN-DOES-NOT-EXIST',
      },
      {
        SerialNr: '',
        ItemName: 'Skip me',
      },
    ] as Record<string, unknown>[],
    deletedRefs: [],
    cursor: '0',
  }
}

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

  // Only CUST001 exists — CUST999 is deliberately absent so customerId
  // resolution can be asserted null.
  await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST001', name: 'Test Client OÜ', changeSeq: BigInt(0) })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('ingestServiceItems', () => {
  it('upserts SVOSerVc rows keyed by SerialNr, skipping empty serials', async () => {
    await ingestServiceItems(db, erpCompanyId, buildChangeSet())

    const rows = await db
      .select()
      .from(schema.serviceItems)
      .where(eq(schema.serviceItems.erpCompanyId, erpCompanyId))
    expect(rows.length).toBe(3) // empty SerialNr skipped
    expect(rows.every((r) => r.kind === 'unit')).toBe(true)
    expect(rows.every((r) => r.path === '')).toBe(true)
    expect(rows.every((r) => r.modelId === null)).toBe(true) // modelId always null
  })

  it('maps serial, name, secondary serial and warranty flags', async () => {
    const [top] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1000')))
    expect(top.serialNr).toBe('SN-1000')
    expect(top.name).toBe('Air Handler 500')
    expect(top.secondarySerial).toBe('SEC-1000')
    expect(top.warrantyLaborCovered).toBe(true)
    expect(top.warrantyPartsCovered).toBe(true)
    expect(top.warrantyUntil).toBeInstanceOf(Date)
    expect(top.attributes).toMatchObject({
      itemCode: 'AHU-500',
      itemName: 'Air Handler 500',
      custName: 'Test Client OÜ',
      contractType: 'Gold',
    })

    const [child] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1001')))
    expect(child.secondarySerial).toBe('ALT-1001') // fallback to AlternateDeviceID
    expect(child.warrantyLaborCovered).toBe(false)
    expect(child.warrantyPartsCovered).toBe(false)
    expect(child.warrantyUntil).toBeNull()

    const [orphan] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1002')))
    expect(orphan.warrantyLaborCovered).toBe(true) // int 1
    expect(orphan.warrantyPartsCovered).toBe(true)
  })

  it('resolves customerId from CustCode, null when the customer is absent', async () => {
    const [seededCustomer] = await db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.erpCompanyId, erpCompanyId), eq(schema.customers.erpRef, 'CUST001')))

    const [top] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1000')))
    expect(top.customerId).toBe(seededCustomer.id)

    const [child] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1001')))
    expect(child.customerId).toBeNull() // CUST999 not seeded
  })

  it('resolves parentId from MotherNr when the parent serial is present, null when dangling', async () => {
    const [top] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1000')))
    const [child] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1001')))
    const [orphan] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1002')))

    expect(child.parentId).toBe(top.id) // MotherNr SN-1000 present
    expect(top.parentId).toBeNull() // no MotherNr
    expect(orphan.parentId).toBeNull() // dangling MotherNr tolerated
  })

  it('assigns a deterministic erp: labelId and a monotonic changeSeq', async () => {
    const [top] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1000')))
    expect(top.labelId).toBe(`erp:${erpCompanyId}:SN-1000`)
    expect(top.changeSeq).toBeGreaterThan(BigInt(0))
  })

  it('re-ingesting is idempotent: row count stable, labelId unchanged, changeSeq bumps', async () => {
    const before = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1000')))
    const beforeRow = before[0]

    await ingestServiceItems(db, erpCompanyId, buildChangeSet())

    const rows = await db
      .select()
      .from(schema.serviceItems)
      .where(eq(schema.serviceItems.erpCompanyId, erpCompanyId))
    expect(rows.length).toBe(3) // still 3, no duplicates

    const [after] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1000')))
    expect(after.labelId).toBe(beforeRow.labelId) // label never churns
    expect(after.changeSeq).toBeGreaterThan(beforeRow.changeSeq) // bumped again
    // parent link survives re-ingest
    const [child] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-1001')))
    expect(child.parentId).toBe(after.id)
  })

  it('tolerates a missing SerialNr, missing CustCode/ItemName, and an unparseable warranty date', async () => {
    await ingestServiceItems(db, erpCompanyId, {
      upserts: [
        { ItemName: 'No serial here' }, // SerialNr key absent (undefined) -> skipped
        {
          SerialNr: 'SN-EDGE-1',
          WarrantyUntil: 'not-a-date', // unparseable -> null
          MotherNr: '',
          // no ItemName -> name falls back to the serial; no CustCode -> customerId null
        },
      ] as Record<string, unknown>[],
      deletedRefs: [],
      cursor: '0',
    })

    const [edge] = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, 'SN-EDGE-1')))
    expect(edge.name).toBe('SN-EDGE-1') // ItemName absent -> serial
    expect(edge.customerId).toBeNull() // CustCode absent
    expect(edge.warrantyUntil).toBeNull() // 'not-a-date' unparseable
    // the SerialNr-less row must not have been inserted
    const noSerial = await db
      .select()
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.name, 'No serial here')))
    expect(noSerial.length).toBe(0)
  })

  it('throws for an unknown erpCompanyId', async () => {
    await expect(
      ingestServiceItems(db, '00000000-0000-0000-0000-000000000000', buildChangeSet()),
    ).rejects.toThrow(/unknown erpCompanyId/)
  })
})
