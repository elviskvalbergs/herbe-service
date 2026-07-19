// app/(field)/today/page.tsx
//
// PLACEHOLDER for Task 5 (field shell chrome). Task 4 only needs a real
// route for `/` to redirect technician/team_lead into — this is a working
// route target, not real chrome. Task 5 replaces this file's content
// wholesale with the actual field shell; nothing here is meant to survive
// that beyond the team-lead switch note (see below).
//
// Gates on session itself (not just via the `/` redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so a direct navigation to /today must be gated the same way
// every other route in this repo gates itself (getVerifiedSession).
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'

export default async function TodayPage() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  const isTeamLead = session.user.role === 'team_lead'

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold">Today</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Field shell placeholder (Task 5 builds the real view).
      </p>
      {isTeamLead ? (
        // docs/07-ui-screens.md: "users with both hats (team lead) can
        // switch". But lib/auth/roles.ts's ROLE_CAPABILITIES gives team_lead
        // none of the dispatcher-only capabilities (order:view_all,
        // dispatch:manage, etc.) — there is no office-side access today for
        // this role to switch into. This note is an honest placeholder, not
        // a functioning shell-switch; Task 5's More tab is the intended
        // permanent home for it once there's something real to point at.
        <p data-testid="team-lead-switch-note" className="text-sm">
          You have team lead access. Office-side access for team leads isn&apos;t available yet.
        </p>
      ) : null}
    </main>
  )
}
