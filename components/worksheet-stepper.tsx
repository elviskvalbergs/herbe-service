// components/worksheet-stepper.tsx
//
// Task 5 (WS9-F4 minimal execution screen): the Work tab (workDescription
// textarea) + status stepper for app/(field)/jobs/[id]/page.tsx. Posts to
// POST /api/worksheets/[id]/transition with the current textarea value as
// `workDescription` on every transition click — this slice has no separate
// "save notes without transitioning" affordance, so notes are persisted
// together with whichever stepper action the technician takes next (the
// route updates workDescription before applying the transition either way).
//
// Same "no hand-maintained client state after a write" idiom as
// components/conflict-inbox.tsx / components/new-booking-form.tsx:
// router.refresh() re-runs the server loader, which re-reads the new status
// and re-renders with the buttons valid from THAT status.
//
// All labels come from props (i18n: no hardcoded user-visible strings) — the
// server page resolves them via getTranslations('worksheet_execution') and
// passes them down, since a 'use client' component can't call
// getTranslations itself.
//
// Design: only ONE action per screen is styled as the primary CTA
// (bg-primary, forest green) — the forward-progressing 'Done' action when
// it's on-screen alongside Pause/Start, or the sole action otherwise
// (Accept, Start). Pause/Start next to Done use the bone/border secondary
// style so there's never two competing primary buttons in the same row.
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { WorksheetStatus } from '@/lib/domain/types'

export interface WorksheetStepperLabels {
  workDescriptionLabel: string
  actionAccept: string
  actionStart: string
  actionPause: string
  actionDone: string
  errorGeneric: string
}

export interface WorksheetStepperProps {
  worksheetId: string
  status: WorksheetStatus
  workDescription: string
  labels: WorksheetStepperLabels
}

type ActionLabelKey = 'actionAccept' | 'actionStart' | 'actionPause' | 'actionDone'

interface StepAction {
  to: WorksheetStatus
  labelKey: ActionLabelKey
}

// The allow-list this maps onto is enforced independently by the route
// (POST /api/worksheets/[id]/transition) — this is only the UI's view of
// which buttons to show from which status, matching the brief's stepper
// spec exactly: Assigned->[Accept], Accepted->[Start],
// In progress->[Pause, Mark done], Paused->[Start, Mark done]. Done has no
// entry (no field actions; awaits office approval), and every other status
// (Draft/Approved/Synced/Rejected) is likewise absent by omission from this
// Partial map, not by an explicit empty array.
const NEXT_ACTIONS: Partial<Record<WorksheetStatus, StepAction[]>> = {
  Assigned: [{ to: 'Accepted', labelKey: 'actionAccept' }],
  Accepted: [{ to: 'In progress', labelKey: 'actionStart' }],
  'In progress': [
    { to: 'Paused', labelKey: 'actionPause' },
    { to: 'Done', labelKey: 'actionDone' },
  ],
  Paused: [
    { to: 'In progress', labelKey: 'actionStart' },
    { to: 'Done', labelKey: 'actionDone' },
  ],
}

const fieldClass =
  'w-full rounded-[var(--ui-comfy-radius-input)] border border-[var(--border)] bg-[var(--herbe-bone)] px-3 py-2 text-sm text-[var(--herbe-ink)] focus:bg-[var(--herbe-paper)] focus:outline-none'

const primaryButtonClass =
  'rounded-[var(--ui-comfy-radius-btn)] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50'

const secondaryButtonClass =
  'rounded-[var(--ui-comfy-radius-btn)] border border-[var(--border)] bg-[var(--herbe-bone)] px-4 py-2 text-sm font-semibold text-[var(--herbe-ink)] disabled:opacity-50'

export function WorksheetStepper({
  worksheetId,
  status,
  workDescription: initialWorkDescription,
  labels,
}: WorksheetStepperProps) {
  const router = useRouter()
  const [workDescription, setWorkDescription] = useState(initialWorkDescription)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const actions = NEXT_ACTIONS[status] ?? []

  async function handleTransition(to: WorksheetStatus) {
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/worksheets/${worksheetId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, workDescription }),
      })

      if (!res.ok) {
        setError(labels.errorGeneric)
        return
      }

      router.refresh()
    } catch {
      setError(labels.errorGeneric)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-[var(--herbe-ink)]">
        {labels.workDescriptionLabel}
        <textarea
          value={workDescription}
          onChange={(event) => setWorkDescription(event.target.value)}
          rows={6}
          className={fieldClass}
        />
      </label>

      {error ? <p className="text-sm text-[var(--status-danger-fg)]">{error}</p> : null}

      {actions.length > 0 ? (
        <div className="flex gap-2">
          {actions.map((action) => {
            const isPrimary = action.to === 'Done' || actions.length === 1
            return (
              <button
                key={action.to}
                type="button"
                disabled={submitting}
                onClick={() => handleTransition(action.to)}
                className={isPrimary ? primaryButtonClass : secondaryButtonClass}
              >
                {labels[action.labelKey]}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
