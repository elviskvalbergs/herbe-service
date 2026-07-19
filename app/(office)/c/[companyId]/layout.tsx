// app/(office)/c/[companyId]/layout.tsx
//
// Office shell chrome (doc07 "Two shells, one app" — office shell: left
// sidebar, collapsible to a mobile drawer, sections Dispatch/Orders/
// Worksheets/Customers/Service items/Stock/Reports/Settings-Admin). Modeled
// on herbe-portal's admin shell (~/AI/herbe-portal/app/(admin)/admin/layout.tsx
// + components/admin-nav.tsx, read-only reference): dark-surface sidebar,
// light content area. Unlike that reference, portal's admin-sidebar only
// collapses to an icon rail on narrow viewports (CSS media query, no actual
// drawer) — this task's brief explicitly calls for a real off-canvas drawer
// via shadcn's Sheet component below the md breakpoint, so that's what's
// built here instead of copying portal's icon-rail behavior verbatim.
//
// GATING (this is the fix Task 4's own review flagged): the placeholder page
// this layout now wraps (./page.tsx) had only a session check — no role
// check, no verification that :companyId actually belongs to the caller's
// tenant. Both checks live HERE rather than duplicated across page.tsx and
// the 8 nav-section stub pages, for two reasons: (1) every route under this
// segment needs the same two checks, and duplicating a DB-backed check 9x
// per request is worse than the layout doing it once; (2) this layout
// already needs the tenant's active company list for the switcher below, so
// it's already paying for a DB round trip in this exact shape. This is a
// deliberate divergence from app/(field)/*'s per-page session gate (that
// shell's layout is a plain hook-free function by design, so field pages
// each gate themselves) — office's layout is async already (it has to be, to
// resolve company data), so centralizing here doesn't cost anything a
// per-page gate wouldn't already cost.
import { redirect, notFound } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import type { Role } from '@/lib/auth/roles'
import { HerbeServiceLogo } from '@/components/herbe-service-logo'
import { OfficeNavList } from '@/components/office-nav'
import { CompanySwitcher, type OfficeCompanyOption } from '@/components/company-switcher'
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetTrigger } from '@/components/ui/sheet'

// technician/team_lead are field-shell roles (app/page.tsx's role branch) —
// a direct navigation into /c/:companyId from either must not render office
// chrome, hence redirect('/') rather than notFound(): '/' re-routes them to
// their actual shell instead of a dead end.
const OFFICE_ROLES: Role[] = ['dispatcher', 'back_office', 'admin']

export default async function OfficeLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ companyId: string }>
}) {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  const role = session.user.role as Role
  if (!OFFICE_ROLES.includes(role)) {
    redirect('/')
  }

  const { companyId } = await params

  // Tenant-ownership check: an unrecognized/foreign companyId must not leak
  // any information (brief's explicit requirement) — notFound() renders the
  // same 404 whether the row doesn't exist at all or belongs to a different
  // tenant, so neither case distinguishes "wrong id" from "not yours".
  const [company] = await db
    .select({ id: schema.erpCompanies.id, tenantId: schema.erpCompanies.tenantId })
    .from(schema.erpCompanies)
    .where(eq(schema.erpCompanies.id, companyId))

  if (!company || company.tenantId !== session.user.tenantId) {
    notFound()
  }

  // Same tenant-wide resolution as app/page.tsx's resolveDefaultCompanyId —
  // no per-user company-access table exists yet, so "which companies can
  // this user see" is every active erp_companies row for the tenant.
  const companies: OfficeCompanyOption[] = await db
    .select({ id: schema.erpCompanies.id, displayName: schema.erpCompanies.displayName })
    .from(schema.erpCompanies)
    .where(and(eq(schema.erpCompanies.tenantId, session.user.tenantId), eq(schema.erpCompanies.active, true)))
    .orderBy(asc(schema.erpCompanies.createdAt))

  return (
    <div className="flex min-h-full">
      {/* Desktop sidebar — dark surface, fixed brand-forest regardless of the
          user's own light/dark/sunlight display-scheme preference (same
          fixed-pair convention as portal's .admin-sidebar, which hardcodes
          --brand-primary rather than a theme-reactive token). */}
      <aside
        aria-label="Office"
        className="hidden w-60 shrink-0 flex-col gap-4 bg-[var(--herbe-forest)] p-4 text-white md:flex"
      >
        <HerbeServiceLogo theme="dark" height={22} />
        <CompanySwitcher companies={companies} activeCompanyId={companyId} />
        <OfficeNavList role={role} companyId={companyId} />
      </aside>

      {/* Mobile drawer — same nav content, off-canvas via shadcn's Sheet
          below the md breakpoint (brief: "collapses to a mobile drawer under
          a breakpoint using shadcn's Sheet component"). */}
      <Sheet>
        <SheetTrigger asChild>
          <button
            type="button"
            aria-label="Open menu"
            className="fixed top-4 left-4 z-40 flex h-9 w-9 items-center justify-center bg-[var(--herbe-forest)] text-white md:hidden"
          >
            <span aria-hidden="true">≡</span>
          </button>
        </SheetTrigger>
        <SheetContent side="left" className="flex w-64 flex-col gap-4 bg-[var(--herbe-forest)] p-4 text-white">
          <SheetTitle className="sr-only">Office menu</SheetTitle>
          <SheetDescription className="sr-only">Company switcher and section navigation</SheetDescription>
          <HerbeServiceLogo theme="dark" height={22} />
          <CompanySwitcher companies={companies} activeCompanyId={companyId} />
          <OfficeNavList role={role} companyId={companyId} />
        </SheetContent>
      </Sheet>

      <main className="flex-1 bg-[var(--herbe-paper)] p-6 pl-16 text-[var(--herbe-ink)] md:pl-6">{children}</main>
    </div>
  )
}
