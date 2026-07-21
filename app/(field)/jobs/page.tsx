// app/(field)/jobs/page.tsx
//
// Task 5 (WS9-F4 minimal execution screen, docs/superpowers/sdd/task-5-brief.md):
// doc07 F2 "My jobs" real content — the technician's own worksheets
// (getWorksheetsForTechnician), each linking to the F4 detail/execution
// screen at /jobs/[id]. No calendar view yet (that's later WS work); this is
// a flat list, same "honest partial state" idiom as the rest of Task 5's
// pages rather than fake chrome for a day/week view that doesn't exist.
//
// Gates on session itself (not just via a parent redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so every route gates itself (getVerifiedSession) the same way
// app/(field)/today/page.tsx does. The FIX-9 field-role gate right after the
// session guard is preserved from the Task 5 stub this page replaces.
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { FIELD_ROLES, type Role } from '@/lib/auth/roles'
import { getWorksheetsForTechnician } from '@/lib/domain/stores/worksheets'
import { getServiceOrderById } from '@/lib/domain/stores/service-orders'
import { getCustomerById } from '@/lib/domain/stores/customers'
import type { WorksheetStatus } from '@/lib/domain/types'
import { STATUS_LABEL_KEYS } from '@/lib/domain/worksheet-status-labels'

export default async function JobsPage() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }
  if (!FIELD_ROLES.includes(session.user.role as Role)) {
    redirect('/')
  }

  const tenantId = session.user.tenantId

  const [worksheets, t] = await Promise.all([
    getWorksheetsForTechnician(db, tenantId, session.user.id),
    getTranslations('worksheet_execution'),
  ])

  const jobs = await Promise.all(
    worksheets.map(async (worksheet) => {
      const order = await getServiceOrderById(db, tenantId, worksheet.orderId)
      const customer = order ? await getCustomerById(db, tenantId, order.customerId) : null
      return {
        id: worksheet.id,
        status: worksheet.status as WorksheetStatus,
        customerName: customer?.name ?? '',
        orderSummary: order?.description ?? order?.orderNumber ?? '',
      }
    }),
  )

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold">{t('jobs_title')}</h1>
      {jobs.length === 0 ? (
        <p className="text-sm text-[var(--fg-muted)]">{t('jobs_empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {jobs.map((job) => (
            <li key={job.id} className="border-b border-[var(--border)] pb-3 text-sm">
              <a href={`/jobs/${job.id}`} className="flex flex-col gap-1">
                <span className="font-semibold text-[var(--herbe-ink)]">{job.customerName}</span>
                <span className="text-[var(--fg-muted)]">{job.orderSummary}</span>
                <span className="text-xs font-medium uppercase text-[var(--fg-muted)]">
                  {t(STATUS_LABEL_KEYS[job.status])}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
