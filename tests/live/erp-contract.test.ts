// tests/live/erp-contract.test.ts
//
// Gated live-ERP contract test: proves the production inbound pipe
// (buildAdapterForConnection) end-to-end against the dedicated test ERP.
// Skipped entirely unless RUN_LIVE_ERP_TESTS is set — never runs in the
// default `pnpm test` suite and never blocks a PR. See docs/15-testing-strategy.md.
//
// Run it with `pnpm test:live` after dropping a worktree-local `.env.vars`
// (git-ignored) at the repo root with the five vars documented in
// `.env.test.example`.
//
// Assertions here check shape/counts only — row contents are never logged,
// and no credential value is ever printed.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, inArray } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { encryptErpCredentials } from '@/lib/erp/credentials'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { ingestCustomers } from '@/lib/sync/ingest/customers'
import { ingestServiceItems } from '@/lib/sync/ingest/service-items'
import { ingestServiceOrders } from '@/lib/sync/ingest/service-orders'
import { ingestWorksheets } from '@/lib/sync/ingest/worksheets'
import { syncConnection } from '@/lib/sync/sync-connection'
import type { ErpAdapter } from '@herbe/erp-core'

// Tiny inline KEY=VALUE loader for the worktree-local .env.vars, instead of
// pulling in a dotenv dependency for a five-line file: read the file, skip
// blank/comment lines, split each line on the first `=`, and only fill in
// vars the environment doesn't already set. Runs at import time so
// RUN_LIVE_ERP_TESTS itself (also sourced from .env.vars) is available
// before describe.skipIf below decides whether to run this suite at all.
function loadEnvVarsFile(filePath: string): void {
  if (!existsSync(filePath)) return
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue
    const key = line.slice(0, eqIndex).trim()
    if (!key) continue
    const value = line.slice(eqIndex + 1).trim()
    process.env[key] ??= value
  }
}

loadEnvVarsFile(path.resolve(process.cwd(), '.env.vars'))

describe.skipIf(!process.env.RUN_LIVE_ERP_TESTS)('live ERP contract', () => {
  let testDb: TestDatabase
  let sql: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle<typeof schema>>
  let adapter: ErpAdapter
  let companyId: string

  beforeAll(async () => {
    // Encryption round-trips locally regardless of which key is used, so a
    // throwaway key is fine here — it never has to match a value the real
    // ERP or another environment relies on.
    process.env.MASTER_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4)

    testDb = await createTestDatabase()
    await runMigrations(testDb.url)
    sql = postgres(testDb.url)
    db = drizzle(sql, { schema })

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'live-erp-contract', name: 'Live ERP Contract' })
      .returning()
    const [company] = await db
      .insert(schema.erpCompanies)
      .values({
        tenantId: tenant.id,
        displayName: 'Live ERP Contract Co',
        adapterType: 'standard_books',
        adapterConfigJson: {
          baseUrl: process.env.ERP_DEMO_BASE_URL ?? process.env.ERP_BASE_URL,
          companyNumber:
            process.env.ERP_DEMO_COMPANY ?? process.env.ERP_COMPANY_NUMBER,
        },
        apiCredsEncrypted: encryptErpCredentials({
          username: process.env.ERP_DEMO_USER ?? process.env.ERP_USER,
          password: process.env.ERP_DEMO_PASSWORD ?? process.env.ERP_PASSWORD,
        }).toString('base64'),
      })
      .returning()

    companyId = company.id
    // Exercises the full production path: stored row -> decrypt -> adapter.
    adapter = await buildAdapterForConnection(db, company.id)
  }, 60_000)

  afterAll(async () => {
    await sql?.end({ timeout: 5 })
    await testDb?.cleanup()
  })

  it('pulls CUVc changes with the expected ChangeSet shape', async () => {
    const result = await adapter.pullChanges('CUVc', '0')
    expect(Array.isArray(result.upserts)).toBe(true)
    expect(typeof result.cursor).toBe('string')
  })

  it('pulls DelAddrVc changes (delta-capable base register)', async () => {
    const result = await adapter.pullChanges('DelAddrVc', '0')
    expect(Array.isArray(result.upserts)).toBe(true)
    expect(typeof result.cursor).toBe('string')
  })

  it('confirms SVOVc has no updates_after support live', async () => {
    expect(await adapter.probeIncrementalSupport('SVOVc')).toBe(false)
  })

  it('confirms WSVc has no updates_after support live', async () => {
    expect(await adapter.probeIncrementalSupport('WSVc')).toBe(false)
  })

  it('reports the standard_books capability flags', async () => {
    expect(adapter.capabilities()).toEqual({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    })
  })

  it('pulls SVOSerVc as a full no-delta list and ingests it end-to-end into service_items', async () => {
    const rows = await adapter.pullFullList('SVOSerVc')
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    // Never log row contents (SVOSerVc carries client names + serials) — only
    // the count, which is safe shape/size information.
    console.log(`live SVOSerVc pullFullList: ${rows.length} rows`)

    await ingestServiceItems(db, companyId, { upserts: rows, deletedRefs: [], cursor: '0' })

    const ingested = await db.select().from(schema.serviceItems).where(eq(schema.serviceItems.erpCompanyId, companyId))
    console.log(`live SVOSerVc ingest: ${ingested.length} service_items rows`)
    expect(ingested.length).toBeGreaterThanOrEqual(1)

    const units = ingested.filter((row) => row.kind === 'unit' && !!row.serialNr)
    expect(units.length).toBeGreaterThanOrEqual(1)
  })

  it('listLiveRefs(SVOSerVc) returns exactly one ref per row pulled by pullFullList', async () => {
    const rows = await adapter.pullFullList('SVOSerVc')
    const refs = await adapter.listLiveRefs('SVOSerVc')
    expect(refs.length).toBe(rows.length)
  })

  // Runs last: ingests customers, then service items, then orders — the
  // dependency order service_orders needs (customerId is NOT NULL; line
  // serviceItemId resolution looks up service_items by serial).
  it('pulls SVOVc and ingests orders + line rows end-to-end into service_orders/service_order_rows', async () => {
    const custs = await adapter.pullFullList('CUVc')
    await ingestCustomers(db, companyId, { upserts: custs, deletedRefs: [], cursor: '0' })

    const units = await adapter.pullFullList('SVOSerVc')
    await ingestServiceItems(db, companyId, { upserts: units, deletedRefs: [], cursor: '0' })

    const orders = await adapter.pullFullList('SVOVc')
    const result = await ingestServiceOrders(db, companyId, { upserts: orders, deletedRefs: [], cursor: '0' })

    // Never log row contents — counts only, same discipline as the other tests here.
    console.log(`live SVOVc: pulled ${orders.length}, ingested ${result.ingested}, skipped ${result.skipped}`)

    // If this is 0 with a high skipped count, CustCodes didn't resolve to
    // ingested customers — a real finding, not something to relax the
    // assertion around.
    expect(result.ingested).toBeGreaterThanOrEqual(1)

    const ingestedOrders = await db
      .select()
      .from(schema.serviceOrders)
      .where(eq(schema.serviceOrders.erpCompanyId, companyId))
    const orderIds = ingestedOrders.map((o) => o.id)

    const lineRows = orderIds.length
      ? await db.select().from(schema.serviceOrderRows).where(inArray(schema.serviceOrderRows.orderId, orderIds))
      : []

    console.log(
      `live SVOVc ingest: ${ingestedOrders.length} service_orders rows, ${lineRows.length} service_order_rows rows`,
    )
    expect(lineRows.length).toBeGreaterThanOrEqual(1)

    const refs = await db
      .select()
      .from(schema.erpRefs)
      .where(
        and(
          eq(schema.erpRefs.erpCompanyId, companyId),
          eq(schema.erpRefs.entityType, 'service_order'),
          eq(schema.erpRefs.purpose, 'primary'),
          eq(schema.erpRefs.register, 'SVOVc'),
        ),
      )
    expect(refs.length).toBeGreaterThanOrEqual(1)

    // Soft: depends on serial overlap between SVOSerVc and SVOVc lines in
    // the demo data, so logged only, never asserted on.
    const resolvedItemCount = lineRows.filter((r) => !!r.serviceItemId).length
    console.log(`live SVOVc lines: ${resolvedItemCount}/${lineRows.length} rows resolved a serviceItemId`)
  })

  // Runs last: worksheets need orders present first (orderId is NOT NULL,
  // resolved via SVONr against the order's own primary/SVOVc erp_ref). Not
  // dependent on the previous test having run — re-runs the full
  // customers -> service items -> orders chain itself (all ingests are
  // idempotent) so this test is self-contained about ordering.
  it('pulls WSVc and ingests worksheets + line rows end-to-end into worksheets/worksheet_rows', async () => {
    const custs = await adapter.pullFullList('CUVc')
    await ingestCustomers(db, companyId, { upserts: custs, deletedRefs: [], cursor: '0' })

    const units = await adapter.pullFullList('SVOSerVc')
    await ingestServiceItems(db, companyId, { upserts: units, deletedRefs: [], cursor: '0' })

    const orders = await adapter.pullFullList('SVOVc')
    await ingestServiceOrders(db, companyId, { upserts: orders, deletedRefs: [], cursor: '0' })

    const ws = await adapter.pullFullList('WSVc')
    const result = await ingestWorksheets(db, companyId, { upserts: ws, deletedRefs: [], cursor: '0' })

    // Never log row contents — counts only, same discipline as the other tests here.
    console.log(`live WSVc: pulled ${ws.length}, ingested ${result.ingested}, skipped ${result.skipped}`)

    // If this is 0 with a high skipped count, SVONr didn't resolve to
    // ingested orders — a real finding, not something to relax the
    // assertion around.
    expect(result.ingested).toBeGreaterThanOrEqual(1)

    const ingestedOrders = await db
      .select({ id: schema.serviceOrders.id })
      .from(schema.serviceOrders)
      .where(eq(schema.serviceOrders.erpCompanyId, companyId))
    const orderIds = ingestedOrders.map((o) => o.id)

    const ingestedWorksheets = orderIds.length
      ? await db.select().from(schema.worksheets).where(inArray(schema.worksheets.orderId, orderIds))
      : []
    const worksheetIds = ingestedWorksheets.map((w) => w.id)

    const worksheetLineRows = worksheetIds.length
      ? await db.select().from(schema.worksheetRows).where(inArray(schema.worksheetRows.worksheetId, worksheetIds))
      : []

    console.log(
      `live WSVc ingest: ${ingestedWorksheets.length} worksheets rows, ${worksheetLineRows.length} worksheet_rows rows`,
    )
    expect(ingestedWorksheets.length).toBeGreaterThanOrEqual(1)

    const refs = await db
      .select()
      .from(schema.erpRefs)
      .where(
        and(
          eq(schema.erpRefs.erpCompanyId, companyId),
          eq(schema.erpRefs.entityType, 'worksheet'),
          eq(schema.erpRefs.purpose, 'primary'),
          eq(schema.erpRefs.register, 'WSVc'),
        ),
      )
    expect(refs.length).toBeGreaterThanOrEqual(1)

    // Soft: depends on serial overlap between SVOSerVc and WSVc lines in
    // the demo data, so logged only, never asserted on.
    const resolvedItemCount = worksheetLineRows.filter((r) => !!r.serviceItemId).length
    console.log(`live WSVc lines: ${resolvedItemCount}/${worksheetLineRows.length} rows resolved a serviceItemId`)
  })

  // Runs last: proves the actual production entrypoint — syncConnection
  // driving every register for one connection in one call — end-to-end
  // against the real ERP, not just the individual ingest functions exercised
  // above. Reuses the suite's adapter/companyId built via
  // buildAdapterForConnection in beforeAll.
  it('runs syncConnection end-to-end against the real ERP and populates every register', async () => {
    const summary = await syncConnection(db, adapter, companyId)

    // Counts/shape only — never log row contents.
    for (const [register, regSummary] of Object.entries(summary.perRegister)) {
      console.log(`live syncConnection ${register}: ${JSON.stringify(regSummary)}`)
      expect(regSummary.error).toBeUndefined()
    }

    const [orders, items, worksheetRows, custs] = await Promise.all([
      db.select().from(schema.serviceOrders).where(eq(schema.serviceOrders.erpCompanyId, companyId)),
      db.select().from(schema.serviceItems).where(eq(schema.serviceItems.erpCompanyId, companyId)),
      db.select().from(schema.worksheets).where(eq(schema.worksheets.erpCompanyId, companyId)),
      db.select().from(schema.customers).where(eq(schema.customers.erpCompanyId, companyId)),
    ])

    console.log(
      `live syncConnection counts: service_orders=${orders.length}, service_items=${items.length}, worksheets=${worksheetRows.length}, customers=${custs.length}`,
    )
    expect(orders.length).toBeGreaterThan(0)
    expect(items.length).toBeGreaterThan(0)
    expect(worksheetRows.length).toBeGreaterThan(0)
    expect(custs.length).toBeGreaterThan(0)

    const states = await db.select().from(schema.erpSyncState).where(eq(schema.erpSyncState.erpCompanyId, companyId))
    expect(states.length).toBe(Object.keys(summary.perRegister).length)
    for (const state of states) {
      expect(state.syncStatus).toBe('idle')
    }

    // Soft observation only: real demo DelAddrCode<->DelCode overlap is
    // data-dependent, and lib/sync/sync-connection.test.ts (fake ERP) already
    // proves the DelAddrVc -> SVOVc siteName resolution mechanism itself. Do
    // NOT hard-fail here if this is 0.
    const withSiteName = orders.filter((o) => !!o.siteName).length
    console.log(`live syncConnection: ${withSiteName}/${orders.length} service_orders have a resolved siteName`)
  })
})
