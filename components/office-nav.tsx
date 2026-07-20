'use client'

// Office shell sidebar nav (doc07 "Two shells, one app" — office shell
// sections: Dispatch(P1) · Orders · Worksheets · Customers · Service items ·
// Stock(P1) · Reports(P2) · Settings/Admin). Same shape as
// components/field-tab-bar.tsx: pure data/functions exported for hook-free
// testing (this project has no jsdom/@testing-library — see
// components/locale-switcher.test.ts), the component itself is 'use client'
// only for usePathname()'s active-route highlighting.
//
// Each section is gated by hasCapability(role, capability) (lib/auth/roles.ts)
// rather than a hardcoded role list, so a future capability change (e.g. a
// tenant flag granting team_lead worksheet approval, docs/05-users-auth.md)
// only needs a ROLE_CAPABILITIES edit, not a nav-code edit.
//
// Two sections have no cleanly-matching capability in the current Capability
// union (flagged per the brief rather than inventing a new one):
//  - Service items: docs/07-ui-screens.md O7 groups "Customers / sites /
//    service items registers" as ONE back-office register set — reuses
//    'customer:edit', the capability already gating the sibling Customers
//    section, since the doc treats them as a single editable group.
//  - Stock: no stock-specific capability exists; 'item:edit' (back_office) is
//    the closest existing match (stock = levels of catalog items) but it's a
//    judgment call, not a precise fit.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { hasCapability, type Capability, type Role } from '@/lib/auth/roles'

export interface OfficeNavSection {
  key: string
  label: string
  href: (companyId: string) => string
  capability: Capability
}

export const OFFICE_NAV_SECTIONS: OfficeNavSection[] = [
  { key: 'dispatch', label: 'Dispatch', href: (companyId) => `/c/${companyId}/dispatch`, capability: 'dispatch:manage' },
  { key: 'orders', label: 'Orders', href: (companyId) => `/c/${companyId}/orders`, capability: 'order:view_all' },
  { key: 'worksheets', label: 'Worksheets', href: (companyId) => `/c/${companyId}/worksheets`, capability: 'worksheet:approve' },
  { key: 'customers', label: 'Customers', href: (companyId) => `/c/${companyId}/customers`, capability: 'customer:edit' },
  { key: 'service-items', label: 'Service items', href: (companyId) => `/c/${companyId}/service-items`, capability: 'customer:edit' },
  { key: 'stock', label: 'Stock', href: (companyId) => `/c/${companyId}/stock`, capability: 'item:edit' },
  { key: 'reports', label: 'Reports', href: (companyId) => `/c/${companyId}/reports`, capability: 'report:view' },
  { key: 'settings', label: 'Settings/Admin', href: (companyId) => `/c/${companyId}/settings`, capability: 'tenant:manage_settings' },
]

// Pure and exported so it's unit-testable without a DOM/hook renderer.
export function getVisibleNavSections(role: Role): OfficeNavSection[] {
  return OFFICE_NAV_SECTIONS.filter((section) => hasCapability(role, section.capability))
}

// Same nested-route semantics as field-tab-bar.tsx's isTabActive.
export function isNavSectionActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function OfficeNavList({ role, companyId }: { role: Role; companyId: string }) {
  const pathname = usePathname()
  const sections = getVisibleNavSections(role)

  return (
    <nav aria-label="Office" className="flex flex-col gap-0.5">
      {sections.map((section) => {
        const href = section.href(companyId)
        const active = isNavSectionActive(pathname, href)
        return (
          <Link
            key={section.key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className="px-2 py-1.5 text-sm font-medium"
            style={{ color: active ? 'var(--product-service)' : 'rgba(255,255,255,0.72)' }}
          >
            {section.label}
          </Link>
        )
      })}
    </nav>
  )
}
