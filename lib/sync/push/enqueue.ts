// lib/sync/push/enqueue.ts
//
// Entry points that put work on the ERP push queue (WS4 outbound slice, docs/
// superpowers/plans/2026-07-16-service-phase1-erp-outbound.md decision 4).
// This module only decides WHAT gets enqueued and enforces the approval
// guards — the saga engine (engine.ts) is the only thing that ever talks to
// the ERP.
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { createPushGroup, type CreatePushGroupStepInput } from './store'
import { getWorksheetById, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { getErpRefs } from '@/lib/domain/stores/erp-refs'
import { getErpIdentityLink } from '@/lib/domain/stores/identity-links'
import { assertWorksheetTransition } from '@/lib/domain/worksheet-status'
import type { WorksheetStatus } from '@/lib/domain/types'

type Db = PostgresJsDatabase<typeof schema>

export interface EnqueueOrderCreatePushInput {
  tenantId: string
  erpCompanyId: string
  orderId: string
}

export async function enqueueOrderCreatePush(
  db: Db,
  { tenantId, erpCompanyId, orderId }: EnqueueOrderCreatePushInput,
): Promise<{ groupId: string }> {
  return createPushGroup(db, {
    tenantId,
    erpCompanyId,
    lane: `order:${orderId}`,
    kind: 'order_create',
    steps: [{ seq: 1, entityType: 'serviceOrder', entityId: orderId, register: 'SVOVc', op: 'create' }],
  })
}

export interface ApproveWorksheetInput {
  tenantId: string
  erpCompanyId: string
  worksheetId: string
}

// The approval entry point (decision 4): asserts the Done->Approved
// transition, blocks on a missing technician/identity_links link BEFORE any
// status change, then enqueues the worksheet_push group — an order-create step
// first only when the order doesn't already have a primary SVOVc ref, so a
// worksheet never races ahead of its own order's push (docs/04-erp-sync.md).
export async function approveWorksheet(
  db: Db,
  { tenantId, erpCompanyId, worksheetId }: ApproveWorksheetInput,
): Promise<{ groupId: string }> {
  const worksheet = await getWorksheetById(db, tenantId, worksheetId)
  if (!worksheet) {
    throw new Error(`approveWorksheet: worksheet ${worksheetId} not found`)
  }

  // Let DomainTransitionError propagate untouched for an invalid transition
  // (e.g. Draft -> Approved) — no technician check, no status change.
  assertWorksheetTransition(worksheet.status as WorksheetStatus, 'Approved')

  if (!worksheet.technicianUserId) {
    throw new Error(
      `cannot approve worksheet ${worksheetId}: no technician assigned — link a technician with an ERP person code (identity_links) before approving`,
    )
  }

  const identityLink = await getErpIdentityLink(db, tenantId, worksheet.technicianUserId, erpCompanyId)
  if (!identityLink) {
    throw new Error(
      `cannot approve worksheet ${worksheetId}: technician ${worksheet.technicianUserId} has no identity_links (provider 'erp') entry for this ERP company — link the technician to an ERP person code before approving`,
    )
  }

  // setWorksheetStatus and createPushGroup must commit atomically: a crash
  // between the two would otherwise strand the worksheet at Approved with
  // no push group and no recovery path (re-approving throws
  // DomainTransitionError, since Approved isn't a valid `from` for another
  // Approved transition). createPushGroup already wraps its own writes in
  // db.transaction — drizzle-orm/postgres-js nests transactions as
  // SAVEPOINTs (PostgresJsTransaction#transaction), so calling it with the
  // outer `tx` here composes rather than opening a second top-level
  // transaction.
  return db.transaction(async (tx) => {
    await setWorksheetStatus(tx, tenantId, worksheetId, 'Approved')

    const orderRefs = await getErpRefs(tx, tenantId, 'service_order', worksheet.orderId)
    const hasOrderPrimary = orderRefs.some((r) => r.purpose === 'primary')

    const steps: CreatePushGroupStepInput[] = []
    let seq = 1
    if (!hasOrderPrimary) {
      steps.push({ seq: seq++, entityType: 'serviceOrder', entityId: worksheet.orderId, register: 'SVOVc', op: 'create' })
    }
    steps.push({ seq: seq++, entityType: 'worksheet', entityId: worksheetId, register: 'WSVc', op: 'create' })

    return createPushGroup(tx, {
      tenantId,
      erpCompanyId,
      lane: `order:${worksheet.orderId}`,
      kind: 'worksheet_push',
      steps,
    })
  })
}
