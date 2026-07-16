// lib/sync/push/engine.ts
//
// The push-queue saga engine (WS4 outbound slice, docs/superpowers/plans/
// 2026-07-16-service-phase1-erp-outbound.md decision 3): the only code path
// that ever POSTs a create to the ERP. Per tick: pull the oldest runnable
// group per lane (store.getRunnableGroups already applies the FIFO/dead-
// blocks/next_attempt_at rules), run its steps in seq order, stop the group
// on the first non-succeeded step. A group's own failure — however it
// classifies — must never abort another lane's group in the same tick, so
// every group runs inside its own try/catch.
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ErpPermanentError, type ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'
import type { PushGroupRow, PushStepRow } from '@/drizzle/schema'
import { getRunnableGroups, markGroup, markStep } from './store'
import { gatherSvoCreateInput, gatherWsCreateInput } from './gather'
import { buildSvoCreatePayload, buildWsCreatePayload, type SvoCreateRowInput } from './builders'
import { getErpRefs, putErpRef } from '@/lib/domain/stores/erp-refs'
import { getWorksheetById, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { setOrderNumber } from '@/lib/domain/stores/service-orders'

type Db = PostgresJsDatabase<typeof schema>

const MAX_ATTEMPTS = 5
const BACKOFF_BASE_MS = 60_000 // one minute; next_attempt_at = now + 2^attempts minutes

export interface PushSummary {
  groupsProcessed: number
  groupsSucceeded: number
  groupsPending: number
  groupsDead: number
  stepsSucceeded: number
  stepsRetried: number
  stepsDead: number
}

export interface ProcessPushQueueOpts {
  now?: Date
}

export async function processPushQueue(
  db: Db,
  adapter: ErpAdapter,
  erpCompanyId: string,
  opts?: ProcessPushQueueOpts,
): Promise<PushSummary> {
  const now = opts?.now ?? new Date()
  const runnable = await getRunnableGroups(db, erpCompanyId, now)

  const summary: PushSummary = {
    groupsProcessed: 0,
    groupsSucceeded: 0,
    groupsPending: 0,
    groupsDead: 0,
    stepsSucceeded: 0,
    stepsRetried: 0,
    stepsDead: 0,
  }

  for (const { group, steps } of runnable) {
    summary.groupsProcessed++
    try {
      await runGroup(db, adapter, erpCompanyId, group, steps, now, summary)
    } catch {
      // Safety net (decision 3): a bug in the saga machinery itself — not a
      // classified step error, those are handled inside runGroup — must not
      // abort other groups/lanes this tick. Put the group back to pending so
      // the next tick retries it, and move on.
      await markGroup(db, group.id, 'pending').catch(() => {})
      summary.groupsPending++
    }
  }

  return summary
}

async function runGroup(
  db: Db,
  adapter: ErpAdapter,
  erpCompanyId: string,
  group: PushGroupRow,
  steps: PushStepRow[],
  now: Date,
  summary: PushSummary,
): Promise<void> {
  await markGroup(db, group.id, 'running')

  let outcome: 'succeeded' | 'pending' | 'dead' = 'succeeded'

  for (const step of steps) {
    if (step.status === 'succeeded') continue

    const result = await runStep(db, adapter, group.tenantId, erpCompanyId, group, step, now)
    if (result === 'succeeded') {
      summary.stepsSucceeded++
      continue
    }
    if (result === 'retry') {
      summary.stepsRetried++
      outcome = 'pending'
    } else {
      summary.stepsDead++
      outcome = 'dead'
    }
    break
  }

  await markGroup(db, group.id, outcome)
  if (outcome === 'succeeded') summary.groupsSucceeded++
  else if (outcome === 'pending') summary.groupsPending++
  else summary.groupsDead++
}

type StepOutcome = 'succeeded' | 'retry' | 'dead'

async function runStep(
  db: Db,
  adapter: ErpAdapter,
  tenantId: string,
  erpCompanyId: string,
  group: PushGroupRow,
  step: PushStepRow,
  now: Date,
): Promise<StepOutcome> {
  try {
    await markStep(db, step.id, { status: 'running' })
    const erpRef = await executeStep(db, adapter, tenantId, erpCompanyId, group, step)
    await markStep(db, step.id, { status: 'succeeded', erpRef, errorMessage: null })
    return 'succeeded'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    if (err instanceof ErpPermanentError) {
      await markStep(db, step.id, { status: 'dead', errorMessage: message })
      return 'dead'
    }

    const attempts = step.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await markStep(db, step.id, { status: 'dead', attempts, errorMessage: message })
      return 'dead'
    }

    const nextAttemptAt = new Date(now.getTime() + 2 ** attempts * BACKOFF_BASE_MS)
    await markStep(db, step.id, { status: 'failed', attempts, nextAttemptAt, errorMessage: message })
    return 'retry'
  }
}

async function executeStep(
  db: Db,
  adapter: ErpAdapter,
  tenantId: string,
  erpCompanyId: string,
  group: PushGroupRow,
  step: PushStepRow,
): Promise<string> {
  if (step.op !== 'create') {
    // decision-4 dispatch skeleton only: no domain flow enqueues update
    // steps yet (adapter-level pushUpdate is live-tested separately, Task 7).
    throw new ErpPermanentError(
      `update op not yet supported for the push queue (step ${step.id}, register ${step.register}) — no domain flow enqueues update steps yet`,
    )
  }

  if (step.entityType === 'serviceOrder') {
    return executeServiceOrderCreate(db, adapter, tenantId, erpCompanyId, group, step.entityId)
  }
  if (step.entityType === 'worksheet') {
    return executeWorksheetCreate(db, adapter, tenantId, erpCompanyId, step.entityId)
  }

  throw new ErpPermanentError(`unknown push step entityType: ${step.entityType}`)
}

// ---- serviceOrder create (SVOVc) ----

async function executeServiceOrderCreate(
  db: Db,
  adapter: ErpAdapter,
  tenantId: string,
  erpCompanyId: string,
  group: PushGroupRow,
  orderId: string,
): Promise<string> {
  // 1. stored-ref check (adoption). order_number is re-asserted here too (not
  // just on the create/natural-key paths below) so a prior partial failure
  // between putErpRef and setOrderNumber self-heals on the next tick instead
  // of leaving order_number permanently unset once the ref exists.
  const existingRefs = await getErpRefs(db, tenantId, 'service_order', orderId)
  const existingPrimary = existingRefs.find((r) => r.purpose === 'primary')
  if (existingPrimary) {
    await setOrderNumber(db, tenantId, orderId, existingPrimary.recordRef)
    return existingPrimary.recordRef
  }

  // 2. natural-key lookup — build the payload first (building also validates).
  const input = await gatherSvoCreateInput(db, tenantId, erpCompanyId, orderId, group.createdAt)
  const payload = buildSvoCreatePayload(input)

  const payloadSerials = collectSerials(input.rows)
  const existingRecords = await adapter.fetchRecords('SVOVc', {
    'filter.CustCode': String(payload.CustCode),
    'filter.TransDate': String(payload.TransDate),
  })
  const match = existingRecords.find((rec) => setsEqual(recordSerialSet(rec), payloadSerials))
  if (match) {
    const erpRef = String(match.SerNr)
    await putErpRef(db, {
      tenantId,
      entityType: 'service_order',
      entityId: orderId,
      purpose: 'primary',
      register: 'SVOVc',
      recordRef: erpRef,
      erpCompanyId,
    })
    await setOrderNumber(db, tenantId, orderId, erpRef)
    return erpRef
  }

  // 3. create.
  const { erpRef } = await adapter.pushCreate('SVOVc', payload)
  if (!erpRef) {
    throw new ErpPermanentError(
      'create returned 200 without a SerNr — ERP number series for SVOVc likely behind/exhausted; fix the series in the ERP (onboarding check), then retry',
    )
  }

  // 4. on success.
  await putErpRef(db, {
    tenantId,
    entityType: 'service_order',
    entityId: orderId,
    purpose: 'primary',
    register: 'SVOVc',
    recordRef: erpRef,
    erpCompanyId,
  })
  await setOrderNumber(db, tenantId, orderId, erpRef)

  return erpRef
}

function collectSerials(rows: SvoCreateRowInput[]): Set<string> {
  return new Set(rows.map((r) => r.serialNr).filter((s): s is string => s != null && s !== ''))
}

function recordSerialSet(record: Record<string, unknown>): Set<string> {
  const rows = Array.isArray(record.rows) ? (record.rows as Record<string, unknown>[]) : []
  return new Set(rows.map((r) => String(r.SerialNr ?? '')).filter((s) => s !== ''))
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) if (!b.has(v)) return false
  return true
}

// ---- worksheet create (WSVc) ----

async function executeWorksheetCreate(
  db: Db,
  adapter: ErpAdapter,
  tenantId: string,
  erpCompanyId: string,
  worksheetId: string,
): Promise<string> {
  // 1. stored-ref check (adoption) — also flips Approved -> Synced.
  const existingRefs = await getErpRefs(db, tenantId, 'worksheet', worksheetId)
  const existingPrimary = existingRefs.find((r) => r.purpose === 'primary')
  if (existingPrimary) {
    await markWorksheetSyncedIfApproved(db, tenantId, worksheetId)
    return existingPrimary.recordRef
  }

  // 2. natural-key lookup — build the payload first (building also validates).
  const input = await gatherWsCreateInput(db, adapter, tenantId, erpCompanyId, worksheetId)
  const payload = buildWsCreatePayload(input)

  const existingRecords = await adapter.fetchRecords('WSVc', {
    'filter.SVONr': input.orderErpRef,
    'filter.EMCode': input.emCode,
  })
  if (existingRecords[0]) {
    const erpRef = String(existingRecords[0].SerNr)
    await putErpRef(db, {
      tenantId,
      entityType: 'worksheet',
      entityId: worksheetId,
      purpose: 'primary',
      register: 'WSVc',
      recordRef: erpRef,
      erpCompanyId,
    })
    await markWorksheetSyncedIfApproved(db, tenantId, worksheetId)
    return erpRef
  }

  // 3. create.
  const { erpRef } = await adapter.pushCreate('WSVc', payload)
  if (!erpRef) {
    throw new ErpPermanentError(
      'create returned 200 without a SerNr — ERP number series for WSVc likely behind/exhausted; fix the series in the ERP (onboarding check), then retry',
    )
  }

  // 4. on success.
  await putErpRef(db, {
    tenantId,
    entityType: 'worksheet',
    entityId: worksheetId,
    purpose: 'primary',
    register: 'WSVc',
    recordRef: erpRef,
    erpCompanyId,
  })
  await markWorksheetSyncedIfApproved(db, tenantId, worksheetId)

  return erpRef
}

async function markWorksheetSyncedIfApproved(db: Db, tenantId: string, worksheetId: string): Promise<void> {
  const worksheet = await getWorksheetById(db, tenantId, worksheetId)
  if (worksheet?.status === 'Approved') {
    await setWorksheetStatus(db, tenantId, worksheetId, 'Synced')
  }
}
