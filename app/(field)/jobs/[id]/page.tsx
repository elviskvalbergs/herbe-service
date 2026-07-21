// app/(field)/jobs/[id]/page.tsx
//
// Task 5 (WS9-F4 minimal execution screen, docs/superpowers/sdd/task-5-brief.md):
// the F4 detail/execution screen a technician lands on from the jobs list
// (app/(field)/jobs/page.tsx). Only the Work tab (workDescription) + status
// stepper — no fault/cause/remedy tabs, no parts/lines, no signature capture
// in this slice.
//
// Gates on session itself, same as every other route in this repo
// (getVerifiedSession) — the FIX-9 field-role gate is the same one preserved
// in the list page. On top of that, this page gates on OWNERSHIP: notFound()
// unless the worksheet exists, belongs to this session's tenant (already
// enforced by getWorksheetById's own tenantId scoping — a foreign-tenant id
// simply reads back null), is assigned to THIS technician, and the role
// still carries 'worksheet:execute_own' (a defensive re-check — FIELD_ROLES
// already implies this capability for both technician and team_lead per
// lib/auth/roles.ts's ROLE_CAPABILITIES, but the brief calls for checking it
// explicitly rather than assuming the role list and the capability matrix
// never drift apart).
import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { FIELD_ROLES, hasCapability, type Role } from '@/lib/auth/roles'
import { getWorksheetById } from '@/lib/domain/stores/worksheets'
import { getServiceOrderById } from '@/lib/domain/stores/service-orders'
import { getCustomerById } from '@/lib/domain/stores/customers'
import type { WorksheetStatus } from '@/lib/domain/types'
import { STATUS_LABEL_KEYS } from '@/lib/domain/worksheet-status-labels'
import { WorksheetStepper } from '@/components/worksheet-stepper'

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }
  if (!FIELD_ROLES.includes(session.user.role as Role)) {
    redirect('/')
  }

  const { id } = await params
  const tenantId = session.user.tenantId
  const role = session.user.role as Role

  const worksheet = await getWorksheetById(db, tenantId, id)
  if (!worksheet || worksheet.technicianUserId !== session.user.id || !hasCapability(role, 'worksheet:execute_own')) {
    notFound()
  }

  const [order, t] = await Promise.all([
    getServiceOrderById(db, tenantId, worksheet.orderId),
    getTranslations('worksheet_execution'),
  ])
  const customer = order ? await getCustomerById(db, tenantId, order.customerId) : null

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <Link href="/jobs" className="text-sm font-semibold underline">
        {t('back_to_list')}
      </Link>
      <h1 className="text-lg font-semibold">{customer?.name ?? ''}</h1>
      <p className="text-sm text-[var(--fg-muted)]">{order?.description ?? order?.orderNumber ?? ''}</p>
      <p className="text-xs font-medium uppercase text-[var(--fg-muted)]">
        {t(STATUS_LABEL_KEYS[worksheet.status as WorksheetStatus])}
      </p>
      <WorksheetStepper
        worksheetId={worksheet.id}
        status={worksheet.status as WorksheetStatus}
        workDescription={worksheet.workDescription ?? ''}
        labels={{
          workDescriptionLabel: t('work_description_label'),
          actionAccept: t('action_accept'),
          actionStart: t('action_start'),
          actionPause: t('action_pause'),
          actionDone: t('action_done'),
          errorGeneric: t('error_generic'),
        }}
      />
    </main>
  )
}
