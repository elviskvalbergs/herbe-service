// app/(office)/c/[companyId]/orders/page.tsx
//
// PLACEHOLDER (Task 6 scope: nav + chrome only). doc07 O1 "Orders list" —
// real content (filterable register list, create order) is a later WS's
// job. Auth/role/tenant gating happens once in the parent layout.tsx, not
// per-page here (see that file's header comment) — note that layout.tsx's
// gate only requires dispatcher/back_office/admin, not the 'order:view_all'
// capability specifically (nav visibility in office-nav.tsx is not route
// access control); the real orders page will need its own additional
// 'order:view_all'-only check once it has content worth restricting.
export default function OrdersPage() {
  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">Orders</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
    </main>
  )
}
