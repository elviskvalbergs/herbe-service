// app/(office)/c/[companyId]/page.tsx
//
// PLACEHOLDER (Task 4 created this; Task 6 built the real office shell
// chrome around it). Task 4's own review flagged this file for having no
// role check and no tenant-ownership check on :companyId — Task 6 added
// both, but in the parent layout.tsx rather than here: every route nested
// under this segment needs the same two checks, so the layout (which is
// async already, to load the switcher's company list) is the natural single
// place for them rather than duplicating a DB-backed check in this file and
// each of the 8 nav-section stub pages. This page's own session-only gate
// below is therefore redundant for a request that already passed the
// layout's stronger gate (harmless extra DB round trip, same known/deferred
// tradeoff noted in .superpowers/sdd/progress.md re: getVerifiedSession
// being called multiple times per request) — left in place rather than
// removed, since removing it isn't part of this task's brief (chrome + nav
// stubs + gating in the layout) and this file otherwise still needs its own
// dashboard content from a later task.
//
// Gates on session itself (not just via the `/` redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so a direct navigation to /c/{companyId} must be gated the
// same way every other route in this repo gates itself (getVerifiedSession).
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'

export default async function CompanyHomePage({ params }: { params: Promise<{ companyId: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  const { companyId } = await params

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold">Office</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {'Office shell placeholder for company ' + companyId + ' (Task 6 builds the real view).'}
      </p>
    </main>
  )
}
