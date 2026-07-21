// app/(field)/today/page.tsx
//
// Field shell's landing tab (Task 5; doc07 F1 "Today" — an ordered list of
// today's work: bookings and booking-less worksheets, time/customer/site/
// status). Real chrome now lives in app/(field)/layout.tsx (tab bar +
// header); the work-list itself has no data source yet (bookings/worksheet
// sync is later WS work), so this renders an honest empty state instead of
// fake job rows (plan §2 decision 5).
//
// Gates on session itself (not just via the `/` redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so a direct navigation to /today must be gated the same way
// every other route in this repo gates itself (getVerifiedSession).
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { FIELD_ROLES, type Role } from '@/lib/auth/roles'

export default async function TodayPage() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }
  if (!FIELD_ROLES.includes(session.user.role as Role)) {
    redirect('/')
  }

  const isTeamLead = session.user.role === 'team_lead'

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold">Today</h1>
      <p className="text-sm text-[var(--fg-muted)]">No jobs scheduled for today yet.</p>
      {isTeamLead ? (
        // docs/07-ui-screens.md: "users with both hats (team lead) can
        // switch". But lib/auth/roles.ts's ROLE_CAPABILITIES gives team_lead
        // none of the dispatcher-only capabilities (order:view_all,
        // dispatch:manage, etc.) — there is no office-side access today for
        // this role to switch into. This note is an honest placeholder, not
        // a functioning shell-switch. Kept here rather than moved to the new
        // More tab stub (Task 5): More has no real content yet either, and
        // bolting one substantive paragraph onto an otherwise "coming soon"
        // page would blur that page's own honest-placeholder signal. More
        // is still this note's intended permanent home once it has
        // something real (an office/company switch) to point at.
        <p data-testid="team-lead-switch-note" className="text-sm">
          You have team lead access. Office-side access for team leads isn&apos;t available yet.
        </p>
      ) : null}
    </main>
  )
}
