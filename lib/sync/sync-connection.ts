// lib/sync/sync-connection.ts
//
// The per-connection sync orchestrator: pulls every register for one
// erp_companies row, in dependency order (later registers resolve FKs
// against rows written by earlier ones), and persists erp_sync_state per
// register. Replaces the CUVc-only inline logic that used to live directly
// in app/api/cron/sync-tick/route.ts (that route is refactored separately
// to call this instead — not part of this change).
//
// Register sequence:
//   CUVc       (delta)    -> ingestCustomers      -> key-sweep customers
//   DelAddrVc  (delta)    -> buildDelAddrSiteMap (transient lookup, not ingested/stored)
//   SVOSerVc   (no-delta) -> ingestServiceItems   -> key-sweep service_items
//   SVOVc      (no-delta) -> ingestServiceOrders(..., { siteNameByDelCode })
//   WSVc       (no-delta) -> ingestWorksheets
//
// Each register is wrapped in its own try/catch: a register's failure
// records sync_state syncStatus='error' + errorMessage, is captured in the
// returned summary, and does NOT abort the remaining registers. Delta
// registers (CUVc, DelAddrVc) persist + reuse syncCursor across runs;
// no-delta registers always pull the full list but still stamp
// lastSyncAt/lastFullSyncAt so freshness is observable.
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import { ingestCustomers } from './ingest/customers'
import { ingestServiceItems } from './ingest/service-items'
import { buildDelAddrSiteMap, ingestServiceOrders } from './ingest/service-orders'
import { ingestWorksheets } from './ingest/worksheets'
import { keySweepReconcile } from './ingest/key-sweep'
import { sweepInvoiceStatus } from './invoice-status'

export interface SyncRegisterSummary {
  ingested?: number
  skipped?: number
  tombstoned?: number
  checked?: number
  invoiced?: number
  error?: string
}

export interface SyncSummary {
  perRegister: Record<string, SyncRegisterSummary>
}

interface SyncStateUpdate {
  syncCursor?: string
  lastSyncAt?: Date
  lastFullSyncAt?: Date
  syncStatus?: 'idle' | 'running' | 'error'
  errorMessage?: string | null
}

// Mirrors the onConflictDoUpdate idiom in the pre-refactor sync-tick route:
// insert with defaults, update only the columns this call actually supplies.
async function upsertSyncState(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  register: string,
  update: SyncStateUpdate,
): Promise<void> {
  const set: Record<string, unknown> = {}
  if (update.syncCursor !== undefined) set.syncCursor = update.syncCursor
  if (update.lastSyncAt !== undefined) set.lastSyncAt = update.lastSyncAt
  if (update.lastFullSyncAt !== undefined) set.lastFullSyncAt = update.lastFullSyncAt
  if (update.syncStatus !== undefined) set.syncStatus = update.syncStatus
  if (update.errorMessage !== undefined) set.errorMessage = update.errorMessage

  await db
    .insert(schema.erpSyncState)
    .values({ erpCompanyId, register, ...set })
    .onConflictDoUpdate({
      target: [schema.erpSyncState.erpCompanyId, schema.erpSyncState.register],
      set,
    })
}

async function getSyncCursor(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  register: string,
): Promise<string> {
  const [state] = await db
    .select({ syncCursor: schema.erpSyncState.syncCursor })
    .from(schema.erpSyncState)
    .where(and(eq(schema.erpSyncState.erpCompanyId, erpCompanyId), eq(schema.erpSyncState.register, register)))
  return state?.syncCursor ?? '0'
}

interface RegisterWorkResult {
  summary: SyncRegisterSummary
  stateUpdate: SyncStateUpdate
}

// Runs one register's sync work under a running/idle/error sync_state
// transition. A thrown error from `work` is caught here — it never
// propagates to the caller, so one register's failure can't abort the rest
// of syncConnection.
async function withRegisterSync(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  register: string,
  work: () => Promise<RegisterWorkResult>,
): Promise<SyncRegisterSummary> {
  await upsertSyncState(db, erpCompanyId, register, { syncStatus: 'running' })

  try {
    const { summary, stateUpdate } = await work()
    await upsertSyncState(db, erpCompanyId, register, {
      ...stateUpdate,
      syncStatus: 'idle',
      errorMessage: null,
    })
    return summary
  } catch (err) {
    const errorMessage = String(err)
    await upsertSyncState(db, erpCompanyId, register, { syncStatus: 'error', errorMessage })
    return { error: errorMessage }
  }
}

export async function syncConnection(
  db: PostgresJsDatabase<typeof schema>,
  adapter: ErpAdapter,
  erpCompanyId: string,
): Promise<SyncSummary> {
  const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
  if (!company) {
    throw new Error(`syncConnection: unknown erpCompanyId ${erpCompanyId}`)
  }

  const perRegister: Record<string, SyncRegisterSummary> = {}

  // Transient DelCode -> Name lookup, built by the DelAddrVc step below and
  // consumed by SVOVc's siteName resolution. Stays an empty map if
  // DelAddrVc's pull fails — SVOVc still ingests, just without siteName.
  let siteNameByDelCode = new Map<string, string>()

  perRegister.CUVc = await withRegisterSync(db, erpCompanyId, 'CUVc', async () => {
    const cursor = await getSyncCursor(db, erpCompanyId, 'CUVc')
    const changeSet = await adapter.pullChanges('CUVc', cursor)
    await ingestCustomers(db, erpCompanyId, changeSet)
    const sweep = await keySweepReconcile(db, adapter, erpCompanyId, 'CUVc')
    return {
      summary: { ingested: changeSet.upserts.length, tombstoned: sweep.tombstoned.length },
      stateUpdate: { syncCursor: changeSet.cursor, lastSyncAt: new Date() },
    }
  })

  perRegister.DelAddrVc = await withRegisterSync(db, erpCompanyId, 'DelAddrVc', async () => {
    const cursor = await getSyncCursor(db, erpCompanyId, 'DelAddrVc')
    const changeSet = await adapter.pullChanges('DelAddrVc', cursor)
    siteNameByDelCode = buildDelAddrSiteMap(changeSet.upserts)
    return {
      summary: { ingested: changeSet.upserts.length },
      stateUpdate: { syncCursor: changeSet.cursor, lastSyncAt: new Date() },
    }
  })

  perRegister.SVOSerVc = await withRegisterSync(db, erpCompanyId, 'SVOSerVc', async () => {
    const rows = await adapter.pullFullList('SVOSerVc')
    await ingestServiceItems(db, erpCompanyId, { upserts: rows, deletedRefs: [], cursor: '0' })
    const sweep = await keySweepReconcile(db, adapter, erpCompanyId, 'SVOSerVc')
    const now = new Date()
    return {
      summary: { ingested: rows.length, tombstoned: sweep.tombstoned.length },
      stateUpdate: { lastSyncAt: now, lastFullSyncAt: now },
    }
  })

  perRegister.SVOVc = await withRegisterSync(db, erpCompanyId, 'SVOVc', async () => {
    const rows = await adapter.pullFullList('SVOVc')
    const result = await ingestServiceOrders(
      db,
      erpCompanyId,
      { upserts: rows, deletedRefs: [], cursor: '0' },
      { siteNameByDelCode },
    )
    const now = new Date()
    return {
      summary: { ingested: result.ingested, skipped: result.skipped },
      stateUpdate: { lastSyncAt: now, lastFullSyncAt: now },
    }
  })

  perRegister.WSVc = await withRegisterSync(db, erpCompanyId, 'WSVc', async () => {
    const rows = await adapter.pullFullList('WSVc')
    const result = await ingestWorksheets(db, erpCompanyId, { upserts: rows, deletedRefs: [], cursor: '0' })
    const now = new Date()
    return {
      summary: { ingested: result.ingested, skipped: result.skipped },
      stateUpdate: { lastSyncAt: now, lastFullSyncAt: now },
    }
  })

  // Final step, WS4 Decision 10: the WebExcellentAPI-gated invoiced-status
  // sweep. Only runs (and only gets an erp_sync_state row) when the
  // connection has the capability — an untouched/REST-only connection must
  // never see an 'IVVc-links' row at all, not an idle no-op one. Same
  // withRegisterSync isolation as every other register: a failing sweep
  // records syncStatus='error' here and never aborts the registers above.
  if (adapter.capabilities().supportsInvoiceStatusReadback) {
    perRegister['IVVc-links'] = await withRegisterSync(db, erpCompanyId, 'IVVc-links', async () => {
      const result = await sweepInvoiceStatus(db, adapter, erpCompanyId)
      return {
        summary: { checked: result.checked, invoiced: result.invoiced },
        stateUpdate: { lastSyncAt: new Date() },
      }
    })
  }

  return { perRegister }
}
