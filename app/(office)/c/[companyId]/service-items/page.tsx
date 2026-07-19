// app/(office)/c/[companyId]/service-items/page.tsx
//
// PLACEHOLDER (Task 6 scope: nav + chrome only). doc07 O7 "Customers / sites
// / service items registers" — real content is a later WS's job. Auth/role/
// tenant gating happens once in the parent layout.tsx, not per-page here
// (see that file's header comment).
export default function ServiceItemsPage() {
  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">Service items</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
    </main>
  )
}
