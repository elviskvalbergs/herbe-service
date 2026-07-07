# herbe.service — Feature Roadmap by Development Phase

Status: v0.9 (2026-07-07, round 8 — owner decisions: back office moved to Phase 1; crew grouped-by-job UI moved to Phase 1 (dispatch board stays Phase 2); charge-type enum closed (owner-provided string set 31 — "-", Invoiceable, Warranty, Contract, Goodwill, 1:1 with app charge types, pushed as integer `1`–`4`); WebExcellentAPI service/contracts document support version-gated per connection (invoices/orders already work — owner decision, `04-erp-sync.md`); portal integration reduced to approval endpoints + label/QR with the ERP as middleman; `SVOVc` REST-create blocker logged as a new open item; `/api/ext` rate limiting moved to Phase 2 hardening; design-system import closed; provisioning ADR added to the Phase 0 list). Previous: v0.8 (2026-07-06, round 7: `worksheetShadow` moved to Phase 1, minimal — the only mechanism giving a Phase-1 walk-up worksheet any ERP/calendar footprint; `workSegment` + `worksheetShadow`'s creation-timing choice stay Phase 2). Previous: v0.7 (2026-07-06, round 6: worksheet model reverted to one-per-technician — no crew UI needed for the Phase 1 team-ready claim). Previous: v0.6 (2026-07-06, live demo-ERP probe: register/API assumptions in `04-erp-sync.md`/`17-erp-register-reference.md` confirmed against the real system, findings in `19-demo-probe-results.md`; Phase 0 register-code remaining-list closed out except the charge-type enum and a new Work Order chain question). Previous: v0.5 (2026-07-06, owner round 4: manual order decision-states, charge types P1, row attribution P1, scoped replication P0/P1, worksheet-shadow activity P2). Previous: v0.4 (2026-07-05, round 3: pause reasons P1, seven locales, unlinked-activity P1 home, QR scheme freeze, ops package, open items refreshed). Previous: v0.3 — spec-line merge: item hierarchy, team jobs, document templates, field policies and kilometers placed into phases; review-round-2 phase fixes (P1–P12 in `10-spec-review-gaps.md`) applied. Sizing assumes a small team (2–3 devs + design shared with the suite); durations are calendar estimates, to be re-planned after Phase 0 — **note: Phase 1 scope grew in this merge (tree, kilometers, team-ready model); the 10–14 week estimate predates that and needs re-checking.**

## Phase 0 — Foundations (4–6 weeks)

Goal: de-risk the two hard things (offline sync, ERP mapping) before building features.

- ~~Access + review of the other herbe app repos~~ **done** (calendar + portal reviewed 2026-07-04; findings in `08-suite-integration.md`/`09-spec-review.md`). Repo access is solved twice over: GitHub mirrors + `BITBUCKET_APP_PASSWORD` against the Bitbucket REST API. ~~The design-system import~~ **closed 2026-07-07**: `herbe-design-system` is populated — `tokens.css` canonical, `handovers/SERVICE.md` in place; the field-app gap list stays tracked in `14-design-handoff.md`
- ~~Tenancy~~ **resolved 2026-07-05**: multi-tenant core + dedicated deployments for whitelabel (`03-architecture.md`) — walking-skeleton schema unblocked. Execute the **reuse mechanics** (final 2026-07-05): extract **only `@herbe/erp-core`**; copy-first everything else incl. the email-template engine — see `08-suite-integration.md` §6
- Provision Supabase + Vercel projects; adapt the portal provisioning CLI from the Neon API to the Supabase Management API; set up the vendor-side fleet inventory + version train (`03-architecture.md` fleet operations)
- **Suite-integration agenda with the sibling-app owners** — the concrete, individually decidable asks live in `13-suite-change-requests.md`: CAL-1 activity-type/workflow-stage conventions, CAL-2 echo-tagging, portal-side service-modules slot (confirmed 2026-07-04), SUITE-1 identity decision
- ~~Confirm ERP service-module register codes~~ **resolved 2026-07-06** (owner export structures + halocron + a live demo-system probe; `04-erp-sync.md` findings + `17-erp-register-reference.md` + `19-demo-probe-results.md`): `SVOVc`, `WSVc`, `SVOSerVc`, `DelAddrVc`, `ItemStatusVc`, `RLinkVc`, `COVc` verified; OK-flag stock semantics, REST pricing limitation established. The demo probe closed out: `RLinkVc` REST readability (readable, but the back-link mechanism is decided as WebExcellentAPI `getrecordlinks` — the record-id format is opaque, not `RegisterName:SerNr`), the no-`updates_after` assumption on `SVOVc`/`WSVc` (confirmed, HTTP 404), `deletes_after` unreliability (confirmed, HTTP 204 empty everywhere tested), server-side filters (confirmed working on `WSVc`), service-contracts register code (`COVc`), `ActVc` activity types on the demo tenant (`SVP`/`SERV` group), WebExcellentAPI presence (confirmed present; `SVOVc`/`WSVc` documents confirmed still missing, failure shape now pinned down). `UserVc.Location` vs `ServLocation` came back inconclusive (neither populated on the demo tenant) — still needs confirming per real launch tenant. **New open item from the probe**: whether a Work Order (`WOVc`) register is a mandatory step between Service Order and Work Sheet on some tenants — the demo system's `WSVc` REST create hard-requires a valid `WONr`; needs an answer from Excellent/the owner before the push-queue design is final. ~~Full `WSVc`/`WSIVVc.ItemType` charge-type enum~~ **resolved 2026-07-07**: characterized via halocron (an editable invoiceability enum on the worksheet row with an ERP-computed, context-derived default — Latvian `"Jāizr.rēķ."` = Invoiceable — distinct from `INVc.ItemType`, the item classification), then **closed by the owner-provided enum definition** (`SetBegin(31)`: `0` = "-", `1` = Invoiceable, `2` = Warranty, `3` = Contract, `4` = Goodwill — 1:1 with the app's charge types). write format confirmed as the integer `1`–`4` (owner 2026-07-07; reads return the localized label). **Remaining Phase 0**: `QtyInvbl` observed on the write test; warranty context via `SVOSerVc`. (The WebExcellentAPI version-gate source is resolved — the `systemversion` attribute on the REST `<data>` root, matched by an admin-set regex; `04-erp-sync.md` API tiers.)
- **Walking skeleton**: PWA shell installable + offline, logs in via Auth.js (magic link for office + PIN-on-paired-device for the technician), pulls Items/Customers from one ERP through the reused adapter (cache → ingest → domain, `04-erp-sync.md` store topology), displays them offline, one round-trip outbox op, one scheduled sync job on Vercel cron (dispatcher-route pattern, `03-architecture.md`) — deployed end-to-end, rendered in a tenant theme
- Project scaffolding, CI/CD with **TDD gates** (coverage thresholds, red-blocks-merge); environments on **Vercel provisioning** (per-PR preview deployments seeded + Playwright-tested; staging/demo stamped by the provisioning CLI; `TEST_AUTH` in Preview/staging env vars only — `15-testing-strategy.md` §5.5); i18n scaffolding (next-intl, portal's 7-locale setup)
- **Test infrastructure** (`15-testing-strategy.md`): fake ERP server + fixture recorder, sync simulation harness, golden-fixture library, **seed engine with scenario packs + fixed role personas + guarded test-login** (UI tests for feature dev / regression / acceptance run authenticated from day one; doubles as demo data) — built before the features that need them; **owner arranges the dedicated test ERP** (§6 list: test company with/without WebExcellentAPI, planned version upgrade, reference devices)
- Sync-engine spike outcomes written up as ADRs: local DB choice **incl. the device-at-rest security scope** (`03-architecture.md`), **scoped-replication membership model** (scope-exit purge round-trip proven on-device), conflict rules validated against real ERP behavior, **whether REST-created Work Sheets trigger ERP-native stock/invoice processing** (`04-erp-sync.md` worksheet flow — decides the stock-transaction fallback; blocked upstream by the 2026-07-06 demo-probe finding that REST `WSVc` create hard-requires a `WONr` foreign key on at least one install — `19-demo-probe-results.md` §10 — so this ADR needs the Work Order question answered first), sequence-reset handling, key-sweep deletion reconciliation, incremental-capability probe per connection, **PDF rendering approach** for the built-in report (no reusable generator exists in the suite; must also fit the Phase 2 DOCX pipeline, `12-documents-templates.md`). Alongside the sync ADRs, the **provisioning ADR** (added 2026-07-07): per-preview database strategy — Supabase branching vs schema-per-preview on a shared test project (`15-testing-strategy.md` §5.5)

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
- Worksheet execution: parts (with stock location, **per-row charge type override and service-item attribution** — `02-data-model.md`), services, time entries (start/stop + manual, work/travel with direction, discrete **work segments**, return-travel-after-Done + tenant-cutoff auto-stop — `02-data-model.md`), **driven kilometers per member** (direct km or odometer; billable → travel-item row at approval; optional, tenant can require via field policy — policy *engine* ships Phase 1 with seeded defaults, config UI Phase 2), work description, fault/cause/remedy, **pause with reason** (parts/access/other — ships with the state machine)
- **Worksheet is one-per-technician from day one** (round 6 correction: reverted from a shared lead+members worksheet — `02-data-model.md`, `WSVc.EMCode` is a single technician). Crew jobs (several technicians, several worksheets sharing a `crewGroupId`) are usable data-model-wise from day one, and the **grouped-by-job UI ships in Phase 1** (owner 2026-07-07): list/queue views and job cards group worksheets by `crewGroupId` so a crew job reads as one job. The dispatch-board crew UX (crew booking chip, drag-as-group) remains Phase 2
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
- Users, roles (technician / dispatcher-manager / back office / admin in Phase 1 — back office moved up from Phase 2, owner 2026-07-07; team lead activates in Phase 2); **role-shaped login**: magic link for office roles (TOTP optional), PIN on paired device for technicians (enrolment link/QR; biometrics with the Phase 3 wrapper); ERP identity links (match-by-email helper), device registry + remote wipe
- The ERP adapter (one product family, one adapter, portal-style multi-company connections with `erp_company_id` scoping in the schema from day one): inbound master data + service orders; outbound customers, service items, orders, approved worksheets + stock consumption; invoice number/status read-back; **bookings ↔ `ActVc` two-way incl. multi-person crew activities, echo suppression and void-in-place cancellation** (`04-erp-sync.md`) — this is what makes the technician's Phase 1 calendar and herbe.calendar see the same schedule. Unlinked inbound activities surface on the sync-health screen in Phase 1 (O11; the dispatch-board pool takes over in Phase 2)
- **`worksheetShadow` activity purpose ships minimal in Phase 1** (moved up from Phase 2, round 7 correction): fixed behavior — created when work starts, workflow stage mirrors worksheet status, one-way app→ERP for the stage. This is the **only** mechanism that gives a **booking-less walk-up worksheet** (`02-data-model.md` work-entry modes, F7 "Start ad-hoc job" — also Phase 1) any ERP/calendar footprint; without it, Phase 1 walk-up jobs would be invisible to dispatch and herbe.calendar for the entire phase, contradicting the data model's own claim that "dispatch still sees reality." Phase 2 enriches it: per-connection choice of creation timing (on worksheet creation vs. on work start) and two-way notes — see Phase 2 below
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
- **Crew scheduling UX**: several technicians on one job — crew bookings with `crewGroupId`, moved as a group or detached individually; **one worksheet per technician, sharing the `crewGroupId`** (round 6, `02-data-model.md`), each logging own time/parts from own van (the grouped-by-`crewGroupId` list/queue views already ship in Phase 1 — see Phase 1 worksheet item); one multi-person `ActVc` activity per crew job (`04-erp-sync.md`)
- **Map view** of the day's jobs and (coarse) technician positions
- Booking notifications on assign/change (pause reasons already ship Phase 1); **Web Push infrastructure** (VAPID keys, subscription store, fan-out worker) as a named platform item
- **Van stock**: per-technician location, stock lookup across all locations (incl. offline cache), transfers, min-stock indication
- **Barcode/QR**: scan parts into worksheet rows; printable QR labels for service items — units *and* `system`/`lot` nodes (zone plaques) → scan opens the node card/history, confirms arrival, starts work. **The label resolver-URL scheme (`labelId`, login-routed — `08-suite-integration.md` §4a) is frozen here, before the first label is printed** — the portal customer route merely joins it in Phase 3
- **Item hierarchy at scale** (`11-service-items-and-parts.md`): `lot` nodes + group-coverage order/worksheet rows ("all detectors in zone 2", `n of m` + exceptions) with history projection; structure templates ("standard store"); spreadsheet import/export with dry-run diff; bulk operations (filter → move / assign contract / print labels / create group service order)
- **Parts compatibility** (`11-service-items-and-parts.md`): PartCompatibility (model × part × role), alternative groups + supersession, fits-this-model-first technician lookup with in-stock substitutes offered automatically — all offline in the briefcase
- Checklist/form **template builder** (field types, required rules, measured values with pass/fail bounds), templates by item/work type
- **Document template engine** (`12-documents-templates.md`): DOCX mail-merge templates the tenant edits in Word — placeholders, loops, conditionals, images; computed fields & display rules (shared JS sandbox with ERP transformations); template library with test render + validation; selection rules; document number series; auto-generation on approval; rendering-pipeline ADR executed
- **Field policies config UI** (`02-data-model.md`): per-form hidden/read-only/optional/required rules, scoped by role and work type, enforced at status transitions
- **Adapter transformations UI + settings import/export** (`04-erp-sync.md` configuration model); **whitelabel option** (per-deployment domain, theme, email branding — `03-architecture.md`); **`worksheetShadow` enrichment + `workSegment` activity purpose** (the minimal `worksheetShadow` ships Phase 1, see above; Phase 2 adds its per-connection creation-timing choice, plus per-segment travel/work activities with live or on-approval delivery, incl. the return-after-done trip — `04-erp-sync.md` activity-purpose map)
- **`/api/ext/v1` service API** + hashed scoped bearer tokens (per company connection) + admin minting UI — the contract herbe.portal's Phase-3 service modules consume is frozen here (`08-suite-integration.md` §4)
- **Standalone→ERP initial-load wizard** (company binding + natural-key matching + duplicate review, `04-erp-sync.md`)
- Multi-company hardening: several ERP company connections in one install, polished company switcher, per-company sync health
- Time-entry review/export for payroll-side reporting (incl. distance entries)
- Team lead role activates (back office already ships in Phase 1 — owner 2026-07-07)

Exit: dispatcher plans a 5+ technician team (incl. crew jobs) for a week entirely in-app; parts stock in ERP matches reality.

## Phase 3 — Contracts, recurring service, customer experience (8–12 weeks)

Goal: proactive service and the customer-facing surface.

- **Service contracts/agreements**: covered service item nodes, response-time terms, price rules reference; calendar-based recurring order generation (e.g. yearly maintenance), horizon control; contract coverage view ("42/46 extinguishers inspected this year") on the tree rollups
- SLA indicators on orders (response/resolution timers, overdue flags)
- **Customer surface = herbe.portal, exclusively** (owner decision 2026-07-05: anything requiring customer input or serving the customer lives in the portal; herbe.service ships no customer-facing pages). Portal service modules: equipment + history (QR label deep-link target), request intake → service order, order status incl. "technician on the way" view, report PDFs, worksheet signoff, satisfaction feedback — built portal-side per the design spec + its 2026-07-05 addendum (`herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`), reading `/api/ext/v1`. Tenants without portal: customers get emailed report PDFs and sign on-site — nothing web-facing from service
- **Quote flow** for out-of-contract work: quote draft from order → `QTVc` push → confirmation in the portal's quotations module → acceptance read-back (`04-erp-sync.md`)
- **Self-scheduling intake via herbe.calendar Smart Booking** (ERP tenants): booking template targeted at the service intake activity type (+ custom fields: site, serial, fault) → auto-converted to ServiceOrder + Booking; reschedule/cancel links from the confirmation email (ask raised in `13-suite-change-requests.md` CAL-4)
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

1. ~~Crew-model owner confirmation~~ **confirmed 2026-07-06: multi-person activity is primary** (`16` §1.1); `claude/spec-review-gaps-ukjna3` is the canonical spec branch — stale herbe-service branches cleared for deletion, owner runs it (session push access is branch-restricted)
2. **Portal integration reduced (owner, 2026-07-07)** — the portal service module is developed independently and must stand on its own with limited functionality. Direct service↔portal integration shrinks to: API endpoints for triggering **worksheet approval** and **quotation approval**, plus possibly the **label/QR integration**; everything else flows through the **ERP as middleman**. The `/api/ext/v1` contract is to be re-cut to this reduced surface (nothing is frozen yet); the earlier task of landing the portal-side spec on the Bitbucket mainline is superseded by the re-cut
3. **Register codes / field maps** to confirm against the launch tenant (Phase 0 list above; incl. calendar's `AccessGroup`-field TODO on `ActVc`)
4. ~~Design-system import~~ **closed 2026-07-07**: `herbe-design-system` is populated — `tokens.css` canonical, `handovers/SERVICE.md` exists (field-app gaps still tracked in `14-design-handoff.md`)
5. Pricing/packaging final call (inputs: verified competitor prices in `01-competitive-analysis.md` v0.2; per-user pricing decided, seat licensing in Phase 1; whitelabel/multi-company as packaging axes)
6. **Operations & lifecycle package** (accept as Phase 2/3 scope; backup/restore lands with Phase 1 hardening; `/api/ext` rate limiting lands with Phase 2 hardening, where the API ships): DR/rollback story, tenant offboarding & data export, shared→dedicated migration mechanics, retention enforcement (`16` §2.9)
7. Phase 1 re-estimate at Phase 0 exit (Q5)
8. ~~**Work Order (`WOVc`) chain question**~~ **resolved 2026-07-07** (owner + ERP source `PasteSVOInWS`): set `WSVc.WONr = -1` on create (the ERP's own "no Work Order" sentinel); no `WOVc` record needed. Owner decision: **avoid the `WOVc` chain** — the two-step `SVOVc → WSVc` design stands, and the `WSVc` creation field-set is now documented (`04-erp-sync.md`, Work Sheet creation)
9. ~~**`SVOVc` REST-create blocker**~~ **resolved 2026-07-07 (live create succeeded)**: after the tenant's `SVOVc` number series was corrected, the same POST with **no `SerNr`** persisted — ERP assigned `SerNr 230022`, derived customer + pricing, stored `ItemType=Warranty`. Create rule: POST with no `SerNr` (REST auto-assigns via `NextSerNr`); sole precondition is a valid number series per tenant (onboarding/provisioning check). Corollary correction: `Invoiced` is derived from a linked `IVVc` (`getrecordlinks`), **not** `InvFlag` (a fresh warranty order reads `InvFlag=1`; `04-erp-sync.md`). The whole app→ERP write path is now proven end-to-end
