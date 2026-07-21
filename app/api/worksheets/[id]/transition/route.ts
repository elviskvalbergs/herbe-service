// app/api/worksheets/[id]/transition/route.ts
//
// Task 5 (WS9-F4 minimal execution screen, docs/superpowers/sdd/task-5-brief.md):
// the technician-facing status-stepper endpoint components/worksheet-stepper.tsx
// posts to. Body `{ to, workDescription? }`.
//
// Ownership check mirrors the [id]/page.tsx detail page's own gate exactly
// (technicianUserId === session.user.id && hasCapability('worksheet:execute_own')) —
// the page's gate only controls what's RENDERED; this route is the actual
// write path and re-validates independently, same reasoning as the
// /api/service-orders route's header comment on why a check performed once
// upstream is still worth repeating at the point that performs the write.
//
// `to` is allow-listed to exactly {Accepted, In progress, Paused, Done} —
// NOT the full WorksheetStatus union. Approved/Synced/Rejected are excluded
// on purpose: Approved is office-only (approveWorksheet, which this route
// does not call), Synced is ERP-owned, and Rejected is the office review
// flow's job (a later task) — none of those belong to the technician's
// execution stepper. transitionWorksheet itself also independently refuses
// 'Approved' (see its own header comment), so this allow-list and that
// refusal are two layers of the same rule, not a substitute for each other.
//
// workDescription, when present, is written via updateWorksheetWorkDescription
// BEFORE the transition — so if `to` turns out to be illegal for the
// worksheet's current status (DomainTransitionError -> 409), the technician's
// notes are still saved rather than silently discarded (record the work
// first, adjust the walk after).
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'
import { getWorksheetById, updateWorksheetWorkDescription } from '@/lib/domain/stores/worksheets'
import { transitionWorksheet } from '@/lib/domain/worksheet-transitions'
import { DomainTransitionError } from '@/lib/domain/worksheet-status'
import type { WorksheetStatus } from '@/lib/domain/types'

const ALLOWED_TARGETS: WorksheetStatus[] = ['Accepted', 'In progress', 'Paused', 'Done']

interface TransitionBody {
  to?: unknown
  workDescription?: unknown
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  const tenantId = session.user.tenantId

  // getWorksheetById scopes by tenantId itself, so a foreign-tenant or
  // nonexistent id both read back null — same flat 404, no leaked existence.
  const worksheet = await getWorksheetById(db, tenantId, id)
  if (!worksheet) {
    return new Response('Not Found', { status: 404 })
  }

  const role = session.user.role as Role
  if (worksheet.technicianUserId !== session.user.id || !hasCapability(role, 'worksheet:execute_own')) {
    return new Response('Forbidden', { status: 403 })
  }

  let body: TransitionBody
  try {
    body = await request.json()
  } catch {
    return Response.json({ status: 'error', message: 'invalid JSON body' }, { status: 400 })
  }

  const { to, workDescription } = body
  if (typeof to !== 'string' || !ALLOWED_TARGETS.includes(to as WorksheetStatus)) {
    return Response.json({ status: 'error', message: 'invalid target status' }, { status: 400 })
  }
  if (workDescription !== undefined && typeof workDescription !== 'string') {
    return Response.json({ status: 'error', message: 'workDescription must be a string' }, { status: 400 })
  }

  if (typeof workDescription === 'string') {
    await updateWorksheetWorkDescription(db, tenantId, id, workDescription)
  }

  try {
    await transitionWorksheet(db, tenantId, id, to as WorksheetStatus)
  } catch (err) {
    if (err instanceof DomainTransitionError) {
      return Response.json({ status: 'error', message: err.message }, { status: 409 })
    }
    throw err
  }

  return Response.json({ status: 'ok', to })
}
