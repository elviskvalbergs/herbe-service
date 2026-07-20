import { describe, expect, it, vi } from 'vitest'

// `FieldTabBar` itself is a 'use client' component using `usePathname()` —
// hooks require an active React renderer, which this project's Vitest setup
// doesn't have (no jsdom/@testing-library — see app/layout.test.tsx's
// comments for the underlying constraint). `FIELD_TABS`/`isTabActive` are
// extracted as pure values/functions specifically so they stay unit-testable
// without one (same pattern as components/locale-switcher.test.ts).
//
// Merely importing the module still evaluates next/navigation's barrel
// export, which crashes under this project's forced 'react-server' resolve
// condition (see components/locale-switcher.test.ts for the full
// explanation) — so it needs a stub here purely to make the module loadable.
// next/link is a plain component reference (never invoked in this test), but
// stubbed too for the same reason (its module also isn't safe to import as-is
// under that condition).
vi.mock('next/navigation', () => ({ usePathname: () => '/today' }))
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => props }))

import { FIELD_TABS, isTabActive } from './field-tab-bar'

describe('FIELD_TABS', () => {
  it('lists the 5 field-shell tabs in doc07 order with correct hrefs', () => {
    expect(FIELD_TABS.map((tab) => ({ label: tab.label, href: tab.href }))).toEqual([
      { label: 'Today', href: '/today' },
      { label: 'Jobs', href: '/jobs' },
      { label: 'Scan', href: '/scan' },
      { label: 'Inbox', href: '/inbox' },
      { label: 'More', href: '/more' },
    ])
  })

  it('gives every tab a unique key', () => {
    const keys = FIELD_TABS.map((tab) => tab.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('isTabActive', () => {
  it('is active for an exact route match', () => {
    expect(isTabActive('/jobs', '/jobs')).toBe(true)
  })

  it('is active for a nested route', () => {
    expect(isTabActive('/jobs/123', '/jobs')).toBe(true)
  })

  it('is not active for a sibling route with a shared prefix', () => {
    expect(isTabActive('/jobsx', '/jobs')).toBe(false)
  })

  it('is not active for an unrelated route', () => {
    expect(isTabActive('/today', '/jobs')).toBe(false)
  })
})
