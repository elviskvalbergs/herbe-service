'use client'

// Field shell bottom tab bar (doc07 "Two shells, one app" — "Bottom tab bar:
// Today · Jobs · Scan(P1) · Inbox · More"). Hand-rolled with next/link +
// usePathname() per Task 5's brief — simple enough that forcing a shadcn
// primitive would add indirection without benefit.
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export interface FieldTab {
  key: string
  href: string
  label: string
}

export const FIELD_TABS: FieldTab[] = [
  { key: 'today', href: '/today', label: 'Today' },
  { key: 'jobs', href: '/jobs', label: 'Jobs' },
  { key: 'scan', href: '/scan', label: 'Scan' },
  { key: 'inbox', href: '/inbox', label: 'Inbox' },
  { key: 'more', href: '/more', label: 'More' },
]

// Pure and exported so it's unit-testable without a DOM/hook renderer (see
// app/layout.test.tsx for why this project's Vitest setup can't render
// `usePathname()`-based components directly). A tab stays highlighted for
// routes nested under it (e.g. a future /jobs/[id] detail keeps Jobs active).
export function isTabActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function FieldTabBar() {
  const pathname = usePathname()

  return (
    <nav aria-label="Primary" className="grid grid-cols-5 border-t border-[var(--border)] bg-[var(--bg)]">
      {FIELD_TABS.map((tab) => {
        const active = isTabActive(pathname, tab.href)
        return (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className="flex flex-col items-center justify-center text-xs font-medium"
            style={{
              height: 'var(--ui-field-btn-h-sm)',
              // amber product accent (--product-service) for the active
              // state, not --accent (herbe-red is brand-mark + destructive
              // only, suite-wide non-negotiable per doc07) — amber is also
              // the token calibrated for field/hi-vis readability (doc 14
              // §6), which fits a tab bar meant to be read in sunlight.
              color: active ? 'var(--product-service)' : 'var(--fg-muted)',
            }}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
