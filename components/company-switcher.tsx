// Office shell company switcher (doc07 "Company switcher": "Office shell:
// company selector in the sidebar header ... hidden if the tenant has only
// one company"). No per-user company-access table exists in this repo today
// (confirmed in Task 4: erp_companies scopes to tenantId only) — "which
// companies can this user see" resolves as every active erp_companies row
// for the caller's tenant, same query shape as app/page.tsx's
// resolveDefaultCompanyId. Per-user narrowing is a gap for a later WS.
//
// A plain function component (no hooks) — the active company is passed in as
// a prop rather than read from the route, so this stays directly callable in
// tests the same way app/(field)/layout.tsx's FieldLayout is (see that file's
// header comment for why this project tests components this way).
import Link from 'next/link'

export interface OfficeCompanyOption {
  id: string
  displayName: string
}

export function CompanySwitcher({
  companies,
  activeCompanyId,
}: {
  companies: OfficeCompanyOption[]
  activeCompanyId: string
}) {
  if (companies.length <= 1) return null

  return (
    <nav aria-label="Company" className="flex flex-col gap-0.5 border-b border-white/10 pb-3">
      {companies.map((company) => {
        const active = company.id === activeCompanyId
        return (
          <Link
            key={company.id}
            href={`/c/${company.id}`}
            aria-current={active ? 'page' : undefined}
            className="truncate px-2 py-1 text-xs font-semibold"
            style={{ color: active ? '#FFFFFF' : 'rgba(255,255,255,0.72)' }}
          >
            {company.displayName}
          </Link>
        )
      })}
    </nav>
  )
}
