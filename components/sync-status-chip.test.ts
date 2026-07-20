import { describe, expect, it, vi } from 'vitest'

// `SyncStatusChip` itself is a 'use client' component using
// `useState`/`useEffect` to observe `navigator.onLine` — hooks require an
// active React renderer, which this project's Vitest setup doesn't have (no
// jsdom/@testing-library — see app/layout.test.tsx's comments for the
// underlying constraint). `deriveSyncStatus` is extracted as a pure function
// specifically so the online/offline mapping stays unit-testable without one
// (same pattern as components/locale-switcher.test.ts's buildLocaleCookie).
//
// Merely importing the module still evaluates lucide-react's module-level
// `React.createContext` call (its icon context provider), which crashes
// under this project's forced 'react-server' resolve condition — the same
// class of issue as next-intl/next-navigation (see
// components/locale-switcher.test.ts) — so it needs a stub here purely to
// make the module loadable.
vi.mock('lucide-react', () => ({ CloudOff: 'svg', CloudCheck: 'svg' }))

import { deriveSyncStatus } from './sync-status-chip'

describe('deriveSyncStatus', () => {
  it('reports offline (mapped to --sync-local) when navigator.onLine is false', () => {
    expect(deriveSyncStatus(false)).toEqual({
      state: 'offline',
      label: 'Offline',
      colorVar: 'var(--sync-local)',
    })
  })

  it('reports a synced placeholder (mapped to --sync-synced) when online', () => {
    // Task 5 scope: no client-side outbox exists yet to derive a real
    // pending-ops count from (that lands with Task 7's briefcase data
    // loader) — every online state reads as "synced" for now.
    expect(deriveSyncStatus(true)).toEqual({
      state: 'synced',
      label: 'Synced',
      colorVar: 'var(--sync-synced)',
    })
  })
})
