// app/(office)/c/[companyId]/reports/page.tsx
//
// PLACEHOLDER (Task 6 scope: nav + chrome only). doc07 O10 "Reports" — real
// content (utilization, first-time-fix, MTTR, revenue/technician) is Phase 2
// per doc07, a later WS's job. Auth/role/tenant gating happens once in the
// parent layout.tsx, not per-page here (see that file's header comment).
export default function ReportsPage() {
  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">Reports</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
    </main>
  )
}
