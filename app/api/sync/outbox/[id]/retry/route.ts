// app/api/sync/outbox/[id]/retry/route.ts
//
// Task 8 (conflict inbox retry). The original POST /api/sync/outbox's
// idempotency check short-circuits ANY pre-existing row — applied OR
// failed — as `already_applied` without re-pushing (see that route's header
// comment). So retrying a failed op needs a distinct mechanism: reset the
// row to 'pending' and re-drive the ERP push for its order.
//
// WS4 outbound slice reconciliation (merge of feature/service-phase1-erp-outbound):
// the Phase-0 spike this route originally shared (lib/sync/outbox-push.ts's
// attemptOutboxPush → pushServiceOrderCreate) was replaced wholesale by the
// push-queue saga, and the outbox `payload` contract changed to `{orderId}`
// referencing a domain service_orders row.
//
// FIX-4: a failed op left a failed/dead order-create group on this order's
// lane (`order:<orderId>`). Enqueuing a NEW group here (the original bug)
// would stack it behind the FIFO gate — the oldest non-succeeded group, i.e.
// the very group that failed — so the new group could never run and the op
// stayed `failed` forever. So retry now RESETS the existing order-create
// group on the lane (group → pending, its non-succeeded steps → pending) and
// re-drives it inline via processPushQueue (the saga is idempotent —
// stored-ref → natural-key → create — so re-driving never duplicates the ERP
// record). Only when no group exists yet (an op that failed before any group
// was created) does it enqueue a fresh one. Then it reflects the group's own
// step outcome back onto the op.
//
// Tenant-scoping follows the same rule as the original route (Task 16b):
// tenantId comes only from the session. An op id belonging to another
// tenant (or not existing at all) is answered as a flat 404 — this route
// resolves an id from the URL path to an existing resource, so the
// ordinary "don't confirm another tenant's resource exists" 404 applies
// (unlike the original route's 409, which is about denying reuse of a
// client-supplied id for a NEW write — a different situation).
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { enqueueOrderCreatePush } from '@/lib/sync/push/enqueue'
import { findGroupForLaneKind, getStepsForGroup, resetGroupForRetry } from '@/lib/sync/push/store'
import { processPushQueue } from '@/lib/sync/push/engine'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  const tenantId = session?.user?.tenantId
  if (!tenantId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params

  const [existing] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, id))
  if (!existing || existing.tenantId !== tenantId) {
    return new Response('Not Found', { status: 404 })
  }

  if (existing.status !== 'failed') {
    return Response.json(
      { status: 'invalid_state', error: `op is '${existing.status}', only a 'failed' op can be retried` },
      { status: 409 },
    )
  }

  // Under the WS4 contract the op's payload is `{orderId}`. A failed op should
  // always carry one (the main route validates it before inserting), but guard
  // defensively rather than passing undefined into the saga.
  const orderId = (existing.payloadJson as { orderId?: unknown })?.orderId
  if (typeof orderId !== 'string') {
    return Response.json({ status: 'invalid_state', error: 'op payload has no orderId to retry' }, { status: 409 })
  }

  await db.update(schema.outboxOps).set({ status: 'pending', errorMessage: null }).where(eq(schema.outboxOps.id, id))

  try {
    const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.tenantId, tenantId))
    // FIX-3: build the adapter from the stored connection (decrypts the
    // encrypted creds) rather than from adapterConfigJson, which has no auth.
    if (!company) {
      throw new Error('no ERP connection configured for this tenant')
    }
    const adapter = await buildAdapterForConnection(db, company.id)

    // FIX-4: re-drive the existing order-create group on this lane instead of
    // stacking a new one behind the FIFO gate. Reset it only if it hasn't
    // already succeeded (a succeeded group re-drives to a no-op and its step
    // outcome below still applies the op). Fall back to a fresh enqueue only
    // when the op failed before any group existed.
    const lane = `order:${orderId}`
    const existingGroup = await findGroupForLaneKind(db, company.id, lane, 'order_create')
    let groupId: string
    if (existingGroup) {
      if (existingGroup.status !== 'succeeded') {
        await resetGroupForRetry(db, existingGroup.id)
      }
      groupId = existingGroup.id
    } else {
      ;({ groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId: company.id, orderId }))
    }
    await processPushQueue(db, adapter, company.id)

    const steps = await getStepsForGroup(db, groupId)
    const orderStep = steps.find((s) => s.entityType === 'serviceOrder' && s.entityId === orderId)

    if (orderStep?.status === 'succeeded' && orderStep.erpRef) {
      await db
        .update(schema.outboxOps)
        .set({ status: 'applied', erpRef: orderStep.erpRef, appliedAt: new Date() })
        .where(eq(schema.outboxOps.id, id))

      return Response.json({ status: 'applied', erpRef: orderStep.erpRef })
    }

    const errorMessage = orderStep?.errorMessage ?? 'push did not complete this tick'
    await db
      .update(schema.outboxOps)
      .set({ status: 'failed', errorMessage })
      .where(eq(schema.outboxOps.id, id))

    return Response.json({ status: 'failed', error: errorMessage }, { status: 502 })
  } catch (err) {
    await db
      .update(schema.outboxOps)
      .set({ status: 'failed', errorMessage: String(err) })
      .where(eq(schema.outboxOps.id, id))

    return Response.json({ status: 'failed', error: String(err) }, { status: 502 })
  }
}
