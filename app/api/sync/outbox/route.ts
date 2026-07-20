// app/api/sync/outbox/route.ts
//
// Task 13: the one Phase-0 outbound round-trip. Idempotent by the client-
// generated `id` (drizzle/schema.ts outboxOps) — a retried POST for an id
// that already has a row is answered from that row without re-pushing to the
// ERP, so a double-tap or a retried network call can never create a
// duplicate Service Order.
//
// Phase 0 simplification: any pre-existing row (applied OR failed) short-
// circuits as "already_applied" — this POST never re-attempts a *failed* op.
// Task 8 adds a dedicated retry path for that
// (app/api/sync/outbox/[id]/retry/route.ts), which re-drives the WS4 saga for
// the op's order rather than reusing this idempotency check.
//
// Task 16b: tenantId is taken ONLY from the authenticated session
// (session.user.tenantId), never from the request body — two reviews
// flagged that trusting a client-supplied tenantId let any authenticated
// user write into another tenant (IDOR). A session with no tenantId claim
// is rejected rather than falling through to an unscoped query.
//
// WS4 outbound slice (docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 11): the saga engine is now the only code path that ever POSTs a
// create to the ERP, so this route no longer pushes a raw client-supplied
// SVOVc-shaped payload directly — it enqueues an order-create push group for
// a DOMAIN service order and drains it inline via processPushQueue, the same
// engine the push-tick cron runs. This is a CONTRACT CHANGE from the Phase-0
// spike: `payload` used to be an ERP-shaped `{custCode, transDate, rows}`
// object; it is now `{orderId}`, referencing a real service_orders row owned
// by the caller's tenant (the saga builds the actual SVOVc payload from that
// row's current domain state, per decision 2). Response shapes, status
// codes, and idempotency/cross-tenant semantics are unchanged.
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { eq } from 'drizzle-orm'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { enqueueOrderCreatePush } from '@/lib/sync/push/enqueue'
import { getStepsForGroup } from '@/lib/sync/push/store'
import { processPushQueue } from '@/lib/sync/push/engine'

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  const tenantId = session?.user?.tenantId
  if (!tenantId) {
    return new Response('Unauthorized', { status: 401 })
  }

  const body = await request.json()

  const [existing] = await db.select().from(schema.outboxOps).where(eq(schema.outboxOps.id, body.id))
  if (existing) {
    // The id PK is global, not scoped to tenant — a foreign op id must never
    // confirm existence or leak another tenant's erpRef back to the caller.
    if (existing.tenantId !== tenantId) {
      return new Response('Conflict', { status: 409 })
    }
    return Response.json({ status: 'already_applied', erpRef: existing.erpRef })
  }

  // Review (WS4 task 6): a missing/non-string payload.orderId used to fall
  // through to the enqueue/push try-block below and surface as a generic 502
  // (op marked failed) only after a DB write. Reject it up front instead —
  // same "no work done" posture as the 401 guard above.
  const orderId = body.payload?.orderId
  if (typeof orderId !== 'string') {
    return new Response('Bad Request', { status: 400 })
  }

  await db.insert(schema.outboxOps).values({
    id: body.id,
    tenantId,
    entity: body.entity,
    op: body.op,
    payloadJson: body.payload,
  })

  try {
    // Phase 0 spike: hardcode the single-company lookup for the tenant —
    // Phase 1's push-queue-per-order generalizes this to N companies and N
    // entity types.
    const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.tenantId, tenantId))
    // FIX-3: build the adapter from the stored connection (decrypts the
    // encrypted creds in api_creds_encrypted) — adapterConfigJson has no
    // `auth`, so the old getAdapter(config) path threw a zod error and 502'd
    // against a real ERP. Guard a tenant with no connection configured.
    if (!company) {
      throw new Error('no ERP connection configured for this tenant')
    }
    const adapter = await buildAdapterForConnection(db, company.id)

    const { groupId } = await enqueueOrderCreatePush(db, { tenantId, erpCompanyId: company.id, orderId })
    await processPushQueue(db, adapter, company.id)

    const steps = await getStepsForGroup(db, groupId)
    const orderStep = steps.find((s) => s.entityType === 'serviceOrder' && s.entityId === orderId)

    if (orderStep?.status === 'succeeded' && orderStep.erpRef) {
      await db
        .update(schema.outboxOps)
        .set({ status: 'applied', erpRef: orderStep.erpRef, appliedAt: new Date() })
        .where(eq(schema.outboxOps.id, body.id))

      return Response.json({ status: 'applied', erpRef: orderStep.erpRef })
    }

    // The enqueued group's own step didn't succeed this tick — either it
    // failed/dead-lettered, or (rare) a still-active older group on the same
    // lane gated it out. Either way this synchronous request can't wait for
    // a later tick, so it reports failure now; the step itself is left in
    // whatever state the engine put it in (retryable or dead per its own
    // classification) for push-tick / push-retry to pick up later.
    const errorMessage = orderStep?.errorMessage ?? 'push did not complete this tick'
    await db
      .update(schema.outboxOps)
      .set({ status: 'failed', errorMessage })
      .where(eq(schema.outboxOps.id, body.id))

    return Response.json({ status: 'failed', error: errorMessage }, { status: 502 })
  } catch (err) {
    await db
      .update(schema.outboxOps)
      .set({ status: 'failed', errorMessage: String(err) })
      .where(eq(schema.outboxOps.id, body.id))

    return Response.json({ status: 'failed', error: String(err) }, { status: 502 })
  }
}
