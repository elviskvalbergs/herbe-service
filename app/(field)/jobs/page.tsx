// app/(field)/jobs/page.tsx
//
// PLACEHOLDER (Task 5 scope: page chrome only). doc07 F2 "My jobs" — a
// day/week calendar + list of the technician's own bookings and unplanned
// worksheets. That data isn't wired up yet, so this is an honest "coming
// soon" state rather than a fake job list (plan §2 decision 5).
//
// Gates on session itself (not just via a parent redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so every route gates itself (getVerifiedSession) the same way
// app/(field)/today/page.tsx does.
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'

export default async function JobsPage() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold">Jobs</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
    </main>
  )
}
