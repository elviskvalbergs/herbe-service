// app/(office)/c/[companyId]/dispatch/page.tsx
//
// PLACEHOLDER (Task 6 scope: nav + chrome only). doc07 O5 "Dispatch board" —
// real content (day/week x technician grid, drag-and-drop bookings) is
// WS10's job. Auth/role/tenant gating happens once in the parent layout.tsx,
// not per-page here (see that file's header comment).
export default function DispatchPage() {
  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">Dispatch</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
    </main>
  )
}
