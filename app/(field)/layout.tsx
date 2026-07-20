// app/(field)/layout.tsx
//
// Field shell chrome (Task 5; doc07 "Two shells, one app" — Field shell:
// bottom tab bar Today/Jobs/Scan/Inbox/More + a persistent header with a
// sync-status chip). Deliberately a plain function with no hooks of its
// own, so it stays testable the way this repo tests React components
// without jsdom/@testing-library: call it directly and assert on the
// returned element tree (see app/layout.test.tsx). The hooks that active-tab
// highlighting and the online/offline signal need (usePathname(),
// navigator.onLine) live inside FieldTabBar / SyncStatusChip instead — this
// layout only references them as element types, never invokes them.
import { FieldTabBar } from '@/components/field-tab-bar'
import { SyncStatusChip } from '@/components/sync-status-chip'
import { HerbeServiceLogo } from '@/components/herbe-service-logo'

export default function FieldLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col">
      <header
        className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--bg)] px-4"
        style={{ height: 'var(--ui-field-btn-h-sm)' }}
      >
        <HerbeServiceLogo theme="light" height={24} />
        <SyncStatusChip />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
      <FieldTabBar />
    </div>
  )
}
