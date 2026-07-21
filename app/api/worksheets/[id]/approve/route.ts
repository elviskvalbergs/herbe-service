// app/api/worksheets/[id]/approve/route.ts
//
// Task 6 (O4 approval UI, docs/superpowers/sdd/task-6-brief.md): the
// dispatcher-facing approve action the worksheets page's Approve button
// posts to.
//
// FIX-13: the hasCapability(role, 'worksheet:approve') check below is the
// actual fix this task exists to land — without a route-level check, any
// office role could approve a worksheet just by knowing its id (the layout
// only gates dispatcher/back_office/admin generally, not this capability
// specifically — same reasoning as orders/page.tsx and the transition
// route's own header comments).
//
// approveWorksheet (lib/sync/push/enqueue.ts) is the ONLY path to
// 'Approved' — this route calls it unmodified. Its DomainTransitionError
// (invalid from-status, e.g. the worksheet isn't Done) surfaces as 409;
// its plain Error (missing technician / missing identity_links, both
// thrown before any write) surfaces as 422 with the message intact.
//
// On success, the ERP push is driven inline — buildAdapterForConnection +
// processPushQueue, mirroring app/api/sync/outbox/[id]/retry/route.ts —
// so the WS4 push starts immediately instead of waiting for the next
// push-tick cron. That inline call is wrapped in its own try/catch,
// independent of approveWorksheet's transaction: a push failure here must
// NOT roll back the already-committed approval, since the cron retries a
// pending/dead group on its own schedule regardless of what this request
// does.
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'
import { getWorksheetById } from '@/lib/domain/stores/worksheets'
import { approveWorksheet } from '@/lib/sync/push/enqueue'
import { DomainTransitionError } from '@/lib/domain/worksheet-status'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { processPushQueue, type PushSummary } from '@/lib/sync/push/engine'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  const tenantId = session.user.tenantId

  // getWorksheetById scopes by tenantId itself, so a foreign-tenant or
  // nonexistent id both read back null — same flat 404, no leaked
  // existence, as the transition route.
  const worksheet = await getWorksheetById(db, tenantId, id)
  if (!worksheet) {
    return new Response('Not Found', { status: 404 })
  }

  const role = session.user.role as Role
  if (!hasCapability(role, 'worksheet:approve')) {
    return new Response('Forbidden', { status: 403 })
  }

  // Every worksheet reaching Done in this slice was booked with an
  // erpCompanyId (app/api/service-orders/route.ts always sets one on
  // insertWorksheet) — this guard exists only to satisfy
  // approveWorksheet's required string param at compile time.
  if (!worksheet.erpCompanyId) {
    return Response.json({ status: 'error', message: 'worksheet has no ERP company' }, { status: 422 })
  }
  const erpCompanyId = worksheet.erpCompanyId

  let groupId: string
  try {
    ;({ groupId } = await approveWorksheet(db, { tenantId, erpCompanyId, worksheetId: id }))
  } catch (err) {
    if (err instanceof DomainTransitionError) {
      return Response.json({ status: 'error', message: err.message }, { status: 409 })
    }
    if (err instanceof Error) {
      return Response.json({ status: 'error', message: err.message }, { status: 422 })
    }
    throw err
  }

  let pushSummary: PushSummary | null = null
  try {
    const adapter = await buildAdapterForConnection(db, erpCompanyId)
    pushSummary = await processPushQueue(db, adapter, erpCompanyId)
  } catch {
    // Swallowed on purpose — see this file's header comment. The approval
    // above already committed; the push-tick cron retries.
    pushSummary = null
  }

  return Response.json({ status: 'approved', groupId, pushSummary })
}
