# herbe.service — Feature Roadmap by Development Phase

Status: v0.5 (2026-07-06, owner round 4: manual order decision-states, charge types P1, row attribution P1, scoped replication P0/P1, worksheet-shadow activity P2). Previous: v0.4 (2026-07-05, round 3: pause reasons P1, seven locales, unlinked-activity P1 home, QR scheme freeze, ops package, open items refreshed). Previous: v0.3 — spec-line merge: item hierarchy, team jobs, document templates, field policies and kilometers placed into phases; review-round-2 phase fixes (P1–P12 in `10-spec-review-gaps.md`) applied. Sizing assumes a small team (2–3 devs + design shared with the suite); durations are calendar estimates, to be re-planned after Phase 0 — **note: Phase 1 scope grew in this merge (tree, kilometers, team-ready model); the 10–14 week estimate predates that and needs re-checking.**

## Phase 0 — Foundations (4–6 weeks)

Goal: de-risk the two hard things (offline sync, ERP mapping) before building features.

- ~~Access + review of the other herbe app repos~~ **done** (calendar + portal reviewed 2026-07-04; findings in `08-suite-integration.md`/`09-spec-review.md`). Repo access is solved twice over: GitHub mirrors + `BITBUCKET_APP_PASSWORD` against the Bitbucket REST API. **Still open: the design-system import** (claude.ai/design project → `herbe-design-system` repo); interim reference: portal `app/globals.css` tokens + CLAUDE.md non-negotiables, captured with the field-app gap list in `14-design-handoff.md`
- ~~Tenancy~~ **resolved 2026-07-05**: multi-tenant core + dedicated deployments for whitelabel (`03-architecture.md`) — walking-skeleton schema unblocked. Execute the **reuse mechanics** (final 2026-07-05): extract **only `@herbe/erp-core`**; copy-first everything else incl. the email-template engine — see `08-suite-integration.md` §6
- Provision Supabase + Vercel projects; adapt the portal provisioning CLI from the Neon API to the Supabase Management API; set up the vendor-side fleet inventory + version train (`03-architecture.md` fleet operations)
- **Suite-integration agenda with the sibling-app owners** — the concrete, individually decidable asks live in `13-suite-change-requests.md`: CAL-1 activity-type/workflow-stage conventions, CAL-2 echo-tagging, portal-side service-modules slot (confirmed 2026-07-04), SUITE-1 identity decision
- Confirm ERP service-module register codes and field maps against real tenant systems — `CUVc`/`ActVc`/`QTVc` verified from sibling production use, `WSVc` near-confirmed (product owner); remaining: serial-number register, service-order register, service-contracts register, stock lookup/transaction registers, Sites mapping, invoice back-link field, `ActVc` activity types + intake types, WebExcellentAPI presence on launch tenant (`04-erp-sync.md` table)
- **Walking skeleton**: PWA shell installable + offline, logs in via Auth.js (magic link for office + PIN-on-paired-device for the technician), pulls Items/Customers from one ERP through the reused adapter (cache → ingest → domain, `04-erp-sync.md` store topology), displays them offline, one round-trip outbox op, one scheduled sync job on Vercel cron (dispatcher-route pattern, `03-architecture.md`) — deployed end-to-end, rendered in a tenant theme
- Project scaffolding, CI/CD with **TDD gates** (coverage thresholds, red-blocks-merge); environments on **Vercel provisioning** (per-PR preview deployments seeded + Playwright-tested; staging/demo stamped by the provisioning CLI; `TEST_AUTH` in Preview/staging env vars only — `15-testing-strategy.md` §5.5); i18n scaffolding (next-intl, portal's 7-locale setup)
- **Test infrastructure** (`15-testing-strategy.md`): fake ERP server + fixture recorder, sync simulation harness, golden-fixture library, **seed engine with scenario packs + fixed role personas + guarded test-login** (UI tests for feature dev / regression / acceptance run authenticated from day one; doubles as demo data) — built before the features that need them; **owner arranges the dedicated test ERP** (§6 list: test company with/without WebExcellentAPI, planned version upgrade, reference devices)
- Sync-engine spike outcomes written up as ADRs: local DB choice **incl. the device-at-rest security scope** (`03-architecture.md`), **scoped-replication membership model** (scope-exit purge round-trip proven on-device), conflict rules validated against real ERP behavior, **whether REST-created Work Sheets trigger ERP-native stock/invoice processing** (`04-erp-sync.md` worksheet flow — decides the stock-transaction fallback), sequence-reset handling, key-sweep deletion reconciliation, incremental-capability probe per connection, **PDF rendering approach** for the built-in report (no reusable generator exists in the suite; must also fit the Phase 2 DOCX pipeline, `12-documents-templates.md`)

Exit: skeleton demo on a phone in airplane mode; register map signed off; reuse mechanics agreed with sibling-app owners.

## Phase 1 — MVP: the core field loop (10–14 weeks)

Goal: a technician can do a full day's work offline; a manager can approve it; the ERP gets clean data. Replaces paper.

**Master data & entities**
- Customers, Sites, Contacts (ERP-synced + create-in-field with duplicate check; merge tooling per `02-data-model.md` record-merge rules)
- Service items as a **tree** (`system`/`unit` nodes, parent link, path search — flat is a degenerate tree, no later migration; `11-service-items-and-parts.md`), serial numbers, item card, documents/instructions; minimal ItemModel registry (make/model/category)
- Item catalog (parts + services), prices (role-gated visibility)
- Contract entity stub (nullable references only — the feature is Phase 3; `02-data-model.md`)

**Service orders & worksheets**
- Service order CRUD, rows per service item, priorities, statuses (derived in-flight states + **manual technician "job done" / manager "confirmed" decision states**, server-side machine — `02-data-model.md`), **default charge type** with context suggestion (contract/warranty/invoiceable)
- Worksheet execution: parts (with stock location, **per-row charge type override and service-item attribution** — `02-data-model.md`), services, time entries (start/stop + manual, work/travel), **driven kilometers per member** (direct km or odometer; billable → travel-item row at approval; optional, tenant can require via field policy — policy *engine* ships Phase 1 with seeded defaults, config UI Phase 2), work description, fault/cause/remedy, **pause with reason** (parts/access/other — ships with the state machine)
- **Data model is team-ready from day one** (lead + members, per-member time/rows — `02-data-model.md`); Phase 1 UX assigns one technician per job (lead only), crew UX arrives with the Phase 2 dispatch board
- Photos (before/after), basic fixed checklists (seeded templates managed as data; builder UI Phase 2), customer signature with content lock + revision rule
- Manager approval / rejection with comment; approval triggers the ERP push group (worksheet + stock txn, ordering rules in `04-erp-sync.md`)
- Worksheet PDF service report, emailed to customer — tenant-themed, built-in document (custom DOCX templating arrives Phase 2, `12-documents-templates.md`)

**Mobile & offline**
- Offline-first PWA: "download my work" briefcase (**scoped replication**: per-user scope membership feed + scope-exit purges — `03-architecture.md`; scope model validated in the Phase 0 sync spike), outbox, conflict inbox
- My-jobs list + simple day/week calendar of own bookings. Bookings are created by the manager from the order detail screen in Phase 1 (the dispatch board is Phase 2)
- One-tap call, one-tap navigate (Google/Apple/Waze), one-tap camera
- Phase 1 stock scope: parts consume from the **main warehouse** by default (`WorksheetRow.stockLocation` exists from day one, but van-stock locations activate in Phase 2)

**History**
- Service history per service item and customer, offline, including imported pre-app ERP history
- **HistoryEvent projector** as a named platform component (transition- and ingest-triggered, idempotent, admin rebuild — `02-data-model.md`)

**Platform**
- Users, roles (technician / dispatcher-manager / admin in Phase 1; team lead and back office activate in Phase 2); **role-shaped login**: magic link for office roles (TOTP optional), PIN on paired device for technicians (enrolment link/QR; biometrics with the Phase 3 wrapper); ERP identity links (match-by-email helper), device registry + remote wipe
- The ERP adapter (one product family, one adapter, portal-style multi-company connections with `erp_company_id` scoping in the schema from day one): inbound master data + service orders; outbound customers, service items, orders, approved worksheets + stock consumption; invoice number/status read-back; **bookings ↔ `ActVc` two-way incl. multi-person crew activities, echo suppression and void-in-place cancellation** (`04-erp-sync.md`) — this is what makes the technician's Phase 1 calendar and herbe.calendar see the same schedule. Unlinked inbound activities surface on the sync-health screen in Phase 1 (O11; the dispatch-board pool takes over in Phase 2)
- ERP connection configuration UI: connection definition, add-company-from-same-server, capability probe, activity-type mapping, poll cadences (declarative transformations UI + JS hooks and settings import/export land Phase 2; Phase 1 maps live as reviewed config data)
- Notification/email sending via the portal's TemplateKey engine (reused) — Phase 1 needs it for worksheet PDF mail and rejection notices
- **License/seat enforcement** (per-user pricing decided): licensed seat count per deployment, activation blocked beyond seats, usage visible in admin
- **Sync health screen** (per-register status, push groups, dead-letter queue, retry)
- **Audit log** (append-only, who/when/what/device on every state change) — schema + write path, not just the screen
- Standalone mode (no adapter) functional
- In-app docs wiki (`/docs`) + DocLink pattern from day one

Exit: one pilot company runs its real service work for 2+ weeks with invoices issued from ERP off synced worksheets.

## Phase 2 — Dispatch, stock, scanning, templates (10–14 weeks)

Goal: the planner and the warehouse join the loop; the config surfaces become product.

- **Dispatch board**: day/week, technician rows, drag-and-drop bookings, unassigned-work pool, technician self-assignment option, reassignment. Scope: **time × technician capacity view only** — the pipeline/Kanban status view is delegated to herbe.calendar's Kanban via the status→workflow-stage mapping on the booking activity (`08-suite-integration.md` §3); we don't build a second Kanban
- **Crew scheduling UX**: several technicians on one job — crew bookings with `crewGroupId`, moved as a group or detached individually; one shared worksheet (lead + members), each member logging own time/parts from own van; one multi-person `ActVc` activity per crew job (`04-erp-sync.md`)
- **Map view** of the day's jobs and (coarse) technician positions
- Booking notifications on assign/change (pause reasons already ship Phase 1); **Web Push infrastructure** (VAPID keys, subscription store, fan-out worker) as a named platform item
- **Van stock**: per-technician location, stock lookup across all locations (incl. offline cache), transfers, min-stock indication
- **Barcode/QR**: scan parts into worksheet rows; printable QR labels for service items — units *and* `system`/`lot` nodes (zone plaques) → scan opens the node card/history, confirms arrival, starts work. **The label resolver-URL scheme (`labelId`, login-routed — `08-suite-integration.md` §4a) is frozen here, before the first label is printed** — the portal customer route merely joins it in Phase 3
- **Item hierarchy at scale** (`11-service-items-and-parts.md`): `lot` nodes + group-coverage order/worksheet rows ("all detectors in zone 2", `n of m` + exceptions) with history projection; structure templates ("standard store"); spreadsheet import/export with dry-run diff; bulk operations (filter → move / assign contract / print labels / create group service order)
- **Parts compatibility** (`11-service-items-and-parts.md`): PartCompatibility (model × part × role), alternative groups + supersession, fits-this-model-first technician lookup with in-stock substitutes offered automatically — all offline in the briefcase
- Checklist/form **template builder** (field types, required rules, measured values with pass/fail bounds), templates by item/work type
- **Document template engine** (`12-documents-templates.md`): DOCX mail-merge templates the tenant edits in Word — placeholders, loops, conditionals, images; computed fields & display rules (shared JS sandbox with ERP transformations); template library with test render + validation; selection rules; document number series; auto-generation on approval; rendering-pipeline ADR executed
- **Field policies config UI** (`02-data-model.md`): per-form hidden/read-only/optional/required rules, scoped by role and work type, enforced at status transitions
- **Adapter transformations UI + settings import/export** (`04-erp-sync.md` configuration model); **whitelabel option** (per-deployment domain, theme, email branding — `03-architecture.md`); **`worksheetShadow` activity purpose** (execution mirror for ERP/calendar/CRM visibility, incl. booking-less walk-up jobs — `04-erp-sync.md` activity-purpose map)
- **`/api/ext/v1` service API** + hashed scoped bearer tokens (per company connection) + admin minting UI — the contract herbe.portal's Phase-3 service modules consume is frozen here (`08-suite-integration.md` §4)
- **Standalone→ERP initial-load wizard** (company binding + natural-key matching + duplicate review, `04-erp-sync.md`)
- Multi-company hardening: several ERP company connections in one install, polished company switcher, per-company sync health
- Time-entry review/export for payroll-side reporting (incl. distance entries)
- Team lead + back office roles activate

Exit: dispatcher plans a 5+ technician team (incl. crew jobs) for a week entirely in-app; parts stock in ERP matches reality.

## Phase 3 — Contracts, recurring service, customer experience (8–12 weeks)

Goal: proactive service and the customer-facing surface.

- **Service contracts/agreements**: covered service item nodes, response-time terms, price rules reference; calendar-based recurring order generation (e.g. yearly maintenance), horizon control; contract coverage view ("42/46 extinguishers inspected this year") on the tree rollups
- SLA indicators on orders (response/resolution timers, overdue flags)
- **Customer surface = herbe.portal, exclusively** (owner decision 2026-07-05: anything requiring customer input or serving the customer lives in the portal; herbe.service ships no customer-facing pages). Portal service modules: equipment + history (QR label deep-link target), request intake → service order, order status incl. "technician on the way" view, report PDFs, worksheet signoff, satisfaction feedback — built portal-side per the design spec + its 2026-07-05 addendum (`herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`), reading `/api/ext/v1`. Tenants without portal: customers get emailed report PDFs and sign on-site — nothing web-facing from service
- **Quote flow** for out-of-contract work: quote draft from order → `QTVc` push → confirmation in the portal's quotations module → acceptance read-back (`04-erp-sync.md`)
- **Self-scheduling intake via herbe.calendar Smart Booking** (ERP tenants): booking template targeted at the service intake activity type (+ custom fields: site, serial, fault) → auto-converted to ServiceOrder + Booking; reschedule/cancel links from the confirmation email (`13-suite-change-requests.md` CAL-4)
- Customer notifications (sent by service, links landing in the portal where the tenant runs it): booking confirmed, "technician on the way" with ETA (explicit **"On my way" tap** on the job screen + static route estimate — no live tracking yet), work-done summary + report PDF, satisfaction survey (1-tap + comment, hosted portal-side; email channel — SMS/in-app are stubs suite-wide)
- **Compliance documents** (`12-documents-templates.md`): certificates per node/coverage with subtree annexes, contract-cycle documents; customer approval/signing **in herbe.portal** (signing descriptor primary; `ActVc` activity-vessel as the no-module fallback, `13-suite-change-requests.md` POR-2); on-site canvas signature remains the no-portal baseline
- Work templates (incident-type-lite): fault type bundles default checklist, typical parts, estimated duration
- Native wrappers (iOS/Android store presence, NFC, biometric technician login, better background behavior) — only the gaps Phase 1–2 PWA data shows we need; candidates in `03-architecture.md`
- Reporting v1: utilization, first-time-fix rate, MTTR, revenue per technician (ERP-priced, via `IVVc` rows through the portal's invoice mappers), top problem devices; subtree rollups + coverage %; lot explosion; checklist sampling rules

Exit: recurring contract work generates and completes without manual creation; customers receive and confirm digitally.

## Phase 4 — Optimization & intelligence (ongoing)

Prioritize by pilot data, not upfront:

- Scheduling assist: suggest technician/slot by skills, distance, availability (query herbe.calendar's merged busy-times — `13-suite-change-requests.md` CAL-5); later route optimization for multi-stop days
- Meter/usage-based preventive maintenance with predictive drift of due dates (AllDevice pattern), per tree node
- Part-compatibility suggestions mined from approved worksheet usage (model × part pairs → admin review queue)
- AI assist: worksheet summary drafting, "similar past faults on this model" retrieval, voice-to-form capture
- Live technician tracking link for customers; no-login self-scheduling of visits
- Skills & certifications registry with expiry (gates assignment suggestions)
- Subcontractor/multi-company support
- Additional ERP adapters (non-HansaWorld: Horizon, Directo, Business Central, …) driven by customer demand — the adapter contract keeps each one an isolated module
- IoT hooks (alert → service order) if a real customer needs it

## Cross-cutting, every phase

- Suite design-language compliance; localization readiness from Phase 1 for the portal's full seven-locale set `lv,en,et,lt,fi,sv,no` (i18n scaffolding in Phase 0 — next-intl, portal setup reused; translation of service strings beyond en+lv is a launch-planning item, not automatic)
- In-app docs wiki grows with every feature; `DocLink` `?`-icons at feature entry points (portal pattern)
- Accessibility of field UI: glove-sized targets, high contrast, one-hand reach
- GDPR: data minimization on device, device-at-rest scope per `03-architecture.md`, retention policies
- **TDD throughout** (`15-testing-strategy.md`): spec rules land as failing tests first; every phase's features ship with their suites; manual-script fallback for anything §5 hasn't arranged yet
- Performance budgets from `03-architecture.md` enforced in CI

## Open items

Everything else from earlier rounds is decided and folded into the docs (Q1–Q5 all answered 2026-07-05 — `10-spec-review-gaps.md` §3; round-3 tracker: `16-spec-review-round-3.md`). Live list:

1. ~~Crew-model owner confirmation~~ **confirmed 2026-07-06: multi-person activity is primary** (`16` §1.1); stale herbe-service branches deleted the same day — `claude/spec-review-gaps-ukjna3` is the canonical spec branch
2. **Branch hygiene / spec governance, portal side** — land the portal service-modules spec (+ v1.1 addendum, currently only on the GitHub mirror branches) on the portal's real Bitbucket mainline; until then the mirror branches must not be deleted (`16` §1.4)
3. **Register codes / field maps** to confirm against the launch tenant (Phase 0 list above; incl. calendar's `AccessGroup`-field TODO on `ActVc`)
4. **Design-system import** into `herbe-design-system` (interim: portal tokens + `14-design-handoff.md`)
5. Pricing/packaging final call (inputs: verified competitor prices in `01-competitive-analysis.md` v0.2; per-user pricing decided, seat licensing in Phase 1; whitelabel/multi-company as packaging axes)
6. **Operations & lifecycle package** (accept as Phase 2/3 scope; backup/restore + `/api/ext` rate limiting land with Phase 1 hardening): DR/rollback story, tenant offboarding & data export, shared→dedicated migration mechanics, retention enforcement (`16` §2.9)
7. Phase 1 re-estimate at Phase 0 exit (Q5)
