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
import { randomUUID } from 'node:crypto'
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
import { insertServiceOrder, getServiceOrderById } from '@/lib/domain/stores/service-orders'
import { insertWorksheet, getWorksheetById, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { putErpRef, getErpRefs } from '@/lib/domain/stores/erp-refs'
import { enqueueOrderCreatePush, approveWorksheet } from '@/lib/sync/push/enqueue'
import { processPushQueue } from '@/lib/sync/push/engine'
import { getStepsForGroup } from '@/lib/sync/push/store'
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
  let tenantId: string

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
    tenantId = tenant.id
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

  // -------------------------------------------------------------------------
  // WS4 outbound slice, Task 7 (docs/superpowers/plans/2026-07-16-service-
  // phase1-erp-outbound.md): the LIVE proof of the push path. Runs after the
  // syncConnection test above, inside this same describe/beforeAll, so it
  // reuses the same db/adapter/companyId and the customers/service_items that
  // test just ingested from the real demo ERP. Every record this suite
  // creates is marked 'herbe-live-test' (order description / SVOVc
  // CustComplaint1) so it's identifiable and never collides with real demo
  // data — and nothing here ever sets OKFlag or modifies a record we didn't
  // create ourselves.
  //
  // Numbered T7.1-T7.5 for a deterministic narrative order. vitest runs
  // `it`s within one file sequentially by declaration order (no
  // `.concurrent` used anywhere in this suite), and each test here depends
  // on state (orderId/orderErpRef/etc.) a previous one left in the DB/ERP —
  // same dependency shape the syncConnection test above already relies on.
  describe('T7 — live push proof: SVOVc/WSVc create via saga, update, adoption, DoneMark guard', () => {
    let customerErpRef: string
    let orderId: string
    let orderErpRef: string
    let emCode: string

    it('T7.1 creates a live SVOVc via the saga from an ERP-ingested customer + service item', async () => {
      // Join through already-ingested REAL SVOVc orders (from the
      // syncConnection test above) rather than reading an arbitrary CUVc row
      // off `customers`: each such customer's CustCode is proven valid for
      // THIS exact register/field (a real SVOVc already references it),
      // which is a strictly stronger guarantee than "some row in the full
      // CUVc list" (CUVc may carry contact/vendor-type codes never valid as
      // a Service Order customer).
      const existingOrders = await db
        .select({ customerId: schema.serviceOrders.customerId })
        .from(schema.serviceOrders)
        .where(eq(schema.serviceOrders.erpCompanyId, companyId))
      expect(existingOrders.length, 'ERP-ingested service orders must exist from the syncConnection test above').toBeGreaterThan(0)
      // Some demo customers carry an ERP-side data issue unrelated to our
      // payload (found live: SVOVc's own Objects-derivation-from-customer
      // business rule rejects a customer whose Objects tag collides on
      // type) — bounded retry across a few distinct real customers so the
      // test proves the saga/mechanics against whichever one is clean,
      // without weakening any assertion once a candidate succeeds.
      const candidateCustomerIds = [...new Set(existingOrders.map((o) => o.customerId))].slice(0, 5)

      const items = await db.select().from(schema.serviceItems).where(eq(schema.serviceItems.erpCompanyId, companyId))
      const item = items.find((row) => {
        const attrs = (row.attributes ?? {}) as Record<string, unknown>
        return !!row.serialNr && typeof attrs.itemCode === 'string' && attrs.itemCode.length > 0
      })
      expect(
        item,
        'an ERP-ingested service item with both serialNr and attributes.itemCode must exist',
      ).toBeTruthy()

      let attempts = 0
      let lastErrorMessage = ''
      for (const candidateCustomerId of candidateCustomerIds) {
        attempts++
        const [customer] = await db
          .select({ id: schema.customers.id, erpRef: schema.customers.erpRef })
          .from(schema.customers)
          .where(eq(schema.customers.id, candidateCustomerId))
        if (!customer) continue

        const order = await insertServiceOrder(db, {
          tenantId,
          erpCompanyId: companyId,
          customerId: customer.id,
          description: `herbe-live-test WS4 ${new Date().toISOString()}`,
        })
        await db.insert(schema.serviceOrderRows).values({ orderId: order.id, serviceItemId: item!.id, chargeType: 'invoiceable' })

        const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId: companyId, orderId: order.id })
        await processPushQueue(db, adapter, companyId)
        const [step] = await getStepsForGroup(db, groupId)

        if (step.status === 'succeeded') {
          orderId = order.id
          orderErpRef = step.erpRef!
          customerErpRef = customer.erpRef
          break
        }
        lastErrorMessage = step.errorMessage ?? ''
      }

      console.log(`live SVOVc create: tried ${attempts} candidate customer(s), succeeded: ${!!orderErpRef}`)
      expect(
        orderErpRef,
        `all ${attempts} candidate customers failed to create a live SVOVc — last error: ${lastErrorMessage}`,
      ).toBeTruthy()
      expect(orderErpRef).toMatch(/^\d+$/)
      console.log(`live SVOVc create: SerNr=${orderErpRef}`)

      const refs = await getErpRefs(db, tenantId, 'service_order', orderId)
      expect(refs).toHaveLength(1)
      expect(refs[0]).toMatchObject({ purpose: 'primary', register: 'SVOVc', recordRef: orderErpRef })

      const persistedOrder = await getServiceOrderById(db, tenantId, orderId)
      expect(persistedOrder!.orderNumber).toBe(orderErpRef)

      const rows = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderErpRef })
      expect(rows).toHaveLength(1)
      expect(String(rows[0].CustCode)).toBe(customerErpRef)
      expect(String(rows[0].CustComplaint1 ?? '')).toMatch(/^herbe-live-test/)
      console.log(
        'live SVOVc read-back: record count=1, CustCode matches ingested customer: true, marker present in CustComplaint1: true',
      )
    }, 60_000)

    it('T7.2 pushUpdate on the record we just created round-trips CustComplaint2', async () => {
      expect(orderErpRef, 'T7.1 must have run first and set orderErpRef').toBeTruthy()

      await adapter.pushUpdate('SVOVc', orderErpRef, { CustComplaint2: 'herbe-live-test update' })

      const rows = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderErpRef })
      expect(rows).toHaveLength(1)
      expect(String(rows[0].CustComplaint2 ?? '')).toBe('herbe-live-test update')
      console.log('live pushUpdate: record count=1, CustComplaint2 round-trip matches our marker: true')
    }, 30_000)

    it("T7.3 creates a live WSVc via approveWorksheet + the saga on the order's own service order", async () => {
      expect(orderId, 'T7.1 must have run first and set orderId').toBeTruthy()

      // EMCode: taken from an existing demo WSVc (never logged — it's a real
      // ERP person code, i.e. user data).
      const existingWsRows = await adapter.fetchRecords('WSVc', {})
      const emCodeSource = existingWsRows.find((r) => typeof r.EMCode === 'string' && r.EMCode)
      expect(emCodeSource, 'an existing demo WSVc with a non-empty EMCode must exist').toBeTruthy()
      emCode = String(emCodeSource!.EMCode)
      console.log('live WSVc EMCode source: found an existing demo WSVc with a non-empty EMCode: true')

      // Location chain (docs/04-erp-sync.md): MainStockBlock read first (the
      // engine's own fallback, left wired up by leaving push.mainServiceLocation
      // unset); else fall back to an existing demo WSVc's Location field, set
      // as the connection's push.mainServiceLocation setting; else BLOCKED.
      const mainStockRows = await adapter.fetchRecords('MainStockBlock', {})
      const mainStock = (mainStockRows[0] as Record<string, unknown> | undefined)?.MainStock
      const mainStockUsable = mainStockRows.length > 0 && mainStock != null && String(mainStock) !== ''
      let locationBlocked = false
      if (mainStockUsable) {
        console.log('live WSVc location resolution: MainStockBlock readable with a MainStock value: true — using the engine fallback')
      } else {
        const wsLocationSource = existingWsRows.find((r) => typeof r.Location === 'string' && r.Location)
        if (wsLocationSource) {
          const [companyRow] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, companyId))
          const existingConfig = (companyRow.adapterConfigJson ?? {}) as Record<string, unknown>
          await db
            .update(schema.erpCompanies)
            .set({ adapterConfigJson: { ...existingConfig, push: { mainServiceLocation: String(wsLocationSource.Location) } } })
            .where(eq(schema.erpCompanies.id, companyId))
          console.log(
            'live WSVc location resolution: MainStockBlock empty/unusable, found an existing demo WSVc.Location: true — set as push.mainServiceLocation',
          )
        } else {
          locationBlocked = true
          console.log(
            `BLOCKED T7.3: MainStockBlock rows=${mainStockRows.length} (no usable MainStock) and no existing WSVc has a non-empty Location — cannot resolve a service location for the WSVc create`,
          )
        }
      }
      expect(locationBlocked, 'a service location must be resolvable (MainStockBlock or an existing WSVc.Location) — see BLOCKED log above').toBe(false)

      const items = await db.select().from(schema.serviceItems).where(eq(schema.serviceItems.erpCompanyId, companyId))
      const wsItem = items.find((row) => {
        const attrs = (row.attributes ?? {}) as Record<string, unknown>
        return typeof attrs.itemCode === 'string' && attrs.itemCode.length > 0
      })
      expect(wsItem, 'an ERP-ingested service item with attributes.itemCode must exist for the worksheet row').toBeTruthy()

      const [techUser] = await db
        .insert(schema.users)
        .values({ tenantId, email: `herbe-live-test-tech-${randomUUID()}@example.invalid` })
        .returning()
      await putErpRef(db, {
        tenantId,
        entityType: 'user',
        entityId: techUser.id,
        purpose: 'primary',
        register: 'UserVc',
        recordRef: emCode,
        erpCompanyId: companyId,
      })

      const worksheet = await insertWorksheet(db, {
        tenantId,
        erpCompanyId: companyId,
        orderId,
        technicianUserId: techUser.id,
      })
      const worksheetId = worksheet.id
      await setWorksheetStatus(db, tenantId, worksheetId, 'Done')
      await db.insert(schema.worksheetRows).values({
        worksheetId,
        serviceItemId: wsItem!.id,
        description: 'herbe-live-test WS4 worksheet row',
        quantity: '1',
        chargeType: 'invoiceable',
      })

      const { groupId } = await approveWorksheet(db, { tenantId, erpCompanyId: companyId, worksheetId })

      // The order already has a primary SVOVc ref (from T7.1) — the group
      // must contain ONLY the worksheet step, no order-create step.
      const stepsBeforeRun = await getStepsForGroup(db, groupId)
      expect(stepsBeforeRun).toHaveLength(1)
      expect(stepsBeforeRun[0].entityType).toBe('worksheet')

      const summary = await processPushQueue(db, adapter, companyId)
      expect(summary).toMatchObject({ groupsSucceeded: 1, stepsSucceeded: 1, stepsDead: 0 })

      const [step] = await getStepsForGroup(db, groupId)
      expect(step.status).toBe('succeeded')
      expect(step.erpRef).toMatch(/^\d+$/)
      const wsErpRef = step.erpRef!
      console.log(`live WSVc create: SerNr=${wsErpRef}`)

      const afterWs = await getWorksheetById(db, tenantId, worksheetId)
      expect(afterWs!.status).toBe('Synced')

      const wsRefs = await getErpRefs(db, tenantId, 'worksheet', worksheetId)
      expect(wsRefs).toHaveLength(1)
      expect(wsRefs[0]).toMatchObject({ purpose: 'primary', register: 'WSVc', recordRef: wsErpRef })

      const readBack = await adapter.fetchRecords('WSVc', { 'filter.SerNr': wsErpRef })
      expect(readBack).toHaveLength(1)
      const wsRecord = readBack[0]
      expect(String(wsRecord.SVONr)).toBe(orderErpRef)

      // WONr is posted as -1 (the "no Work Order" sentinel) but reads back
      // BLANK over REST, not literally "-1" — matches docs/19-demo-probe-
      // results.md §10's "real production rows read the value back blank"
      // finding, now reconfirmed live for our own created record.
      const wonrReadsBackBlank = wsRecord.WONr === '' || wsRecord.WONr === null || wsRecord.WONr === undefined
      expect(wonrReadsBackBlank).toBe(true)
      console.log(
        `live WSVc read-back: record count=1, SVONr matches order erpRef: true, WONr reads back blank (matches docs/19): ${wonrReadsBackBlank}`,
      )

      const wsRowsArray = Array.isArray(wsRecord.rows) ? (wsRecord.rows as Record<string, unknown>[]) : []
      expect(wsRowsArray).toHaveLength(1)

      const presence = (rec: Record<string, unknown>) => ({
        Sum1: rec.Sum1 !== undefined,
        Sum3: rec.Sum3 !== undefined,
        Sum4: rec.Sum4 !== undefined,
        VATCode: rec.VATCode !== undefined,
        Price: rec.Price !== undefined,
      })
      console.log(`live WSVc header totals/VAT field presence: ${JSON.stringify(presence(wsRecord))}`)
      console.log(`live WSVc row totals/VAT field presence: ${JSON.stringify(presence(wsRowsArray[0] ?? {}))}`)
    }, 30_000)

    it('T7.4 refuses a Work Sheet for a live DoneMark=1 SVOVc (worksheet step goes dead, no ERP write)', async () => {
      expect(emCode, 'T7.3 must have run first and set emCode').toBeTruthy()

      let doneRecord = (await adapter.fetchRecords('SVOVc', { 'filter.DoneMark': '1' }))[0] as
        | Record<string, unknown>
        | undefined
      if (!doneRecord) {
        // filter.DoneMark may not support this boolean-ish field as an exact
        // string match on this install — fall back to a full scan.
        const allRows = await adapter.pullFullList('SVOVc')
        doneRecord = allRows.find((r) => r.DoneMark === 1 || r.DoneMark === '1')
      }
      expect(
        doneRecord,
        'a DoneMark=1 (Closed) SVOVc must exist on the demo ERP — docs/19 confirms Closed orders were ingested',
      ).toBeTruthy()
      const doneSerNr = String(doneRecord!.SerNr)
      console.log('live DoneMark=1 SVOVc found for guard test: true')

      const [customer] = await db
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(eq(schema.customers.erpCompanyId, companyId))
        .limit(1)

      const fabricatedOrder = await insertServiceOrder(db, {
        tenantId,
        erpCompanyId: companyId,
        customerId: customer!.id,
        description: `herbe-live-test WS4 DoneMark-guard ${new Date().toISOString()}`,
      })
      await putErpRef(db, {
        tenantId,
        entityType: 'service_order',
        entityId: fabricatedOrder.id,
        purpose: 'primary',
        register: 'SVOVc',
        recordRef: doneSerNr,
        erpCompanyId: companyId,
      })

      const [techUser] = await db
        .insert(schema.users)
        .values({ tenantId, email: `herbe-live-test-tech-donemark-${randomUUID()}@example.invalid` })
        .returning()
      await putErpRef(db, {
        tenantId,
        entityType: 'user',
        entityId: techUser.id,
        purpose: 'primary',
        register: 'UserVc',
        recordRef: emCode,
        erpCompanyId: companyId,
      })

      const fabricatedWorksheet = await insertWorksheet(db, {
        tenantId,
        erpCompanyId: companyId,
        orderId: fabricatedOrder.id,
        technicianUserId: techUser.id,
      })
      await setWorksheetStatus(db, tenantId, fabricatedWorksheet.id, 'Done')

      const { groupId } = await approveWorksheet(db, {
        tenantId,
        erpCompanyId: companyId,
        worksheetId: fabricatedWorksheet.id,
      })
      const summary = await processPushQueue(db, adapter, companyId)

      expect(summary).toMatchObject({ groupsDead: 1, stepsDead: 1, stepsSucceeded: 0 })

      const [step] = await getStepsForGroup(db, groupId)
      expect(step.status).toBe('dead')
      expect(step.errorMessage).toMatch(/already done/i)

      const afterWs = await getWorksheetById(db, tenantId, fabricatedWorksheet.id)
      expect(afterWs!.status).toBe('Approved') // never advances to Synced — no ERP write occurred

      const wsRefs = await getErpRefs(db, tenantId, 'worksheet', fabricatedWorksheet.id)
      expect(wsRefs).toHaveLength(0) // no WSVc erp_ref was ever written
      console.log('live DoneMark guard: worksheet step dead, worksheet stayed Approved, no WSVc erp_ref written: true')
    }, 30_000)

    it('T7.5 re-adopts the same SVOVc after the local erp_ref is lost (no duplicate create)', async () => {
      expect(orderErpRef, 'T7.1 must have run first and set orderErpRef').toBeTruthy()

      const beforeBySerNr = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderErpRef })
      expect(beforeBySerNr).toHaveLength(1)
      const beforeByCustomer = await adapter.fetchRecords('SVOVc', { 'filter.CustCode': customerErpRef })

      await db
        .delete(schema.erpRefs)
        .where(and(eq(schema.erpRefs.entityType, 'service_order'), eq(schema.erpRefs.entityId, orderId)))
      const refsAfterDelete = await getErpRefs(db, tenantId, 'service_order', orderId)
      expect(refsAfterDelete).toHaveLength(0)

      const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId: companyId, orderId })
      const summary = await processPushQueue(db, adapter, companyId)

      expect(summary).toMatchObject({ groupsSucceeded: 1, stepsSucceeded: 1, stepsDead: 0 })

      const [step] = await getStepsForGroup(db, groupId)
      expect(step.erpRef).toBe(orderErpRef) // adopted the SAME record, not a new one

      const refsAfterAdopt = await getErpRefs(db, tenantId, 'service_order', orderId)
      expect(refsAfterAdopt).toHaveLength(1)
      expect(refsAfterAdopt[0].recordRef).toBe(orderErpRef)

      const afterBySerNr = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderErpRef })
      expect(afterBySerNr).toHaveLength(1) // still exactly one — no duplicate created
      const afterByCustomer = await adapter.fetchRecords('SVOVc', { 'filter.CustCode': customerErpRef })
      expect(afterByCustomer).toHaveLength(beforeByCustomer.length) // no new record under this customer either

      console.log(
        `live natural-key adoption: erp_ref restored to the same SerNr: true, SerNr-count before/after=1/1, CustCode-count unchanged: true (${beforeByCustomer.length})`,
      )
    }, 30_000)
  })
})
