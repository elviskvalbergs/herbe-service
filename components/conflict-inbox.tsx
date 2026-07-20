// components/conflict-inbox.tsx
//
// doc07 F10 "Inbox" — lists InboxItems (lib/inbox/get-inbox-items.ts) with a
// retry action + empty state (Task 8). Same split as
// components/sync-status-chip.tsx / components/office-nav.tsx: the list
// rendering + empty state is `ConflictInboxList`, a plain function with no
// hooks, directly callable in tests; the retry click needs real state
// (in-flight id, last error) and a `fetch` call, which needs hooks, so that
// lives in `ConflictInbox` (default export, 'use client') — untested by
// direct invocation for the same reason SyncStatusChip/OfficeNavList aren't
// (this project's Vitest has no jsdom/@testing-library, see
// app/layout.test.tsx).
//
// Retry hits POST /api/sync/outbox/[id]/retry (NOT the original
// POST /api/sync/outbox — that route answers a retried id for an existing
// row, applied or failed, from the stored row without re-pushing; see its
// header comment). After the call settles, `router.refresh()` re-runs the
// server loader so a successfully-retried item disappears from the list
// (its status is no longer 'failed') without hand-maintained client state.
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { InboxItem } from '@/lib/inbox/get-inbox-items'

export interface ConflictInboxListProps {
  items: InboxItem[]
  onRetry: (id: string) => void
  retryingId: string | null
  retryError: { id: string; message: string } | null
}

export function ConflictInboxList({ items, onRetry, retryingId, retryError }: ConflictInboxListProps) {
  if (items.length === 0) {
    return <p className="text-sm text-[var(--fg-muted)]">No conflicts.</p>
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => {
        const isRetrying = retryingId === item.id
        const lastError = retryError?.id === item.id ? retryError.message : null

        return (
          <li key={item.id} className="flex flex-col gap-1 border-b border-[var(--border)] pb-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">
                {item.entity} · {item.op}
              </span>
              <span className="text-xs text-[var(--fg-muted)]">{item.createdAt.toLocaleString()}</span>
            </div>
            {item.errorMessage ? <p className="text-xs text-[var(--sync-conflict)]">{item.errorMessage}</p> : null}
            <button
              type="button"
              onClick={() => onRetry(item.id)}
              disabled={isRetrying}
              className="self-start text-xs font-semibold underline disabled:opacity-50"
            >
              {isRetrying ? 'Retrying…' : 'Retry'}
            </button>
            {lastError ? <p className="text-xs text-[var(--sync-conflict)]">Retry failed: {lastError}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function ConflictInbox({ items }: { items: InboxItem[] }) {
  const router = useRouter()
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<{ id: string; message: string } | null>(null)

  async function handleRetry(id: string) {
    setRetryingId(id)
    setRetryError(null)
    try {
      const res = await fetch(`/api/sync/outbox/${id}/retry`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setRetryError({ id, message: body?.error ?? `retry failed (HTTP ${res.status})` })
      }
      router.refresh()
    } catch (err) {
      setRetryError({ id, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setRetryingId(null)
    }
  }

  return <ConflictInboxList items={items} onRetry={handleRetry} retryingId={retryingId} retryError={retryError} />
}
