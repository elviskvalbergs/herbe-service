// components/worksheet-approval-queue.tsx
//
// Task 6 (O4 approval UI): the dispatcher-facing list of Done worksheets on
// app/(office)/c/[companyId]/worksheets/page.tsx, each row with an Approve
// button that posts to POST /api/worksheets/[id]/approve. Same
// "no hand-maintained client state after a write" idiom as
// components/new-booking-form.tsx / components/worksheet-stepper.tsx:
// router.refresh() re-runs the server loader, which re-reads the (now
// shorter, since an approved worksheet is no longer Done) list.
//
// All labels come from props (i18n: no hardcoded user-visible strings) —
// the server page resolves them via getTranslations('worksheet_approval')
// and passes them down, since a 'use client' component can't call
// getTranslations itself.
//
// Design system: the Approve button uses bg-primary (forest green, FIX-15)
// and the shared --ui-comfy-radius-btn token — square-first, not a pill
// (Principle 6) — same class as the other primary CTAs in this repo
// (NewBookingForm's submit, WorksheetStepper's Done action).
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export interface WorksheetApprovalItem {
  id: string
  orderNumber: string | null
  customerName: string
  technicianEmail: string | null
  workDescription: string | null
}

export interface WorksheetApprovalLabels {
  columnOrder: string
  columnCustomer: string
  columnTechnician: string
  columnWorkDescription: string
  approveLabel: string
  approvingLabel: string
  errorGeneric: string
  emptyState: string
}

export interface WorksheetApprovalQueueProps {
  items: WorksheetApprovalItem[]
  labels: WorksheetApprovalLabels
}

export function WorksheetApprovalQueue({ items, labels }: WorksheetApprovalQueueProps) {
  const router = useRouter()
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [errorId, setErrorId] = useState<string | null>(null)

  async function handleApprove(id: string) {
    setApprovingId(id)
    setErrorId(null)

    try {
      const res = await fetch(`/api/worksheets/${id}/approve`, { method: 'POST' })

      if (!res.ok) {
        setErrorId(id)
        return
      }

      router.refresh()
    } catch {
      setErrorId(id)
    } finally {
      setApprovingId(null)
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-[var(--fg-muted)]">{labels.emptyState}</p>
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-col gap-3 border border-[var(--border)] bg-[var(--herbe-paper)] p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex flex-col gap-1 text-sm text-[var(--herbe-ink)]">
            <span>
              <span className="font-medium">{labels.columnOrder}:</span> {item.orderNumber ?? '—'}
            </span>
            <span>
              <span className="font-medium">{labels.columnCustomer}:</span> {item.customerName}
            </span>
            <span>
              <span className="font-medium">{labels.columnTechnician}:</span> {item.technicianEmail ?? '—'}
            </span>
            <span>
              <span className="font-medium">{labels.columnWorkDescription}:</span> {item.workDescription ?? '—'}
            </span>
          </div>

          <div className="flex flex-col items-start gap-1">
            {errorId === item.id ? <p className="text-sm text-[var(--status-danger-fg)]">{labels.errorGeneric}</p> : null}
            <button
              type="button"
              disabled={approvingId === item.id}
              onClick={() => handleApprove(item.id)}
              className="rounded-[var(--ui-comfy-radius-btn)] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
            >
              {approvingId === item.id ? labels.approvingLabel : labels.approveLabel}
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}
