// app/page.tsx
//
// Task 4: role-based root routing. `/` resolves the verified session
// (lib/auth/session-guard.ts) and branches on `session.user.role`
// (lib/auth/roles.ts's 5 roles):
//  - no session -> /login. That page doesn't exist yet in this repo (see
//    docs/24-phase1-status-and-parallel-handoff.md §5 — authConfig already
//    sets `pages.signIn = '/login'`, but there is no route there). Building
//    the actual login page is WS1/WS9 frontend work, out of this task's
//    scope — redirecting to a not-yet-built route is correct and expected.
//  - technician | team_lead -> /today, the field shell's default route
//    (Task 5 creates app/(field)/today/page.tsx — a minimal placeholder is
//    created by this task so the redirect lands on a real route).
//  - dispatcher | back_office | admin -> /c/{companyId}, the office shell's
//    default route (Task 6 creates app/(office)/c/[companyId]/page.tsx —
//    same placeholder treatment), where companyId is the tenant's default
//    ERP company (see resolveDefaultCompanyId below).
import { redirect } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import type { Role } from '@/lib/auth/roles'

const FIELD_LANDING = '/today'

export default async function Home() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  const role = session.user.role as Role

  // team_lead: doc 05's role table gives this role no dispatcher-only
  // capability (order:view_all, dispatch:manage, etc. — lib/auth/roles.ts
  // ROLE_CAPABILITIES) — it's technician + team-management within the field
  // context. So it lands on the same field shell as technician, not the
  // office shell; there is no real office access to send it to today. The
  // "switch" affordance docs/07-ui-screens.md describes for dual-hat users
  // is implemented in the /today placeholder itself (an honest note, not a
  // functioning switch — see that file).
  if (role === 'technician' || role === 'team_lead') {
    redirect(FIELD_LANDING)
  }

  const companyId = await resolveDefaultCompanyId(session.user.tenantId)
  if (!companyId) {
    return <NoCompanyAccess />
  }

  redirect(`/c/${companyId}`)
}

// There is no per-user company-access table in this repo today —
// `erp_companies` scopes to `tenantId` only, not to individual users.
// docs/05-users-auth.md ("users are tenant-level, get access per company,
// and switch the active company in the UI") describes a target model that
// isn't built yet. So "which companies can this user see" resolves today as
// simply "every active erp_companies row for the user's tenant" — no
// per-user narrowing. That's a known gap for a later WS, not something this
// task has scope to fix.
//
// Ordering: oldest active company first (asc createdAt) — this repo has no
// existing convention for picking a "default" company among several
// (app/api/sync/outbox/route.ts's single-company lookup has no ORDER BY at
// all), so oldest-first was chosen as the most stable, deterministic option.
async function resolveDefaultCompanyId(tenantId: string): Promise<string | null> {
  const [company] = await db
    .select({ id: schema.erpCompanies.id })
    .from(schema.erpCompanies)
    .where(and(eq(schema.erpCompanies.tenantId, tenantId), eq(schema.erpCompanies.active, true)))
    .orderBy(asc(schema.erpCompanies.createdAt))
    .limit(1)

  return company?.id ?? null
}

// Real edge case per the brief: an office-role user whose tenant has zero
// active ERP companies. Rendered in place rather than redirected to a new
// route — there's nothing further to build for this task to redirect into,
// and adding one would be scope creep beyond "an honest message".
function NoCompanyAccess() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-lg font-semibold">No company access yet</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Your account isn&apos;t connected to an ERP company yet. Contact your administrator.
      </p>
    </main>
  )
}
