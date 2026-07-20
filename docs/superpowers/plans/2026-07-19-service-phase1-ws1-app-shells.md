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

Each task below is independently implementable and reviewable in sequence (1→12); later
tasks depend on route groups / components earlier tasks create, noted inline.

### Task 1 — Design tokens + wordmark + Poppins

No dependencies (first task). Add a herbe-service-local CSS layer,
`app/design-tokens.css`, imported from `app/globals.css` (after Tailwind's own import),
that defines the design-system semantic vocabulary herbe-service needs plus the
service-only field extensions doc 14 §1 asks for and doc 21 §4 WS1 lists as a deliverable:

- Copy the relevant `--herbe-*`/`--status-*`/`--cat-*`/density-tier custom properties
  from `~/AI/herbe-design-system/tokens.css` (read that file — it's outside this repo,
  read-only reference) that herbe-service actually needs (base palette, `--bg`/`--fg`/
  border/status roles, the `--ui-comfy-*` tier for office surfaces).
  Do **not** copy the whole file verbatim if parts are irrelevant (marketing hero sizes,
  calendar-only categorical colors beyond what's used) — copy what herbe-service consumes,
  matching the calendar's "semantic layer over the brand palette" approach doc 14 §1
  describes, not a byte-for-byte mirror.
- Add `--product-service: var(--cat-amber);` (doc 14 §6 — the service accent, not yet
  in the shared tokens.css).
- Add a new density tier `--ui-field-*` (analogous shape to the existing
  `--ui-dense-*`/`--ui-comfy-*` presets in tokens.css): `--ui-field-btn-h: 56px`
  (primary actions 56-64px per doc 14 §1 "Field-mode sizing scale"; use 56px),
  `--ui-field-btn-h-sm: 48px` (minimum touch target), `--ui-field-input-h: 56px`,
  `--ui-field-body: 17px` (enlarged type scale for arm's-length reading),
  `--ui-field-radius-btn`/`--ui-field-radius-card`: reuse `--radius-lg`/`--radius-xl`
  (no new radius values needed — do not invent circular/pill radii, Principle 6 in the
  portal's design-system rules applies suite-wide: no `border-radius: 50%` or `9999px`
  on identity/UI elements).
- Add a sunlight scheme: `[data-scheme="sunlight"]` selector overriding `--bg`, `--fg`,
  `--border`, `--accent` to a high-contrast set (target ≥7:1 contrast text/controls —
  e.g. pure white `--bg: #FFFFFF`, near-black `--fg: #000000`, a darkened accent so it
  still passes contrast on white). Reuse the existing `[data-theme="dark"]` block in
  the copied tokens for the dark scheme — don't build a second dark implementation.
- Add sync-state tokens: `--sync-local`, `--sync-pending`, `--sync-synced`,
  `--sync-conflict` (four colors, colorblind-safe — pair each with a documented icon
  name in a code comment since CSS can't enforce icon+color pairing, e.g.
  `/* pair with a "cloud-off" icon */`). Map onto existing `--status-*` tokens where
  sensible (e.g. `--sync-conflict: var(--status-danger)`) rather than inventing new hex
  values — reuse the vocabulary, don't fork it.
- Add a charge-type badge token set: `--charge-invoiceable`, `--charge-warranty`,
  `--charge-contract`, `--charge-goodwill` (4 values, doc 02/14) — map onto `--cat-*`
  or `--status-*` tokens, don't invent new hex values.
- Add a work-entry-mode indicator token (booking / prepared-ahead / walk-up — 3 values,
  small icon-color pairing, same reuse-don't-invent rule).
- Add a revision-state badge token set: `--revision-signed`, `--revision-superseded`,
  `--revision-resign-requested`, `--revision-proceed-audited` (4 values).
- Add print tokens: a `@media print` block with header/footer spacing vars and
  `--print-severity-*` mapped from `--status-*` (doc 14 §1 "no `@media print` styling
  exists anywhere in the design-system repo" — this is genuinely net-new, keep it
  minimal: page margin, table border color, header/footer font-size vars only, no
  layout components — those come with WS12's actual PDF/report work).
- Every new custom property must be a **CSS variable reference to an existing token**
  (`var(--status-danger)` etc.) or, only where no existing token fits (sunlight scheme,
  field density, print), a literal value with a one-line comment explaining the choice.
  Never a bare literal duplicating a value that already has a name elsewhere in the file.

Wordmark component `components/herbe-service-logo.tsx`, modeled directly on herbe-portal's
`components/herbe-portal-logo.tsx` (read that file — it's in the sibling repo at
`~/AI/herbe-portal/components/herbe-portal-logo.tsx`, outside this repo, read-only
reference): same inline-SVG structure (`<text>` + `<rect>` dot, Poppins font-family,
`style={{ letterSpacing: '-0.025em' }}` — never an SVG `letter-spacing` presentation
attribute, portal's CLAUDE.md documents why: it's unitless and CSS silently drops it),
same `height` + aspect-ratio prop shape, `theme: 'dark' | 'light'`. Label text is
`"herbe.service"` conceptually but rendered as `herbe` + square dot + `service` (matching
the portal component's `herbe` + dot + `portal` layout) — dot color
`var(--product-service)` (amber, `#E08A2B`), square (`<rect>`, never `<circle>` or a
rounded shape) matching the portal component's `<rect x={116} y={37} width={7} height={7}>`
dot geometry. Since "service" is one character longer than "portal", verify the second
text element's `x` offset still reads correctly — a fixed offset copied verbatim from the
portal component may need adjusting if the tracked width differs; use the same
`fontFamily="Poppins, sans-serif" fontWeight="400" fontSize={40}` as the portal component's
second word for a consistent metric, and pick an `x` that visually clears the dot the same
way the portal version does (a small gap after the dot, same as `dot.x + dot.width` + a few
units in the portal source) — reasoned adjustment, not an invented layout.

Self-host Poppins: copy the TTF files from `~/AI/herbe-portal/public/fonts/*.ttf` (or
`~/AI/herbe-design-system/fonts/*.ttf` — same files) into this repo's `public/fonts/`,
and add the `@font-face` declarations (copy from the design-system `tokens.css` font-face
block, adjusting the `url()` path to this repo's `public/fonts/` layout) into
`app/design-tokens.css`. Remove the Geist font setup from `app/layout.tsx` and
`app/globals.css` (replaced by Poppins — this repo has no other consumer of Geist yet, so
removing it is not scope creep, it's replacing the create-next-app default with the actual
brand font this task is adding).

Run `npx shadcn init` (or the pnpm equivalent) to scaffold `components.json` +
`components/ui/` + the Tailwind v4 CSS-first shadcn setup, since doc 03/14 name
shadcn/ui + Radix as herbe-service's explicit stack decision (not hand-rolled CSS) and
later tasks (Sheet for the mobile drawer, etc.) depend on it existing. Use the
default shadcn New York style, "neutral" base color as a placeholder (this repo's palette
is applied via the CSS tokens above, not shadcn's default palette) — don't spend time
tuning shadcn's own generated theme colors, since actual colors come from the token
layer above.

**Test focus:** the wordmark component renders the correct `viewBox`, the dot's `fill`
is `var(--product-service)` (or the resolved amber hex, whichever a snapshot/DOM test
can assert), and the dot element is a `<rect>` not a `<circle>`. A grep-based test (or a
small Node test reading `app/design-tokens.css` as text) asserting the new token file
contains no `border-radius: 9999px` / `border-radius: 50%` outside a comment — matching
the portal's Principle 6 rule, since this file is this repo's first design-system
surface and should be locked from the start. Key files:
`app/design-tokens.css`, `app/globals.css` (import + Geist removal), `app/layout.tsx`
(Geist removal), `components/herbe-service-logo.tsx` (+ its test),
`public/fonts/Poppins-*.ttf`, `components.json` + `components/ui/*` (shadcn init output).

### Task 2 — i18n wiring

Depends on Task 1 only for the font/layout file existing (expect a merge-friendly diff
on `app/layout.tsx`). herbe-service already has `lib/i18n/config.ts` (locales
`lv,en,et,lt,fi,sv,no`, default `lv`) and `lib/i18n/request.ts` (`getRequestConfig`
loading `locales/<locale>.json`) — both already correct, do not modify them. What's
missing: nothing reads through them yet.

Create `middleware.ts` at the repo root (doesn't exist yet), modeled on herbe-portal's
`middleware.ts` (read `~/AI/herbe-portal/middleware.ts` — outside this repo, read-only
reference) for the locale-forwarding piece only (skip portal's auth-gate/bridge-cookie
logic entirely — that's portal-specific, herbe-service has its own auth model via
`lib/auth/session-guard.ts` and no bridge-cookie concept). Read the `NEXT_LOCALE` cookie,
validate with `isLocale` from `lib/i18n/config.ts`, fall back to `defaultLocale`, and
forward it via a request header next-intl's `getRequestConfig` can read
(`X-NEXT-INTL-LOCALE`, matching portal's constant name so the convention is recognizable
suite-wide) — `requestLocale` in `lib/i18n/request.ts` needs no change since next-intl's
own middleware convention already resolves from that header when present; verify this
by testing the actual resolved locale end to end, not by assuming the header name is
sufficient.

Update `app/layout.tsx` to call `getLocale()`/`getMessages()` from `next-intl/server` (or
resolve via the existing `getRequestConfig` wiring — check what next-intl v4's API
actually expects here, this repo is on `next-intl@^4.13.1`) and wrap `children` in
`NextIntlClientProvider` with the resolved `locale` + `messages`. Set `<html lang={locale}>`
dynamically instead of the hardcoded `"en"`.

Add `components/locale-switcher.tsx`: a small client component listing the 7 locales
(labels: native names — Latviešu, English, Eesti, Lietuvių, Suomi, Svenska, Norsk — or
locale codes if native names add ambiguity, your call, keep it simple), setting the
`NEXT_LOCALE` cookie and reloading/navigating on change. This is consumed by Task 5's
field "More" tab and Task 6's office settings stub — build it as a standalone component
now, wiring it into those pages happens in those later tasks.

**Test focus:** a unit test for the middleware's locale-resolution logic (cookie present
+ valid → that locale; cookie absent → default; cookie present + invalid locale code →
default) — test the pure resolution function if you factor one out, or the middleware
handler directly with a mocked `NextRequest`. A test that the root layout renders
`NextIntlClientProvider` and that a translated string from `locales/en.json` actually
renders when the resolved locale is `en` (an integration-style component test, not just
a prop-shape check). Key files: `middleware.ts`, `app/layout.tsx`,
`components/locale-switcher.tsx` (+ tests).

### Task 3 — Settings model (user prefs)

Independent of Tasks 1-2 (touches DB/API, not UI chrome) but its output (the scheme
preference) is consumed visually starting Task 5. Add a migration
`scripts/migrations/NNNN_user_settings.sql` (check `scripts/migrations/` for the current
highest number and use the next one — this repo has NO `_journal.json`, filename-sorted,
idempotent `IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS`) adding a `user_settings` table (or
columns directly on `users` if that fits this repo's existing convention better — check
how `drizzle/schema.ts`'s `users` table is shaped and follow the established pattern for
where per-user preference-style columns live in this codebase) storing: `locale` (text,
one of the 7 locale codes, default `'lv'`), `display_scheme` (text, one of
`'standard' | 'sunlight' | 'dark'`, default `'standard'`). Add the corresponding Drizzle
table/columns in `drizzle/schema.ts`.

`lib/settings/user-prefs.ts`: `getUserPrefs(db, userId)` and `setUserPrefs(db, userId,
{locale?, displayScheme?})` — validate `locale` against `lib/i18n/config.ts`'s `isLocale`
and `displayScheme` against the 3-value union, throwing/rejecting invalid values rather
than silently coercing.

`app/api/settings/route.ts`: `GET` returns the authenticated user's prefs (401 if no
session — use `getVerifiedSession` from `lib/auth/session-guard.ts`, this repo's
convention for any route that must honor session revocation, per
`docs/24-phase1-status-and-parallel-handoff.md` §5); `PATCH` validates and persists a
partial update, 400 on invalid values.

**Test focus:** DB-backed tests for `getUserPrefs`/`setUserPrefs` (round-trip, invalid
locale/scheme rejected) — this repo's DB tests run against a real Postgres
(`TEST_DATABASE_URL`), follow the existing store-test convention (look at an existing
`lib/domain/stores/*.test.ts` for the setup pattern used in this repo). Route tests for
GET/PATCH (200 round-trip, 401 unauthenticated, 400 invalid body). Key files: next
migration file in `scripts/migrations/`, `drizzle/schema.ts` addition,
`lib/settings/user-prefs.ts` (+test), `app/api/settings/route.ts` (+test).

### Task 4 — Role-based root routing

Depends on Task 3 only loosely (no hard dependency — can run before or after). Rewrite
`app/page.tsx` (currently the create-next-app default) to: resolve the session via
`getVerifiedSession` (`lib/auth/session-guard.ts`); if no session, redirect to `/login`
(the login page doesn't exist yet in this repo — redirect to it anyway, per doc 24 §5
"there is no `/login` page at all" — that gap is explicitly WS1/WS9 frontend work per
that doc, but building the actual login page/form is out of this task's scope per this
plan's §1 scope list; redirecting to a not-yet-built route is correct and expected, note
it as a known gap in your report, do not build a login page as a side effect); if session
exists, branch on `session.user.role` (`lib/auth/roles.ts` — 5 roles:
`technician | team_lead | dispatcher | back_office | admin`): `technician` and
`team_lead` → redirect into the field shell's default route (Task 5 creates
`app/(field)/today/page.tsx` — coordinate the exact path with that task, `/today` is the
expected landing); `dispatcher`, `back_office`, `admin` → redirect into the office shell's
default route (Task 6 creates the office shell under `app/(office)/c/[companyId]/...` —
since this route needs a `companyId`, resolve it from the user's accessible
`erp_companies` via whatever the existing convention is for that lookup in this repo, and
redirect to that company's default page; if the user has zero accessible companies,
that's a real edge case — pick a sensible fallback (an honest "no company access" page
or message) and note the decision in your report).

For `team_lead`, add the "switch to office" affordance doc 07 describes ("users with both
hats can switch") — since `team_lead`'s capabilities (`lib/auth/roles.ts`) don't include
`order:view_all`/`dispatch:manage` etc. (those are `dispatcher`-only), re-check
`docs/05-users-auth.md` for what a team_lead's office-side access actually is before
deciding what "switch" lands them on — if the role model doesn't actually grant a
team_lead any office capability today, implement the switch as a visible link/toggle in
the field shell (Task 5's More tab) rather than inventing office access this task doesn't
have the authority to grant; report what you found so the controller can confirm the
scope is right.

Since `app/(field)/...` and `app/(office)/...` route groups are created by Tasks 5/6 (not
yet existing when you start this task), coordinate: if this task runs before 5/6, create
minimal placeholder targets (`app/(field)/today/page.tsx` and
`app/(office)/c/[companyId]/page.tsx` with trivial content) so the redirect has something
real to land on and your tests aren't asserting redirects to 404s — Tasks 5/6 will then
flesh out real chrome around/above what you created, not fight your files. Report exactly
what placeholder files you created so those tasks' implementers know what already exists.

**Test focus:** each of the 5 roles resolves to the correct redirect target; no session
→ `/login`; team_lead sees/can reach the switch affordance. Key files: `app/page.tsx`
(+test), possibly minimal placeholder pages as described above.

### Task 5 — Field shell chrome

Depends on Task 4's placeholder (if Task 4 ran first) or creates
`app/(field)/today/page.tsx` fresh otherwise — check what exists before starting, and if
`app/(field)/today/page.tsx` already exists as a placeholder from Task 4, extend it rather
than recreating it. Build `app/(field)/layout.tsx`: a bottom tab bar with 5 tabs — Today,
Jobs, Scan, Inbox, More (doc 07's field shell chrome spec) — using Next.js
`usePathname()`/`Link` for active-tab highlighting, sized per Task 1's `--ui-field-*`
tokens (56-64px tap targets). A persistent header with a sync-status chip (states:
offline / syncing / synced / pending-N-ops — for this task, wire it to whatever real
signal is cheaply available: `navigator.onLine` for offline/online, and a placeholder
"synced" state otherwise — full pending-ops-count wiring happens naturally once Task 7's
briefcase data loader exists; if you can wire the real outbox pending count cheaply now,
do, otherwise use a static "synced" placeholder and say so in your report — do not block
this task on Task 7).

Route stubs for each tab: `app/(field)/today/page.tsx`, `app/(field)/jobs/page.tsx`,
`app/(field)/scan/page.tsx`, `app/(field)/inbox/page.tsx` (Task 8 fills this with the real
conflict-inbox component — leave an honest placeholder here, Task 8 replaces it),
`app/(field)/more/page.tsx` (Task 7 fills this with the real briefcase component, and
Task 2's locale-switcher + Task 10's push-toggle also land here — leave an honest
placeholder, later tasks extend it). "Honest placeholder" means real page chrome
(header, tab bar) with a plain "Coming soon" / empty-state message in the content area —
not fake data that looks like a working feature (per this plan's §2 decision 5).

**Test focus:** layout renders all 5 tabs with correct labels/hrefs; active tab
highlighting reflects the current route; sync chip shows offline state when
`navigator.onLine` is false (mock it) and an online/synced state otherwise. Key files:
`app/(field)/layout.tsx` (+test), the 5 tab page stubs, a `components/sync-status-chip.tsx`
if you factor the chip out (reasonable given Task 6 might want a similar concept — your
call whether to share it, don't over-engineer a shared abstraction for a single consumer
today).

### Task 6 — Office shell chrome

Depends on Task 4's placeholder (if it ran first) at
`app/(office)/c/[companyId]/page.tsx`. Build `app/(office)/c/[companyId]/layout.tsx`:
collapsible left sidebar (dark surface) + light content area, modeled on herbe-portal's
admin shell (read `~/AI/herbe-portal/app/(admin)/admin/layout.tsx` and whatever
`components/admin-nav.tsx` it renders — outside this repo, read-only reference — for the
`.admin-shell` / dark-sidebar-light-content grid pattern) — collapses to a mobile drawer
under a breakpoint using shadcn's `Sheet` component (Task 1 sets up shadcn).

Nav sections per `docs/07-ui-screens.md`'s office shell table: Dispatch, Orders,
Worksheets, Customers, Service items, Stock, Reports, Settings/Admin — each a route stub
under `app/(office)/c/[companyId]/<section>/page.tsx` with an honest placeholder (these
are WS10/WS8/WS7/WS6/WS14's real content later). Gate each nav item's visibility by
`hasCapability(session.user.role, <capability>)` from `lib/auth/roles.ts` — pick the
capability that best matches each section from the existing `Capability` union (e.g.
`dispatch:manage` for Dispatch, `order:view_all` for Orders, `customer:edit` for
Customers — use your judgment matching the existing capability list, and note in your
report if a section has no obviously-matching capability in the current union, rather
than inventing a new one silently).

`components/company-switcher.tsx`: lists the erp_companies the signed-in user can access
(check how this repo currently resolves "which companies can this user see" — there may
not be an existing per-user company-access concept yet since this repo is single-tenant
Phase-0-ish; if no such resolution exists, list all `erp_companies` for the user's tenant,
scoped by `tenantId`, and note that per-user company scoping is a gap for a later WS to
close — don't invent a new access-control table for this task). Hidden if the tenant has
only one company (doc 07: "hidden if single company").

**Test focus:** sidebar renders only capability-permitted sections for a given role
(test at least 2 contrasting roles, e.g. `admin` sees Settings/Admin, `back_office` does
not see Dispatch); company switcher lists the right companies and is absent for a
single-company tenant; drawer/sheet opens on a mobile viewport (or, if true viewport
testing isn't practical in this repo's test setup, test the breakpoint logic/conditional
render directly). Key files: `app/(office)/c/[companyId]/layout.tsx` (+test), the 8 nav
section route stubs, `components/company-switcher.tsx` (+test).

### Task 7 — Briefcase UI

Depends on Task 5's `app/(field)/more/page.tsx` existing (extend it, don't recreate).
Build `components/briefcase-summary.tsx`: an entity-agnostic list of "scope buckets"
(label + count + optional staleness label), designed so a later WS can add a bucket
without redesigning the component (e.g. accept a `buckets: {label: string; count: number;
lastSyncedAt?: Date}[]` prop shape, or similar — your call on the exact shape, keep it a
plain data-in prop, no fetching inside the presentational component).

A data-loader (server-side, since it reads Postgres) computing today's real buckets: the
signed-in user's `scope_membership` row count (from `drizzle/schema.ts`'s
`scopeMembership` table — count non-purged rows, i.e. `outScopeSeq IS NULL`, for that
`userId`), the tenant's `outbox_ops` count with `status = 'pending'`, and — since Dexie
customer count is a **client-side** IndexedDB read, not server data — either (a) fetch it
client-side in a small client sub-component wrapping the presentational summary, or
(b) skip the Dexie bucket in this task and note it as a follow-on wiring detail once you
see how the rest of the page is structured; don't force a server component to read
client-only IndexedDB state. Use your judgment on the cleanest split and explain the
split you chose in your report.

Wire it into `app/(field)/more/page.tsx` alongside Task 2's locale-switcher (if that
task already landed — check first) and a placeholder slot for Task 10's push-toggle.

**Test focus:** the presentational component renders bucket rows from a given props
array and an empty-state when the array is empty or all counts are zero; the data-loader
returns correct counts against seeded rows (DB-backed test, same convention as Task 3).
Key files: `components/briefcase-summary.tsx` (+test), a data-loader module (name it by
what it does, e.g. `lib/offline/briefcase-summary.ts`) (+test), `app/(field)/more/page.tsx`
update.

### Task 8 — Conflict inbox

Depends on Task 5's `app/(field)/inbox/page.tsx` existing (extend it). Build
`lib/inbox/get-inbox-items.ts`: `getInboxItemsForUser(db, tenantId)` (or scoped however
`outbox_ops` is actually scoped in this repo — check `drizzle/schema.ts`'s `outboxOps`
table, it has `tenantId` not `userId`, so this is tenant-scoped today, not per-user; note
this in your report as a known limitation — a real per-user inbox needs `outbox_ops` to
carry attribution, which it doesn't yet) returning rows where `status = 'failed'`, mapped
to a small `InboxItem` shape (id, entity, op, errorMessage, createdAt). Structure the
function so a second source (e.g. rejected-worksheet tasks, once WS8/WS9 build that
persistence) can be merged in later without a rewrite — a simple internal
"collect-from-sources, merge, sort by createdAt" shape is enough, don't build a plugin
registry for a single current source.

`components/conflict-inbox.tsx`: lists `InboxItem`s with a retry action (calls
`POST /api/sync/outbox` again with the same stored `payloadJson`/`id` — check
`app/api/sync/outbox/route.ts`'s existing idempotency handling, a retried POST for an
existing id is answered from the existing row per that route's current logic, so verify
retry actually needs a different mechanism, e.g. a dedicated
`POST /api/sync/outbox/[id]/retry` that resets `status` to `'pending'` and re-attempts the
push — read the existing route fully before deciding, don't assume) and an empty state
("No conflicts" / similar, matching Task 5's placeholder tone).

**Test focus:** `getInboxItemsForUser` returns only failed ops, correctly shaped, against
seeded rows (DB-backed test). The retry action's route/handler actually flips a failed op
back toward success (or at least back to `pending` and re-attempts) — test this against
the real mechanism you build, not a mock of intent. Empty state renders when there are no
failed ops. Key files: `lib/inbox/get-inbox-items.ts` (+test), whatever retry route you
add under `app/api/sync/outbox/` (+test), `components/conflict-inbox.tsx` (+test),
`app/(field)/inbox/page.tsx` update.

### Task 9 — Web Push infra (server)

Independent of Tasks 5-8 (pure backend). Add the `web-push` npm package. Add a migration
`scripts/migrations/NNNN_push_subscriptions.sql` (next free number after Task 3's) adding
a `push_subscriptions` table: `id` (uuid pk), `user_id` (fk → users), `endpoint` (text,
unique), `p256dh` (text), `auth` (text), `created_at`. Add the Drizzle table.

Document VAPID key generation in a comment/README note (generate a real keypair now via
`npx web-push generate-vapid-keys` or the package's `generateVAPIDKeys()` for local/dev
use — put the generated keys in this worktree's `.env.local`/`.env.example` as
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (a `mailto:` contact), **never**
commit real production keys — `.env.example` gets placeholder values, `.env.local` (which
should already be gitignored — verify) gets a real dev keypair so tests/dev server work
end to end).

`app/api/push/subscribe/route.ts` (POST, authenticated via `getVerifiedSession`, upserts
a subscription by `endpoint` for the current user) and
`app/api/push/unsubscribe/route.ts` (POST, deletes by `endpoint` + `userId`).

`lib/push/send.ts`: `sendPushToUser(db, userId, payload)` — loads all subscriptions for
that user, sends via the `web-push` package's `sendNotification`, and on a 410 (Gone) or
404 response deletes that subscription row (expired-subscription cleanup, doc 21 §4 WS1
doesn't say this explicitly but it's standard Web Push hygiene and the plan's task
description calls for "410/expired-subscription cleanup").

`app/api/push/test/route.ts` (POST, admin-role-gated via
`hasCapability(role, ...)`/direct role check — pick whichever this repo's existing
admin-gated routes use, e.g. `lib/auth/totp.ts`'s disable route or the ext-tokens admin
route for the convention — calls `sendPushToUser` for a target `userId` in the body, for
manually verifying the plumbing).

**Test focus:** subscribe/unsubscribe round-trip (DB-backed); `sendPushToUser` sends to
all of a user's subscriptions and removes one that 410s (mock the `web-push` package's
`sendNotification`, assert the DB delete happened); the test route rejects non-admin
callers. Key files: migration, `drizzle/schema.ts` addition, `app/api/push/subscribe/route.ts`,
`app/api/push/unsubscribe/route.ts`, `app/api/push/test/route.ts`, `lib/push/send.ts`
(all +tests), `.env.example` update.

### Task 10 — Web Push client + service worker

Depends on Task 9's subscribe/unsubscribe routes existing. herbe-service's
`next.config.ts` already wires `@ducanh2912/next-pwa`'s `withPWAInit` — check that
package's docs/types for its custom-worker-source option (commonly `swSrc` or an
`importScripts`-based additional worker — the exact option name may differ from other
projects' conventions, verify against the installed package version rather than assuming)
and add a custom worker source file (e.g. `public/sw-push.js` or wherever that option
expects it) implementing `self.addEventListener('push', ...)` (parse the payload, call
`self.registration.showNotification`) and
`self.addEventListener('notificationclick', ...)` (close the notification, focus/open a
client window).

`components/push-toggle.tsx` (client component): requests `Notification.permission`,
subscribes via `navigator.serviceWorker.ready` →
`registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: <VAPID
public key, exposed to the client via a `NEXT_PUBLIC_` env var or fetched from a small
endpoint — your call, note which>})`, POSTs the subscription to
`/api/push/subscribe`, and offers an unsubscribe path calling
`/api/push/unsubscribe`. Surface it in `app/(field)/more/page.tsx` (alongside Task 7's
briefcase and Task 2's locale-switcher) and a stub in the office Settings section (Task
6's `app/(office)/c/[companyId]/settings/page.tsx`).

**Test focus:** the toggle component's subscribe/unsubscribe flow against a mocked
`navigator.serviceWorker`/`pushManager` (permission granted → subscribe called with the
right `applicationServerKey`; permission denied → no subscribe call, a message shown).
The service worker's push handler, if this repo's test setup can load/exercise a service
worker file at all (check what's already tested here, if anything, for `next-pwa`
output) — if genuinely not testable in this repo's vitest setup, say so explicitly in
your report and document the manual verification steps instead of skipping silently.
Key files: the custom SW source file, `next.config.ts` update, `components/push-toggle.tsx`
(+test), the two page updates.

### Task 11 — Playwright smoke journey

Depends on Tasks 1-6 (needs real shells to navigate). This repo already has
`@playwright/test` as a dependency — check for an existing Playwright config/convention
in this repo (or its sibling apps) before adding a new one from scratch. Add
`tests/e2e/app-shell.spec.ts` (or wherever this repo's existing Playwright tests, if any,
live — match the convention) covering: the manifest (`public/manifest.json`) is served
and has real `icons` (Task 1 or an earlier task may need a favicon/icon asset — check
`public/manifest.json`'s current empty `icons: []` and fill in at least one real icon
if none exists, since an empty icon list makes the PWA non-installable, which this test
would otherwise falsely pass); signing in as each of a technician and a dispatcher
(reuse this repo's existing test-login convention — `app/api/test/login/route.ts` /
`lib/auth/test-provider.ts` already exist for exactly this) lands on the field shell and
office shell respectively; a reload with the network offline (Playwright's offline
context option) doesn't blank-screen (renders at least the app shell chrome, even if
data is stale/empty).

**Test focus:** this task's deliverable IS the test — run it and report the actual
Playwright output (pass/fail), not just that you wrote it. Key files:
`tests/e2e/app-shell.spec.ts`, `public/manifest.json` icon fix if needed.

### Task 12 — Wrap-up

Depends on all prior tasks being complete. No new application code. Update
`docs/24-phase1-status-and-parallel-handoff.md`: flip the WS1 row in §1's table to
reflect what actually shipped (be precise — this slice built shell chrome + tokens +
push infra + settings, not the full doc 21 WS1 feature list; say exactly that, the same
way the existing WS1 row already models "substrate only" honesty), add a §2-style bullet
documenting the new infra (design tokens file location, push infra, settings model,
route-group structure) for other sessions to build on, and fold this plan's §1 "out of
scope, deferred" list into §4's "ready-to-assign parallel jobs" as new unclaimed items
(or amend the existing WS9/WS10/WS8 bullets if they already cover it — check before
adding a duplicate). Refresh the "Last updated" line.

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
