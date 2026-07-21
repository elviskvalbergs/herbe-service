// app/api/service-orders/route.ts
//
// Task 4 (docs/superpowers/sdd/task-4-brief.md): WS5-minimal booking — an
// office user (order:view_all) creates a ServiceOrder + a
// technician-assigned Worksheet, locally only. No ActVc/calendar write, no
// ERP push — that's deferred to a later slice (the order-create push group
// only gets enqueued on worksheet approval, see lib/sync/push/enqueue.ts).
//
// Tenant-scoping mirrors app/(office)/c/[companyId]/layout.tsx:69-76 exactly
// (same "foreign/deactivated erpCompanyId reads as absent" 404 semantics),
// re-validated HERE because the client-supplied erpCompanyId in the POST
// body cannot be trusted just because the page that rendered the form
// resolved it correctly — same reasoning as the outbox route's Task 16b IDOR
// fix (tenantId only ever comes from the session, never the body).
//
// technicianUserId is checked against listLinkedTechnicians (not just "any
// technician/team_lead in this tenant") because that store's own header
// comment is the reason this route exists in this shape: approveWorksheet
// (lib/sync/push/enqueue.ts) refuses to push a worksheet whose technician has
// no identity_links (provider 'erp') entry for this company. Booking a
// worksheet for an unlinked technician would create a worksheet that can
// never be approved — this route can't let that booking happen at all.
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'
import { getCustomerById } from '@/lib/domain/stores/customers'
import { listLinkedTechnicians } from '@/lib/domain/stores/identity-links'
import { insertServiceOrder, setOrderStatus } from '@/lib/domain/stores/service-orders'
import { insertWorksheet } from '@/lib/domain/stores/worksheets'
import { transitionWorksheet } from '@/lib/domain/worksheet-transitions'
import { deriveOrderStatus } from '@/lib/domain/order-status'

interface CreateBookingBody {
  erpCompanyId?: unknown
  customerId?: unknown
  technicianUserId?: unknown
  description?: unknown
}

export async function POST(request: Request) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const role = session.user.role as Role
  if (!hasCapability(role, 'order:view_all')) {
    return new Response('Forbidden', { status: 403 })
  }

  let body: CreateBookingBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON body' }, { status: 400 })
  }

  const { erpCompanyId, customerId, technicianUserId, description } = body
  if (typeof erpCompanyId !== 'string' || erpCompanyId.length === 0) {
    return Response.json({ status: 'error', message: 'erpCompanyId is required' }, { status: 400 })
  }
  if (typeof customerId !== 'string' || customerId.length === 0) {
    return Response.json({ status: 'error', message: 'customerId is required' }, { status: 400 })
  }
  if (typeof technicianUserId !== 'string' || technicianUserId.length === 0) {
    return Response.json({ status: 'error', message: 'technicianUserId is required' }, { status: 400 })
  }
  if (description !== undefined && typeof description !== 'string') {
    return Response.json({ status: 'error', message: 'description must be a string' }, { status: 400 })
  }

  const tenantId = session.user.tenantId

  // Same tenant-ownership check as the layout: a foreign/deactivated company
  // reads as a flat 404, never a 403 (don't leak existence).
  const [company] = await db
    .select({ id: schema.erpCompanies.id, tenantId: schema.erpCompanies.tenantId })
    .from(schema.erpCompanies)
    .where(and(eq(schema.erpCompanies.id, erpCompanyId), eq(schema.erpCompanies.active, true)))

  if (!company || company.tenantId !== tenantId) {
    return new Response('Not Found', { status: 404 })
  }

  const customer = await getCustomerById(db, tenantId, customerId)
  if (!customer || customer.erpCompanyId !== erpCompanyId) {
    return Response.json({ status: 'error', message: 'invalid customerId' }, { status: 400 })
  }

  const technicians = await listLinkedTechnicians(db, tenantId, erpCompanyId)
  if (!technicians.some((t) => t.id === technicianUserId)) {
    return Response.json(
      { status: 'error', message: 'technician has no linked ERP identity for this company' },
      { status: 400 },
    )
  }

  const { orderId, worksheetId } = await db.transaction(async (tx) => {
    const order = await insertServiceOrder(tx, {
      tenantId,
      erpCompanyId,
      customerId,
      description: description || undefined,
    })

    const worksheet = await insertWorksheet(tx, {
      tenantId,
      erpCompanyId,
      orderId: order.id,
      technicianUserId,
    })

    await transitionWorksheet(tx, tenantId, worksheet.id, 'Assigned')

    // Cosmetic: a freshly-booked order has exactly one Assigned worksheet and
    // no manual/ERP state yet, so deriveOrderStatus always resolves to
    // 'Planned' here — cheap to compute rather than hardcoding the literal.
    const status = deriveOrderStatus({
      manualState: null,
      erpState: null,
      cancelled: false,
      bookingCount: 1,
      worksheets: ['Assigned'],
    })
    await setOrderStatus(tx, tenantId, order.id, status)

    return { orderId: order.id, worksheetId: worksheet.id }
  })

  return Response.json({ orderId, worksheetId }, { status: 201 })
}
