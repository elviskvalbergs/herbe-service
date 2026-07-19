// app/(office)/c/[companyId]/worksheets/page.tsx
//
// PLACEHOLDER (Task 6 scope: nav + chrome only). doc07 O3/O4 "Worksheet
// approval queue" / "Worksheet review" — real content (approve/reject queue,
// full worksheet read-out) is WS8's job. Auth/role/tenant gating happens
// once in the parent layout.tsx, not per-page here (see that file's header
// comment).
export default function WorksheetsPage() {
  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">Worksheets</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
    </main>
  )
}
