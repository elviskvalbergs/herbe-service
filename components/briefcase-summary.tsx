// components/briefcase-summary.tsx
//
// WS1 Task 7 (doc07 F11 "More" — the "download my work" briefcase). Purely
// presentational and entity-agnostic: takes a plain data-in `buckets` prop,
// no fetching of its own, so a later WS can add a bucket (e.g. an
// offline-cached-customers count once a client sub-component reads Dexie)
// without redesigning this component. No hooks — kept directly callable in
// tests the same way components/company-switcher.tsx is.
export interface BriefcaseBucket {
  label: string
  count: number
  lastSyncedAt?: Date
}

export function BriefcaseSummary({ buckets }: { buckets: BriefcaseBucket[] }) {
  const hasAnyData = buckets.some((bucket) => bucket.count > 0)

  if (!hasAnyData) {
    return <p className="text-sm text-[var(--fg-muted)]">Your briefcase is empty.</p>
  }

  return (
    <ul className="flex flex-col gap-2">
      {buckets.map((bucket) => (
        <li key={bucket.label} className="flex items-center justify-between text-sm">
          <span>{bucket.label}</span>
          <span className="font-semibold">
            {bucket.count}
            {bucket.lastSyncedAt ? ` · synced ${bucket.lastSyncedAt.toLocaleString()}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
