// app/(field)/scan/page.tsx
//
// PLACEHOLDER (Task 5 scope: page chrome only). doc07 F9 "Scanner" (Phase 1)
// — QR/barcode: service item label -> F6, part barcode -> adds a row to the
// open worksheet (F4). No scanning capability exists yet, so this is an
// honest "coming soon" state rather than a fake scan flow (plan §2 decision 5).
//
// Gates on session itself (not just via a parent redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so every route gates itself (getVerifiedSession) the same way
// app/(field)/today/page.tsx does.
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { FIELD_ROLES, type Role } from '@/lib/auth/roles'

export default async function ScanPage() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }
  if (!FIELD_ROLES.includes(session.user.role as Role)) {
    redirect('/')
  }

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold">Scan</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
    </main>
  )
}
