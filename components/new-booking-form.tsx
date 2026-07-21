// components/new-booking-form.tsx
//
// Task 4 (WS5-minimal booking): the office booking form. POSTs to
// /api/service-orders, then `router.refresh()` re-runs the server loader —
// same "no hand-maintained client state after a write" idiom as
// components/conflict-inbox.tsx's retry action.
//
// All labels come from props (i18n FIX-18: no hardcoded user-visible
// strings) — the server page resolves them via getTranslations('booking')
// and passes them down, since a 'use client' component can't call
// getTranslations itself.
//
// Design system: inputs use the bone fill / paper-on-focus tokens and the
// existing --ui-comfy-radius-input/--ui-comfy-radius-btn tokens (4px —
// square-first, not a pill; Principle 6) rather than an invented radius. The
// submit button uses bg-primary directly (now forest green) rather than the
// shared components/ui/button.tsx — that component pulls in radix-ui's Slot,
// which imports `useLayoutEffect`, stripped by this project's Vitest config
// under the forced 'react-server' resolve condition (same class of issue
// app/layout.test.tsx documents for next-intl's bare barrel); a plain button
// avoids that fragile import for a single submit action.
'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

export interface NewBookingFormCustomer {
  id: string
  name: string
}

export interface NewBookingFormTechnician {
  id: string
  email: string
}

export interface NewBookingFormLabels {
  customerLabel: string
  customerPlaceholder: string
  technicianLabel: string
  technicianPlaceholder: string
  descriptionLabel: string
  submitLabel: string
  errorGeneric: string
}

export interface NewBookingFormProps {
  companyId: string
  customers: NewBookingFormCustomer[]
  technicians: NewBookingFormTechnician[]
  labels: NewBookingFormLabels
}

const fieldClass =
  'h-[var(--ui-comfy-input-h)] w-full rounded-[var(--ui-comfy-radius-input)] border border-[var(--border)] bg-[var(--herbe-bone)] px-3 text-sm text-[var(--herbe-ink)] focus:bg-[var(--herbe-paper)] focus:outline-none'

export function NewBookingForm({ companyId, customers, technicians, labels }: NewBookingFormProps) {
  const router = useRouter()
  const [customerId, setCustomerId] = useState('')
  const [technicianUserId, setTechnicianUserId] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch('/api/service-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ erpCompanyId: companyId, customerId, technicianUserId, description }),
      })

      if (!res.ok) {
        setError(labels.errorGeneric)
        return
      }

      setCustomerId('')
      setTechnicianUserId('')
      setDescription('')
      router.refresh()
    } catch {
      setError(labels.errorGeneric)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-[var(--herbe-ink)]">
        {labels.customerLabel}
        <select
          required
          value={customerId}
          onChange={(event) => setCustomerId(event.target.value)}
          className={fieldClass}
        >
          <option value="" disabled>
            {labels.customerPlaceholder}
          </option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-[var(--herbe-ink)]">
        {labels.technicianLabel}
        <select
          required
          value={technicianUserId}
          onChange={(event) => setTechnicianUserId(event.target.value)}
          className={fieldClass}
        >
          <option value="" disabled>
            {labels.technicianPlaceholder}
          </option>
          {technicians.map((technician) => (
            <option key={technician.id} value={technician.id}>
              {technician.email}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm font-medium text-[var(--herbe-ink)]">
        {labels.descriptionLabel}
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={4}
          className={`${fieldClass} h-auto resize-none py-2`}
        />
      </label>

      {error ? <p className="text-sm text-[var(--status-danger-fg)]">{error}</p> : null}

      <button
        type="submit"
        disabled={submitting}
        className="self-start rounded-[var(--ui-comfy-radius-btn)] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
      >
        {labels.submitLabel}
      </button>
    </form>
  )
}
