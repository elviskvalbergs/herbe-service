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
import { useSyncExternalStore } from 'react'
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

// navigator.onLine is exactly the "external mutable value" useSyncExternalStore
// exists for (it's React's own canonical example) — it subscribes to the
// online/offline events and re-renders on change, with no manual
// useState+useEffect wiring (which would call setState synchronously inside
// an effect, flagged by this repo's react-hooks lint rule).
function subscribe(callback: () => void) {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}

function getSnapshot() {
  return navigator.onLine
}

// `navigator` doesn't exist during SSR — assume online for the
// server-rendered / pre-hydration snapshot, corrected on the client's first
// paint once getSnapshot can actually read navigator.onLine.
function getServerSnapshot() {
  return true
}

export function SyncStatusChip() {
  const online = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
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
