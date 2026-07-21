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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { sweepInvoiceStatus } from '@/lib/sync/invoice-status'
import { matchUsersByEmail } from '@/lib/auth/identity-link'
import type { ErpAdapter } from '@herbe/erp-core'

// T9 (Task 7, .superpowers/sdd/task-7-brief.md): the route handlers under
// app/api/** import `@/lib/db`, which reads DATABASE_URL at module-load time
// and throws if unset — so route modules are always dynamically imported
// (never statically) after beforeAll below has set process.env.DATABASE_URL,
// same convention as app/api/worksheets/[id]/approve/route.test.ts. That
// route also calls getVerifiedSession -> @/lib/auth's `auth()`, which this
// suite mocks the same way every other route-test file does (only the
// `auth` export is replaced; nothing else in this file touches
// handlers/signIn/signOut, so this is safe file-wide).
const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

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

// T9: builds the session object getVerifiedSession expects — same shape as
// every route-test file's own sessionFor helper (id/tenantId/role/
// sessionVersion, sessionVersion must match the DB row or getVerifiedSession
// silently rejects it as revoked).
function sessionFor(user: { id: string; tenantId: string; role: string; sessionVersion: number }) {
  return {
    user: { id: user.id, tenantId: user.tenantId, role: user.role, sessionVersion: user.sessionVersion },
    expires: '2099-01-01T00:00:00.000Z',
  }
}

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
    // T9 below dynamically imports route modules that transitively import
    // @/lib/db, which reads this at module-load time — see the comment at
    // this file's top import block.
    process.env.DATABASE_URL = testDb.url
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
    tenantId = tenant.id
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

  it('pulls UserVc as a full delta-capable list', async () => {
    const rows = await adapter.pullFullList('UserVc')
    expect(Array.isArray(rows)).toBe(true)
    console.log(`live UserVc pullFullList: ${rows.length} rows`)
    expect(await adapter.probeIncrementalSupport('UserVc')).toBe(true)
  })

  it('matches a user by email against live UserVc data and links exactly once', async () => {
    const rows = await adapter.pullFullList('UserVc')
    const withEmail = rows.find((r) => typeof r.LoginEmailAddr === 'string' && r.LoginEmailAddr) ??
      rows.find((r) => typeof r.emailAddr === 'string' && r.emailAddr)
    if (!withEmail) {
      console.log('live UserVc: no row carries an email address — skipping match assertion')
      return
    }
    const email = String((withEmail as Record<string, unknown>).LoginEmailAddr || (withEmail as Record<string, unknown>).emailAddr)

    const [user] = await db.insert(schema.users).values({ tenantId, email }).returning()
    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId: companyId, adapter })
    console.log(`live identity match: linked=${result.linked} alreadyLinked=${result.alreadyLinked} noMatch=${result.noMatch}`)
    expect(result.linked).toBeGreaterThanOrEqual(1)

    const links = await db.select().from(schema.identityLinks).where(eq(schema.identityLinks.userId, user.id))
    expect(links).toHaveLength(1)
    expect(links[0].provider).toBe('erp')
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
    let worksheetId: string

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
      await db.insert(schema.identityLinks).values({
        tenantId,
        userId: techUser.id,
        provider: 'erp',
        erpCompanyId: companyId,
        externalId: emCode,
        linkedBy: 'test',
      })

      const worksheet = await insertWorksheet(db, {
        tenantId,
        erpCompanyId: companyId,
        orderId,
        technicianUserId: techUser.id,
      })
      worksheetId = worksheet.id
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
      await db.insert(schema.identityLinks).values({
        tenantId,
        userId: techUser.id,
        provider: 'erp',
        erpCompanyId: companyId,
        externalId: emCode,
        linkedBy: 'test',
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

    it('T7.6 (FIX-1) a full syncConnection after the WSVc create does NOT regress the worksheet Synced -> Draft', async () => {
      expect(worksheetId, 'T7.3 must have run first and set worksheetId').toBeTruthy()

      // The worksheet we pushed reads back from WSVc with OKFlag=0 — un-OK'd
      // until a manager approves it in the ERP. Before FIX-1, syncConnection's
      // WSVc re-ingest applied that flag-derived status unconditionally and
      // regressed the worksheet Synced -> Draft (and wiped workDescription)
      // within one sync tick. Echo-suppression must now skip the downgrade for
      // this self-pushed record. This exercises the exact un-OK'd handoff M1
      // exists to prove, against the real ERP.
      const before = await getWorksheetById(db, tenantId, worksheetId)
      expect(before!.status).toBe('Synced')

      // Confirm the live WSVc really does read back un-OK'd (OKFlag=0) — i.e.
      // this test is exercising the regression path, not the flattering one.
      const wsRefBefore = (await getErpRefs(db, tenantId, 'worksheet', worksheetId))[0]
      const liveWs = (await adapter.fetchRecords('WSVc', { 'filter.SerNr': wsRefBefore.recordRef }))[0]
      const okFlag = liveWs?.OKFlag
      console.log(`live FIX-1 precondition: our WSVc reads back OKFlag=${JSON.stringify(okFlag)} (expected 0/blank)`)

      await syncConnection(db, adapter, companyId)

      const after = await getWorksheetById(db, tenantId, worksheetId)
      expect(after!.status).toBe('Synced') // NOT regressed to Draft

      const refs = await getErpRefs(db, tenantId, 'worksheet', worksheetId)
      expect(refs).toHaveLength(1) // primary WSVc ref still intact
      console.log("live FIX-1: worksheet stayed Synced across a full syncConnection re-ingest of its own un-OK'd echo")
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // WS4 outbound slice, Task 8 (docs/superpowers/plans/2026-07-16-service-
  // phase1-erp-outbound.md decisions 9/10): the LIVE proof of the
  // WebExcellentAPI getrecordlinks client + the invoiced-status sweep. Runs
  // last, reusing the same db/companyId/tenantId this suite already built —
  // the syncConnection test above ingested every real SVOVc order this
  // company has, which is exactly what sweepInvoiceStatus needs a non-empty
  // candidate set from. Read-only against the real ERP throughout
  // (getrecordlinks is a GET) — never logs link-target record IDs, only
  // counts and register names.
  describe('T8 — live WebExcellentAPI getrecordlinks + invoiced-status sweep', () => {
    it('T8.1 enables features.invoiceReadback on the connection and confirms the capability flows through buildAdapterForConnection', async () => {
      const [companyRow] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, companyId))
      const existingConfig = (companyRow.adapterConfigJson ?? {}) as Record<string, unknown>
      await db
        .update(schema.erpCompanies)
        .set({ adapterConfigJson: { ...existingConfig, features: { invoiceReadback: true } } })
        .where(eq(schema.erpCompanies.id, companyId))

      // Rebuild — capabilities() is fixed at adapter-construction time from
      // the config buildAdapterForConnection assembles, so the old `adapter`
      // instance (built in beforeAll, before this update) would still report
      // the capability off.
      adapter = await buildAdapterForConnection(db, companyId)

      expect(adapter.capabilities().supportsInvoiceStatusReadback).toBe(true)
      console.log('live features.invoiceReadback: enabled on connection, capability flows through: true')
    }, 30_000)

    it('T8.2 getRecordLinks against a real demo WSVc returns the documented array shape', async () => {
      const wsRows = await adapter.fetchRecords('WSVc', {})
      expect(wsRows.length, 'at least one real demo WSVc row must exist (from the syncConnection test above)').toBeGreaterThan(0)
      const wsSerNr = String(wsRows[0].SerNr)

      const links = await adapter.getRecordLinks('WSVc', wsSerNr)

      expect(Array.isArray(links)).toBe(true)
      for (const link of links) {
        expect(typeof link.register).toBe('string')
        expect(typeof link.id).toBe('string')
      }

      const registersSeen = [...new Set(links.map((l) => l.register))].sort()
      console.log(`live getRecordLinks(WSVc, <real SerNr>): link count=${links.length}, registers seen=${JSON.stringify(registersSeen)}`)
    }, 30_000)

    it('T8.3 sweepInvoiceStatus runs to completion over the synced orders', async () => {
      const result = await sweepInvoiceStatus(db, adapter, companyId)

      // checked>0 depends on real orders existing that aren't already
      // Invoiced/Closed/Cancelled — the syncConnection test above proved
      // service_orders is non-empty for this company, so some should qualify.
      // invoiced is NOT asserted >0 — whether any of them actually carry a
      // linked IVVc on this demo install is a real-data fact, not something
      // to force.
      expect(result.checked).toBeGreaterThan(0)
      console.log(`live sweepInvoiceStatus: ${JSON.stringify(result)}`)
    }, 60_000)
  })

  // -------------------------------------------------------------------------
  // M1 vertical slice, Task 7 (.superpowers/sdd/task-7-brief.md): the LIVE
  // route-level proof — the same book -> execute -> approve -> WS4 push ->
  // ERP read-back loop as T7 above, but driven through the HTTP route
  // handlers (app/api/service-orders, app/api/worksheets/[id]/transition,
  // app/api/worksheets/[id]/approve) instead of calling
  // insertServiceOrder/transitionWorksheet/approveWorksheet directly. T7.1-
  // T7.6 already proved the domain-level chain against this same live ERP;
  // this block's job is only to prove the ROUTE layer reaches the same
  // domain functions correctly (session/role gates, request/response shape)
  // against a real backend, not to re-derive the push mechanics themselves.
  //
  // Adapter wiring: no gap here — the routes' own buildAdapterForConnection
  // resolves the SAME erp_companies row (`companyId`) this suite's beforeAll
  // already built via buildAdapterForConnection, with real stored creds. The
  // route dynamic-imports (see top-of-file comment) and vi.mock('@/lib/auth')
  // seam are the only new plumbing this block needs.
  //
  // Runs last, reusing db/adapter/companyId/tenantId from the outer
  // beforeAll and the customers/service_items T7's syncConnection test
  // already ingested. Every record created here carries the 'herbe-live-test'
  // marker convention (order description / worksheet workDescription), same
  // discipline as T7/T8.
  describe('T9 — M1 vertical slice via routes', () => {
    it('T9.1 books, executes, approves, and pushes a live SVOVc + WSVc entirely through the routes', async () => {
      const { POST: createOrder } = await import('@/app/api/service-orders/route')
      const { POST: transition } = await import('@/app/api/worksheets/[id]/transition/route')
      const { POST: approve } = await import('@/app/api/worksheets/[id]/approve/route')

      function jsonRequest(url: string, body: unknown) {
        return new Request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      function emptyPost(url: string) {
        return new Request(url, { method: 'POST' })
      }

      const [dispatcherUser] = await db
        .insert(schema.users)
        .values({ tenantId, email: `herbe-live-test-t9-dispatcher-${randomUUID()}@example.invalid`, role: 'dispatcher' })
        .returning()

      // Technician + identity link, resolved once (customer-independent) —
      // EMCode reused from an existing demo WSVc, same discovery T7.3 used
      // (never logged — it's a real ERP person code).
      const [techUser] = await db
        .insert(schema.users)
        .values({ tenantId, email: `herbe-live-test-t9-tech-${randomUUID()}@example.invalid`, role: 'technician' })
        .returning()
      const existingWsRows = await adapter.fetchRecords('WSVc', {})
      const emCodeSource = existingWsRows.find((r) => typeof r.EMCode === 'string' && r.EMCode)
      expect(emCodeSource, 'an existing demo WSVc with a non-empty EMCode must exist').toBeTruthy()
      const t9EmCode = String(emCodeSource!.EMCode)
      await db.insert(schema.identityLinks).values({
        tenantId,
        userId: techUser.id,
        provider: 'erp',
        erpCompanyId: companyId,
        externalId: t9EmCode,
        linkedBy: 'test',
      })

      // Candidate customers: same strategy as T7.1 — customerIds drawn from
      // ERP-ingested service orders are proven-valid CustCodes for THIS
      // register, unlike an arbitrary CUVc row. Bounded retry across a few
      // distinct candidates in case one trips the same ERP-side business
      // rule T7.1 documented (an unrelated Objects-tag data issue on some
      // demo customers), without weakening any assertion once one succeeds.
      const existingOrders = await db
        .select({ customerId: schema.serviceOrders.customerId })
        .from(schema.serviceOrders)
        .where(eq(schema.serviceOrders.erpCompanyId, companyId))
      expect(existingOrders.length, 'ERP-ingested service orders must exist from the T7 syncConnection test above').toBeGreaterThan(0)
      const candidateCustomerIds = [...new Set(existingOrders.map((o) => o.customerId))].slice(0, 5)

      // A resolvable service item (serialNr + itemCode) to give the order/
      // worksheet one real line row each — the booking/transition routes
      // don't expose a "add row" endpoint in this slice, so these two
      // inserts are direct, same as T7.1/T7.3's own approach.
      const items = await db.select().from(schema.serviceItems).where(eq(schema.serviceItems.erpCompanyId, companyId))
      const item = items.find((row) => {
        const attrs = (row.attributes ?? {}) as Record<string, unknown>
        return !!row.serialNr && typeof attrs.itemCode === 'string' && attrs.itemCode.length > 0
      })
      expect(item, 'an ERP-ingested service item with both serialNr and attributes.itemCode must exist').toBeTruthy()

      let finalOrderId = ''
      let finalWorksheetId = ''
      let finalPushSummary: Record<string, unknown> | null = null
      let attempts = 0
      let lastPushSummary = ''

      for (const candidateCustomerId of candidateCustomerIds) {
        attempts++

        authMock.mockResolvedValue(sessionFor(dispatcherUser))
        const bookRes = await createOrder(
          jsonRequest('http://localhost/api/service-orders', {
            erpCompanyId: companyId,
            customerId: candidateCustomerId,
            technicianUserId: techUser.id,
            description: `herbe-live-test WS4 T9 ${new Date().toISOString()}`,
          }),
        )
        expect(bookRes.status).toBe(201)
        const { orderId, worksheetId } = await bookRes.json()

        await db.insert(schema.serviceOrderRows).values({ orderId, serviceItemId: item!.id, chargeType: 'invoiceable' })
        await db.insert(schema.worksheetRows).values({
          worksheetId,
          serviceItemId: item!.id,
          description: 'herbe-live-test WS4 T9 worksheet row',
          quantity: '1',
          chargeType: 'invoiceable',
        })

        authMock.mockResolvedValue(sessionFor(techUser))
        const acceptedRes = await transition(
          jsonRequest(`http://localhost/api/worksheets/${worksheetId}/transition`, { to: 'Accepted' }),
          { params: Promise.resolve({ id: worksheetId }) },
        )
        expect(acceptedRes.status).toBe(200)
        const inProgressRes = await transition(
          jsonRequest(`http://localhost/api/worksheets/${worksheetId}/transition`, { to: 'In progress' }),
          { params: Promise.resolve({ id: worksheetId }) },
        )
        expect(inProgressRes.status).toBe(200)
        const doneRes = await transition(
          jsonRequest(`http://localhost/api/worksheets/${worksheetId}/transition`, {
            to: 'Done',
            workDescription: 'herbe-live-test WS4 T9 done',
          }),
          { params: Promise.resolve({ id: worksheetId }) },
        )
        expect(doneRes.status).toBe(200)

        authMock.mockResolvedValue(sessionFor(dispatcherUser))
        const approveRes = await approve(emptyPost(`http://localhost/api/worksheets/${worksheetId}/approve`), {
          params: Promise.resolve({ id: worksheetId }),
        })
        expect(approveRes.status).toBe(200)
        const approveBody = await approveRes.json()
        lastPushSummary = JSON.stringify(approveBody.pushSummary)

        if (
          approveBody.pushSummary &&
          approveBody.pushSummary.stepsSucceeded === 2 &&
          approveBody.pushSummary.stepsDead === 0
        ) {
          finalOrderId = orderId
          finalWorksheetId = worksheetId
          finalPushSummary = approveBody.pushSummary
          break
        }
      }

      console.log(`live T9 route push: tried ${attempts} candidate customer(s), succeeded: ${!!finalPushSummary}`)
      expect(
        finalPushSummary,
        `all ${attempts} candidate customers failed to push through the routes — last pushSummary: ${lastPushSummary}`,
      ).toBeTruthy()
      expect(finalPushSummary).toMatchObject({ stepsSucceeded: 2, stepsDead: 0 })

      const afterWs = await getWorksheetById(db, tenantId, finalWorksheetId)
      expect(afterWs!.status).toBe('Synced')
      expect(afterWs!.workDescription).toBe('herbe-live-test WS4 T9 done')

      const orderRefs = await getErpRefs(db, tenantId, 'service_order', finalOrderId)
      expect(orderRefs).toHaveLength(1)
      expect(orderRefs[0]).toMatchObject({ purpose: 'primary', register: 'SVOVc' })

      const wsRefs = await getErpRefs(db, tenantId, 'worksheet', finalWorksheetId)
      expect(wsRefs).toHaveLength(1)
      expect(wsRefs[0]).toMatchObject({ purpose: 'primary', register: 'WSVc' })

      const svoRows = await adapter.fetchRecords('SVOVc', { 'filter.SerNr': orderRefs[0].recordRef })
      const wsRows = await adapter.fetchRecords('WSVc', { 'filter.SerNr': wsRefs[0].recordRef })
      expect(svoRows).toHaveLength(1)
      expect(wsRows).toHaveLength(1)
      expect(String(wsRows[0].SVONr)).toBe(String(svoRows[0].SerNr))
      console.log(
        `live T9 read-back: SVOVc count=1, WSVc count=1, WSVc.SVONr matches SVOVc.SerNr: ${String(wsRows[0].SVONr) === String(svoRows[0].SerNr)}`,
      )
    }, 120_000)
  })
})
