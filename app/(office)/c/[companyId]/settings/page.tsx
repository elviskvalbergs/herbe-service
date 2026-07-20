// app/(office)/c/[companyId]/settings/page.tsx
//
// PLACEHOLDER (Task 6 scope: nav + chrome only). doc07/05 "Settings/Admin" —
// real content (tenant settings, users/roles, ERP connections, templates,
// API tokens — the full admin console per docs/05-users-auth.md's Admin row)
// is a later WS's job. Auth/role/tenant gating happens once in the parent
// layout.tsx, not per-page here (see that file's header comment) — note
// that layout.tsx's gate only requires dispatcher/back_office/admin, not
// admin specifically, so this stub is reachable (though empty) by any office
// role today; the real settings page will need its own additional
// tenant:manage_settings-only check once it has content worth restricting.
//
// Task 10 adds the one real piece of content this stub has so far: the Web
// Push opt-in (components/push-toggle.tsx), the same component the field
// shell's More page uses.
import { PushToggle } from '@/components/push-toggle'

export default function SettingsPage() {
  return (
    <main className="flex flex-1 flex-col gap-4">
      <h1 className="text-lg font-semibold">Settings / Admin</h1>
      <p className="text-sm text-[var(--fg-muted)]">Coming soon.</p>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <PushToggle vapidPublicKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''} />
      </section>
    </main>
  )
}
