// app/(field)/inbox/page.tsx
//
// doc07 F10 "Inbox" — conflict tasks (bounced transitions, sync rejections).
// Task 8's real source: failed outbox_ops rows
// (lib/inbox/get-inbox-items.ts), rendered by components/conflict-inbox.tsx
// with a retry action. Assignment notifications and manager rejection
// comments aren't sourced from anywhere yet — still an honest gap, not
// faked (plan §2 decision 5).
//
// getInboxItemsForUser is tenant-scoped, not truly per-user (outbox_ops has
// no userId column — confirmed in drizzle/schema.ts) — a known limitation,
// same as lib/offline/briefcase-summary.ts's "pending sync" bucket.
//
// Gates on session itself (not just via a parent redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so every route gates itself (getVerifiedSession) the same way
// app/(field)/today/page.tsx does.
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { FIELD_ROLES, type Role } from '@/lib/auth/roles'
import { getInboxItemsForUser } from '@/lib/inbox/get-inbox-items'
import { ConflictInbox } from '@/components/conflict-inbox'

export default async function InboxPage() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }
  if (!FIELD_ROLES.includes(session.user.role as Role)) {
    redirect('/')
  }

  const items = await getInboxItemsForUser(db, session.user.tenantId)

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold">Inbox</h1>
      <ConflictInbox items={items} />
    </main>
  )
}
