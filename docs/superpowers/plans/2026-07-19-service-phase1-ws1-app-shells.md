# WS1 — App shells + push: slice plan

Status: FINAL (2026-07-19). Branch `feature/service-phase1-ws1-app-shells`, cut from
`origin/preview` @ `ba274f6`. Assignment per `docs/25-parallel-session-kickoff-prompt.md`,
scope per `docs/24-phase1-status-and-parallel-handoff.md` §1/§4 item 0 (corrected WS1 row)
and `docs/21-phase-1-implementation-plan.md` §4 WS1.

## 0. Reality check before scoping (why this plan is narrower than doc 21's WS1 prose)

Read from source, not assumed:

- `app/` is the literal `create-next-app` output plus Phase-1 API routes bolted on — one
  page (`app/(app)/customers/page.tsx`), root `layout.tsx` still has Geist fonts and the
  default metadata title. No shell, no navigation, no role-based routing exists.
- `next-intl` and `@ducanh2912/next-pwa` are already wired at the **config** level
  (`next.config.ts` composes both plugins; `lib/i18n/request.ts` + 7 locale JSON files
  exist), but nothing in `app/` actually renders through `NextIntlClientProvider` or
  reads a locale — the plumbing is there, the connection isn't.
- The offline substrate (`lib/offline/db.ts`, `lib/offline/sync-client.ts`) is a P0
  spike: **one entity (customers), upsert-only**, ~55 lines total. `scope_membership`
  and `outbox_ops` tables exist in the schema but nothing produces a "conflict" state —
  `outboxOps.status` is `pending | applied | failed`, no `conflict` value, no conflict-task
  entity anywhere in the domain layer or schema.
- WS8 (order/worksheet status machine) is domain-logic-only (`lib/domain/worksheet-status.ts`
  et al. are pure functions) — no persistence, no route, no rejection→inbox wiring exists
  yet. F10 Inbox's "assignment notifications, manager rejection comments" content is
  explicitly a **WS9** deliverable (doc 21 §4 WS9), not WS1's.
- No `web-push` dependency, no VAPID config, no push-subscription table anywhere.
- `herbe-design-system/handovers/SERVICE.md`, which `docs/14-design-handoff.md` claims
  "has landed", **does not exist** in the local `herbe-design-system` checkout (only
  `CALENDAR.md`, `PORTAL.md`, `PRESENTATIONS.md` are present). `tokens.css` has no
  field-density tier, no sunlight/high-contrast scheme, no sync-state/charge-type/
  work-entry-mode/revision-state tokens, and no `--product-service` accent — doc 14 §1's
  gap list is still fully open. Building these is this session's job, done inside
  herbe-service (not by editing the shared design-system repo, which is out of this
  session's authority and affects two sibling apps).

Consequence: "field shell" and "office shell" mean **navigational chrome + design tokens +
role routing + route stubs**, not the F1–F11 / O1–O11 feature content (that's WS9's and
each register-owning WS's job, per doc 21 §4 — WS1 depends on nothing but P0, and
"gates the UI parts of WS2/WS9/WS10" per doc 24 §4 item 0, i.e. WS1 is the floor they build
on, not the finished rooms).

## 1. Scope — FINAL

**In scope, this slice:**

1. Design tokens: a herbe-service-local CSS layer that imports the design-system's
   `tokens.css` semantic vocabulary and adds the field extensions doc 14 §1 asks for
   (field density tier, sunlight/high-contrast + dark scheme, sync-state colors+icons,
   charge-type badge, work-entry-mode indicator, revision-state badge, print tokens),
   plus `--product-service: var(--cat-amber)`.
2. `herbe.service` wordmark component (amber square dot), modeled on portal's
   `HerbePortalLogo` — inline SVG, Poppins-metrics-correct, no `<img>` of the
   design-system SVGs (same reasoning as herbe-portal's CLAUDE.md).
3. i18n wired end-to-end: root layout renders through `NextIntlClientProvider`;
   cookie-based locale (matches portal's approach — no `/[locale]/` URL segments);
   a `middleware.ts` (doesn't exist yet) forwarding the locale, modeled on portal's.
4. Role-based landing routing: `/` resolves the signed-in user's role
   (`getVerifiedSession`) to the field shell (`technician`, `team_lead`) or office shell
   (`dispatcher`, `back_office`, `admin`); `team_lead` gets an explicit switch affordance
   (doc 07: "users with both hats can switch").
5. Field shell: bottom tab bar (Today · Jobs · Scan · Inbox · More), persistent
   sync-status chip in the header, one route per tab. Tab content is an honest
   placeholder (not fake feature content) except where §1 items 7–8 below wire real data.
6. Office shell: collapsible sidebar + mobile drawer (portal's admin-shell pattern —
   dark sidebar, light content surface) + company switcher (`/c/[companyId]` scoping,
   portal's pattern per doc 07), nav sections per doc 07 (Dispatch · Orders · Worksheets ·
   Customers · Service items · Stock · Reports · Settings/Admin), each gated by
   `hasCapability` and rendered as a route stub.
7. Briefcase ("download my work") UI: a real component in the field shell's More tab,
   entity-agnostic (a list of scope buckets + counts + last-sync time), wired to what
   actually exists today (`scope_membership` row count for the user, `outbox_ops` pending
   count, Dexie `customers` count/last-sync) — not fabricated order/worksheet/photo data.
   Designed so WS7/WS8/WS9 register more buckets later without a rewrite.
8. Conflict inbox: a real component in the field shell's Inbox tab, wired to the only
   "bounced" concept that exists today — `outbox_ops` rows with `status = 'failed'` — with
   a retry action (replays the POST) and an empty state. Explicitly not a new conflict-task
   domain entity (that's WS8/WS9's job once worksheet rejection exists); the data-source
   function is a small seam (`getInboxItemsForUser`) so WS8 can add a second source later.
9. Web Push infrastructure: VAPID keypair generation + env config, `push_subscriptions`
   table + migration, `POST /api/push/subscribe` + `/unsubscribe`, `lib/push/send.ts`
   (`sendPushToUser`) with 410/expired-subscription cleanup, service-worker push +
   notificationclick handlers (via next-pwa's custom `swSrc`), and a client subscribe
   toggle surfaced in the field More tab and office Settings stub. Infra only — no event
   producers exist yet (WS10 booking-assign, WS4/WS8 rejection notices wire triggers later).
10. Settings: scoped down to **user-level** locale + display-scheme (standard/sunlight/
    dark) preference, persisted server-side, no tenant-admin theming UI (no consumer asks
    for per-tenant runtime theming in this slice — see §2 decision 6 below for why that's
    deliberately cut, not missed).
11. One Playwright smoke journey: app loads, manifest is installable, role-based redirect
    lands on the correct shell.

**Explicitly out of scope, deferred (goes into doc 24 §4 as new unclaimed items when this
slice lands):**

- F1–F11 / O1–O11 real feature content (WS9 and each register-owning WS).
- Persisted conflict-task entity from worksheet rejection/ERP bounce (WS8/WS9).
- Scoped replication for entities beyond `customers` (WS7/WS8/WS9 extend as their data
  lands).
- Push notification *producers* (booking assign/change — WS10; rejection notices — WS4/WS8).
- Tenant-admin runtime theming/branding UI (naturally A1 Tenant settings, WS14).
- WebAuthn/biometric unlock (already a listed WS2 deferred item, unrelated to WS1).

## 2. Design decisions — FINAL

1. **Locale strategy**: cookie (`NEXT_LOCALE`), no URL segment — matches portal, avoids
   restructuring every route under `/[locale]/`. `middleware.ts` forwards it via the
   `X-NEXT-INTL-LOCALE` header, same as portal's.
2. **Shells share one Next.js app**, route-grouped: `app/(field)/...` for the technician
   PWA shell, `app/(office)/c/[companyId]/...` for the office shell — mirrors doc 07 "one
   app, shell chosen by role" and portal's `/c/[companyId]` convention.
3. **shadcn/ui + Radix primitives** for shell chrome (Sheet for the mobile drawer, Tabs
   only where genuinely tabbed), per doc 03/14's explicit stack decision — not hand-rolled
   CSS like calendar. `npx shadcn init` runs as part of task 1.
4. **Sunlight/high-contrast mode is a manual 3-way toggle** (standard / sunlight / dark),
   not ambient-light-sensor-driven — `AmbientLightSensor` browser support is too sparse to
   build on for P1.
5. **Field tab placeholders are honest empty/coming-soon states**, not stubbed fake data —
   avoids WS9 having to rip out placeholder content that looks real.
6. **No tenant-runtime theming resolver this slice.** Portal's theming system (palette
   extraction, admin color pickers, `unstable_cache`d DB-backed resolve) solves a problem
   — per-tenant whitelabel branding configurable at runtime — that has no consumer yet in
   herbe.service (no admin UI exists to set it, no WS asked for it this phase). Building
   the resolver now would be speculative configurability the CSS tokens don't need yet.
   Static tokens ship now; a real per-tenant resolver is a WS14/A1 concern when that
   admin surface lands.
7. **Conflict inbox reads `outbox_ops.status = 'failed'` today**; no new table. Retry
   re-POSTs the stored payload to the existing outbox endpoint idempotency path.
8. **Web Push transport only** — `sendPushToUser(db, userId, payload)` is a library
   function other WS's call; this slice adds no caller beyond a manual test route
   (`POST /api/push/test`, admin-role-gated, for verifying the plumbing end-to-end).
9. **`herbe.service` wordmark**: amber square dot (`--cat-amber` / `--product-service`),
   Poppins self-hosted from the same TTFs portal already bundles (copy, not re-derive).

## 3. Task breakdown (subagent-driven, TDD, one commit per green task)

| # | Task | Key files | Test focus |
|---|---|---|---|
| 1 | Design tokens + wordmark + Poppins | `app/design-tokens.css`, `components/herbe-service-logo.tsx`, `public/fonts/*`, `components.json` (shadcn init) | Wordmark renders correct viewBox/dot color; token file has no `border-radius: 9999px`/`50%` on non-deprecated identity rules (grep-based test) |
| 2 | i18n wiring | `middleware.ts`, `app/layout.tsx`, `components/locale-switcher.tsx` | Middleware sets locale header from cookie/default; layout renders `NextIntlClientProvider` with resolved messages |
| 3 | Settings model (user prefs) | migration `NNNN_user_settings.sql`, `lib/settings/user-prefs.ts`, `app/api/settings/route.ts` | GET/PATCH round-trip; invalid scheme/locale rejected |
| 4 | Role-based root routing | `app/page.tsx`, `lib/auth/session-guard.ts` (reuse) | technician→field, dispatcher→office, team_lead sees switch, unauthenticated→login |
| 5 | Field shell chrome | `app/(field)/layout.tsx`, tab route stubs, sync-status chip | Renders 5 tabs, active-tab highlight, chip reflects online/offline (mocked) |
| 6 | Office shell chrome | `app/(office)/c/[companyId]/layout.tsx`, `components/company-switcher.tsx`, nav stubs | Sidebar renders capability-gated sections; company switcher lists user's companies; collapses to drawer under a breakpoint |
| 7 | Briefcase UI | `components/briefcase-summary.tsx`, data-loader wired to scope_membership/outbox/Dexie | Renders bucket counts from real (seeded) data; empty-state when nothing synced yet |
| 8 | Conflict inbox | `components/conflict-inbox.tsx`, `lib/inbox/get-inbox-items.ts` | Lists failed outbox ops; retry re-invokes the outbox POST; empty state when none |
| 9 | Web Push infra (server) | migration `NNNN_push_subscriptions.sql`, `app/api/push/{subscribe,unsubscribe,test}/route.ts`, `lib/push/send.ts`, VAPID env docs | subscribe/unsubscribe round-trip; send.ts drops a subscription on 410; test route is admin-gated |
| 10 | Web Push client + SW | `public/sw-push.js` (custom `swSrc`), `next.config.ts` update, `components/push-toggle.tsx` | permission/subscribe flow (mocked `pushManager`); SW push handler shows a notification (unit test via a minimal SW test harness or documented manual check if untestable in vitest) |
| 11 | Playwright smoke journey | `tests/e2e/app-shell.spec.ts` | app installs (manifest present), role redirect lands correctly, offline reload doesn't blank-screen |
| 12 | Wrap-up | `docs/24-phase1-status-and-parallel-handoff.md` | doc update only, no code |

Verification gate after every task (no exceptions, per kickoff instructions):
`pnpm exec tsc --noEmit` clean; `pnpm exec vitest run` all green;
`pnpm exec vitest run --coverage` exit 0, 90% gate on `lib/erp/**`/`lib/sync/**`/
`packages/erp-core/**` untouched by this slice (this slice's new code lives in
`lib/settings`, `lib/push`, `lib/inbox`, `components/`, `app/` — outside the gated
paths, but still needs its own meaningful test coverage per task).

No ERP-touching code in this slice (§0 above), so `tests/live/erp-contract.test.ts` is not
extended and `pnpm test:live` is not required — noted explicitly since the kickoff
instructions ask to confirm this per workstream.

## 4. References

`docs/24-phase1-status-and-parallel-handoff.md` §1/§4, `docs/21-phase-1-implementation-plan.md`
§2 (load-bearing constraints) + §4 WS1, `docs/07-ui-screens.md` (shell table + screen
inventory), `docs/14-design-handoff.md` §1–2 + §6 (wordmark), `docs/03-architecture.md`
(PWA/push/theming/scoped-replication), `docs/06-roadmap.md` P1 mobile/platform bullets.
