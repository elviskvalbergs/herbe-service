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
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { encryptErpCredentials } from '@/lib/erp/credentials'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { ingestServiceItems } from '@/lib/sync/ingest/service-items'
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
})
