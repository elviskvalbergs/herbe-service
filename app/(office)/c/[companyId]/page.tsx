// app/(office)/c/[companyId]/page.tsx
//
// PLACEHOLDER for Task 6 (office shell chrome). Task 4 only needs a real
// route for `/` to redirect dispatcher/back_office/admin into — this is a
// working route target, not real chrome. Task 6 replaces this file's
// content wholesale with the actual office shell.
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
