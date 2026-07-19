'use client'

// Field shell header chip (doc07 "Two shells, one app" — "Persistent
// sync-status chip (synced / pending-ops count / offline) in the header").
//
// Task 5 scope: only two of the four documented states are wired to a real
// signal today — `offline` (navigator.onLine / the browser's online/offline
// events) and a placeholder `synced` for everything else. `pending-N-ops`
// needs a client-side outbox to count against, which doesn't exist yet
// (Task 7's briefcase data loader is the first thing to introduce local
// offline storage for field data); `syncing` needs an actual in-flight sync
// call to observe. Both are deferred rather than faked — this repo's rule
// against fake placeholder content (plan §2 decision 5) applies to status
// chips as much as it does to lists of jobs.
import { useEffect, useState } from 'react'
import { CloudCheck, CloudOff } from 'lucide-react'

export type SyncState = 'offline' | 'synced'

export interface SyncStatusDisplay {
  state: SyncState
  label: string
  colorVar: string
}

// Pure and exported so it's unit-testable without a DOM/hook renderer (this
// project's Vitest setup has neither — see app/layout.test.tsx for why).
// design-tokens.css's sync-state vocabulary: `--sync-local` is "stored on
// this device only" (cloud-off icon) — the correct semantic for "we have no
// connectivity, nothing has synced" — while `--sync-synced` is "confirmed
// synced" (cloud-check icon).
export function deriveSyncStatus(online: boolean): SyncStatusDisplay {
  if (!online) {
    return { state: 'offline', label: 'Offline', colorVar: 'var(--sync-local)' }
  }
  return { state: 'synced', label: 'Synced', colorVar: 'var(--sync-synced)' }
}

export function SyncStatusChip() {
  // Assume online for the initial (server-rendered + first client paint)
  // render so hydration has a fixed, predictable value — `navigator` doesn't
  // exist during SSR, and reading it eagerly here would mismatch whatever
  // the server rendered. The effect below corrects it immediately after
  // mount and on every subsequent online/offline transition.
  const [online, setOnline] = useState(true)

  useEffect(() => {
    setOnline(navigator.onLine)
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const { state, label, colorVar } = deriveSyncStatus(online)
  const Icon = state === 'offline' ? CloudOff : CloudCheck

  return (
    <span
      data-testid="sync-status-chip"
      data-state={state}
      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium"
      style={{ color: colorVar }}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </span>
  )
}
