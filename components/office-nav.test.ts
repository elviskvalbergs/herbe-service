import { describe, expect, it, vi } from 'vitest'

// `OfficeNavList` itself is a 'use client' component using `usePathname()` —
// hooks require an active React renderer, which this project's Vitest setup
// doesn't have (no jsdom/@testing-library — see app/layout.test.tsx's
// comments for the underlying constraint). `OFFICE_NAV_SECTIONS`/
// `getVisibleNavSections`/`isNavSectionActive` are extracted as pure values/
// functions specifically so they stay unit-testable without one (same
// pattern as components/field-tab-bar.test.ts).
//
// Merely importing the module still evaluates next/navigation's and
// next/link's barrel exports, which crash under this project's forced
// 'react-server' resolve condition (see components/locale-switcher.test.ts)
// — so both need a stub here purely to make the module loadable.
vi.mock('next/navigation', () => ({ usePathname: () => '/c/co-1/orders' }))
vi.mock('next/link', () => ({ default: (props: Record<string, unknown>) => props }))

import { OFFICE_NAV_SECTIONS, getVisibleNavSections, isNavSectionActive } from './office-nav'

describe('OFFICE_NAV_SECTIONS', () => {
  it('lists the 8 office-shell sections in doc07 order with correct hrefs', () => {
    expect(OFFICE_NAV_SECTIONS.map((s) => ({ label: s.label, href: s.href('co-1') }))).toEqual([
      { label: 'Dispatch', href: '/c/co-1/dispatch' },
      { label: 'Orders', href: '/c/co-1/orders' },
      { label: 'Worksheets', href: '/c/co-1/worksheets' },
      { label: 'Customers', href: '/c/co-1/customers' },
      { label: 'Service items', href: '/c/co-1/service-items' },
      { label: 'Stock', href: '/c/co-1/stock' },
      { label: 'Reports', href: '/c/co-1/reports' },
      { label: 'Settings/Admin', href: '/c/co-1/settings' },
    ])
  })

  it('gives every section a unique key', () => {
    const keys = OFFICE_NAV_SECTIONS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('getVisibleNavSections', () => {
  it('shows dispatcher only the dispatcher-capability sections (dispatch/orders/worksheets)', () => {
    expect(getVisibleNavSections('dispatcher').map((s) => s.key)).toEqual(['dispatch', 'orders', 'worksheets'])
  })

  it('shows back_office the back-office-capability sections, and NOT dispatch', () => {
    const keys = getVisibleNavSections('back_office').map((s) => s.key)
    expect(keys).toEqual(['customers', 'service-items', 'stock', 'reports'])
    expect(keys).not.toContain('dispatch')
  })

  it('shows admin every section — admin is additive (FIX-14), so it holds every nav capability', () => {
    expect(getVisibleNavSections('admin').map((s) => s.key)).toEqual([
      'dispatch',
      'orders',
      'worksheets',
      'customers',
      'service-items',
      'stock',
      'reports',
      'settings',
    ])
  })

  it('shows technician and team_lead nothing — neither role has any office-shell capability', () => {
    expect(getVisibleNavSections('technician')).toEqual([])
    expect(getVisibleNavSections('team_lead')).toEqual([])
  })
})

describe('isNavSectionActive', () => {
  it('is active for an exact route match', () => {
    expect(isNavSectionActive('/c/co-1/orders', '/c/co-1/orders')).toBe(true)
  })

  it('is active for a nested route', () => {
    expect(isNavSectionActive('/c/co-1/orders/123', '/c/co-1/orders')).toBe(true)
  })

  it('is not active for a sibling route with a shared prefix', () => {
    expect(isNavSectionActive('/c/co-1/ordersx', '/c/co-1/orders')).toBe(false)
  })

  it('is not active for an unrelated route', () => {
    expect(isNavSectionActive('/c/co-1/dispatch', '/c/co-1/orders')).toBe(false)
  })
})
