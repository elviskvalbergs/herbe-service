// app/(field)/more/page.tsx
//
// doc07 F11 "More / profile". Task 7 gave this page its first real content:
// the "download my work" briefcase summary (scope_membership + outbox_ops
// counts, lib/offline/briefcase-summary.ts). Task 2's standalone
// LocaleSwitcher (components/locale-switcher.tsx) is now wired in as its own
// section — it's a complete, zero-required-props client component
// (useLocale() reads the NextIntlClientProvider context set up in
// app/layout.tsx internally). Still an honest placeholder for what's
// genuinely unbuilt — device info, offline PIN/biometric lock, sign out
// (push toggle, Task 10) — kept as one plain "coming soon" line below the two
// real sections rather than 3 stub rows, so those tasks can each add their
// own section without fighting this one's structure.
//
// Gates on session itself (not just via a parent redirect): this repo has no
// centralized route-level auth guard (proxy.ts only forwards locale — see
// that file), so every route gates itself (getVerifiedSession) the same way
// app/(field)/today/page.tsx does.
import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { BriefcaseSummary } from '@/components/briefcase-summary'
import { getBriefcaseSummary } from '@/lib/offline/briefcase-summary'
import { LocaleSwitcher } from '@/components/locale-switcher'

export default async function MorePage() {
  const session = await getVerifiedSession(db)
  if (!session) {
    redirect('/login')
  }

  const buckets = await getBriefcaseSummary(db, { userId: session.user.id, tenantId: session.user.tenantId })

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-lg font-semibold">More</h1>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Your briefcase</h2>
        <BriefcaseSummary buckets={buckets} />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Language</h2>
        <LocaleSwitcher />
      </section>
      <p className="text-sm text-[var(--fg-muted)]">
        Device info, offline PIN/biometric lock, and sign out are coming soon.
      </p>
    </main>
  )
}
