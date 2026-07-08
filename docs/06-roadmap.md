# herbe.service — Feature Roadmap by Development Phase

Status: v0.11 (2026-07-07). Four development phases: **P0 Foundations** (de-risk offline sync + ERP mapping), **P1 The product** (the full field loop, dispatch, van stock, scanning, document/checklist templates and the real config surfaces), **P2 Contracts, recurring service, customer experience**, **P3 Optimization & intelligence**. Sizing assumes a small team (2–3 devs + design shared with the suite); durations are calendar estimates, **re-planned after Phase 0** — the merged P1 is large, so its estimate below is explicitly a Phase-0-exit re-plan item.

## Phase 0 — Foundations (4–6 weeks)

Goal: de-risk the two hard things (offline sync, ERP mapping) before building features.

- Sibling-app repos reviewed (calendar + portal; findings in `08-suite-integration.md`/`09-spec-review.md`); repo access via GitHub mirrors + `BITBUCKET_APP_PASSWORD` on the Bitbucket REST API. Design-system import landed: `herbe-design-system` is populated — `tokens.css` canonical, `handovers/SERVICE.md` in place; the field-app gap list stays tracked in `14-design-handoff.md`
- Tenancy: multi-tenant core + dedicated deployments for whitelabel (`03-architecture.md`). Reuse mechanics: extract **only `@herbe/erp-core`**; copy-first everything else incl. the email-template engine (`08-suite-integration.md` §6)
- Provision Supabase + Vercel projects; adapt the portal provisioning CLI from the Neon API to the Supabase Management API; set up the vendor-side fleet inventory + version train (`03-architecture.md` fleet operations)
- **Suite-integration agenda with the sibling-app owners** — the concrete, individually decidable asks live in `13-suite-change-requests.md`: CAL-1 activity-type/state conventions, CAL-2 echo-tagging, portal-side service-modules slot, SUITE-1 identity decision
- ERP service-module register codes confirmed (owner export structures + halocron + a live demo-system probe; `04-erp-sync.md` + `17-erp-register-reference.md` + `19-demo-probe-results.md`): `SVOVc`, `WSVc`, `SVOSerVc`, `DelAddrVc`, `ItemStatusVc`, `RLinkVc`, `COVc` verified; OK-flag stock semantics and the REST pricing limitation established; the `RLinkVc` back-link resolves via WebExcellentAPI `getrecordlinks`; `SVOVc`/`WSVc` have no `updates_after`, `deletes_after` is unreliable, server-side filters work; `ActVc` service types are `SVP`/`SERV`. Work Order chain avoided: `WSVc.WONr = -1` on create, no `WOVc` needed, the two-step `SVOVc → WSVc` stands. Charge-type enum = string set 31 (`0`=-, `1`=Invoiceable, `2`=Warranty, `3`=Contract, `4`=Goodwill; 1:1 with app charge types, distinct from `INVc.ItemType`), pushed as the integer `1`–`4`, reads return the localized label; only `Invoiceable` charges. WebExcellentAPI version-gate source = the `systemversion` attribute on the REST `<data>` root, matched by an admin-set regex (`04-erp-sync.md`)
- **Walking skeleton**: PWA shell installable + offline, logs in via Auth.js (magic link for office + PIN-on-paired-device for the technician), pulls Items/Customers from one ERP through the reused adapter (cache → ingest → domain, `04-erp-sync.md` store topology), displays them offline, one round-trip outbox op, one scheduled sync job on Vercel cron — deployed end-to-end, rendered in a tenant theme
- Project scaffolding, CI/CD with **TDD gates** (coverage thresholds, red-blocks-merge); environments on **Vercel provisioning** (per-PR preview deployments seeded + Playwright-tested; staging/demo stamped by the provisioning CLI; `TEST_AUTH` in Preview/staging env vars only — `15-testing-strategy.md` §5.5); i18n scaffolding (next-intl, portal's 7-locale setup)
- **Test infrastructure** (`15-testing-strategy.md`): fake ERP server + fixture recorder, sync simulation harness, golden-fixture library, **seed engine with scenario packs + fixed role personas + guarded test-login** — built before the features that need them; **owner arranges the dedicated test ERP** (§6 list: test company with/without WebExcellentAPI, planned version upgrade, reference devices)
- Sync-engine spike outcomes written up as ADRs: local DB choice **incl. the device-at-rest security scope** (`03-architecture.md`), **scoped-replication membership model** (scope-exit purge round-trip proven on-device), conflict rules validated against real ERP behavior, **whether REST-created Work Sheets trigger ERP-native stock/invoice processing** (`04-erp-sync.md` — the `WSVc` create mechanism is settled, `WONr = -1`, so this spike can run), sequence-reset handling, key-sweep deletion reconciliation, incremental-capability probe per connection, **PDF rendering approach** for the built-in report (must also fit the DOCX pipeline, `12-documents-templates.md`). Alongside the sync ADRs, the **provisioning ADR** — resolved: **Supabase branching** for per-preview databases (`15-testing-strategy.md` §5.5)

Exit: skeleton demo on a phone in airplane mode; register map signed off; reuse mechanics agreed with sibling-app owners.

## Phase 1 — The product: field loop, dispatch, stock, scanning, templates

Goal: a technician does a full day's work offline, a manager approves it, the ERP gets clean data — and the planner and the warehouse are in the loop while the config surfaces are real product. Replaces paper and runs a whole service operation. **(Large phase — this merges what were two ~10–14-week phases; re-estimate at Phase 0 exit.)**

**Master data & entities**
- Customers, Sites, Contacts (ERP-synced + create-in-field with duplicate check; merge tooling per `02-data-model.md` record-merge rules)
- Service items as a **tree** — `system`/`unit` nodes from the start, plus **`lot` nodes + group-coverage** order/worksheet rows ("all detectors in zone 2", `n of m` + exceptions) with history projection; structure templates ("standard store"); spreadsheet import/export with dry-run diff; bulk operations (filter → move / assign contract / print labels / create group service order) — full item-hierarchy-at-scale, `11-service-items-and-parts.md`
- Item catalog (parts + services), prices (role-gated visibility); minimal ItemModel registry (make/model/category)
- **Parts compatibility** (`11-service-items-and-parts.md`): PartCompatibility (model × part × role), alternative groups + supersession, fits-this-model-first technician lookup with in-stock substitutes offered automatically — all offline in the briefcase
- Contract entity stub (nullable references only — the contract *feature* is Phase 2; `02-data-model.md`)

**Service orders & worksheets**
- Service order CRUD, rows per service item, priorities, statuses (derived in-flight states + **manual technician "job done" / manager "confirmed" decision states**, server-side machine — `02-data-model.md`), **default charge type** with context suggestion (contract/warranty/invoiceable)
- Worksheet execution: parts (with stock location, **per-row charge type override and service-item attribution**), services, time entries (start/stop + manual, work/travel with direction, discrete **work segments**, return-travel-after-Done + tenant-cutoff auto-stop), **driven kilometers per member** (direct km or odometer; billable → travel-item row at approval; optional per field policy — policy engine **and** config UI both ship this phase with seeded defaults), work description, fault/cause/remedy, **pause with reason**
- **Worksheet is one-per-technician** (`WSVc.EMCode` is a single technician). Crew jobs (several technicians, several worksheets sharing a `crewGroupId`) work from day one; the **grouped-by-job UI** (list/queue views + job cards grouped by `crewGroupId`) ships here, **and so does the dispatch-board crew UX** (crew booking chip, drag-as-group)
- Photos (before/after), **checklists** — seeded templates managed as data **plus the template builder** (field types, required rules, measured values with pass/fail bounds, templates by item/work type); customer signature with content lock + revision rule
- Manager approval / rejection with comment; approval triggers the ERP push group (worksheet + stock consumption, ordering rules in `04-erp-sync.md`)
- **Documents**: tenant-themed built-in **order-level** service report PDF — a **seeded default template** (no authoring needed) that renders all the order's approved worksheets as one document (the report presented for signoff), emailed to customer — **and the DOCX template engine** (`12-documents-templates.md`): Word mail-merge templates — placeholders, loops, conditionals, images; computed fields & display rules (shared JS sandbox with ERP transformations); template library with test render + validation; selection rules; document number series; auto-generation on approval; rendering-pipeline ADR executed
- **Field policies config UI** (`02-data-model.md`): per-form hidden/read-only/optional/required rules, scoped by role and work type, enforced at status transitions

**Dispatch & scheduling**
- **Dispatch board**: day/week, technician rows, drag-and-drop bookings, unassigned-work pool, technician self-assignment option, reassignment. Scope: **time × technician capacity view only** — the pipeline/Kanban status view is delegated to herbe.calendar's Kanban via the status→`ActState` shadow mapping (`04-erp-sync.md` shadow-Kanban, `08-suite-integration.md` §3); we don't build a second Kanban
- **Crew scheduling UX**: crew bookings with `crewGroupId`, moved as a group or detached individually; one worksheet per technician sharing the `crewGroupId`, each logging own time/parts from own van; one multi-person `ActVc` activity per crew job (`04-erp-sync.md`)
- **Map view** of the day's jobs and (coarse) technician positions
- Booking notifications on assign/change; **Web Push infrastructure** (VAPID keys, subscription store, fan-out worker) as a named platform item
- My-jobs list + simple day/week calendar of own bookings

**Van stock & scanning**
- **Van stock**: per-technician location (`WorksheetRow.stockLocation` from day one; van-stock resolution `UserVc.Location` → connection main-service-location setting → ERP main stock, `04-erp-sync.md`), stock lookup across all locations (incl. offline cache), transfers, min-stock indication
- **Barcode/QR**: scan parts into worksheet rows; printable QR labels for service items — units *and* `system`/`lot` nodes (zone plaques) → scan opens the node card/history, confirms arrival, starts work. **The label resolver-URL scheme (`labelId`, login-routed — `08-suite-integration.md` §4a) is frozen before the first label is printed** — the portal customer route merely joins it in Phase 2

**Mobile & offline**
- Offline-first PWA: "download my work" briefcase (**scoped replication**: per-user scope membership feed + scope-exit purges — `03-architecture.md`; scope model validated in the Phase 0 sync spike), outbox, conflict inbox
- One-tap call, one-tap navigate (Google/Apple/Waze), one-tap camera

**History**
- Service history per service item and customer, offline, including imported pre-app ERP history
- **HistoryEvent projector** as a named platform component (transition- and ingest-triggered, idempotent, admin rebuild — `02-data-model.md`)

**Platform, config & API**
- Users, roles (**technician / dispatcher-manager / back office / team lead / admin all active this phase** — owner 2026-07-07); **role-shaped login**: magic link for office roles (TOTP optional), PIN on paired device for technicians (enrolment link/QR), **plus WebAuthn platform-authenticator biometric unlock (Face ID / Touch ID / Android biometric) — reachable in the installed PWA, no native wrapper**; ERP identity links (match-by-email helper), device registry + remote wipe
- The ERP adapter (one product family, one adapter, portal-style multi-company connections with `erp_company_id` scoping from day one): inbound master data + service orders; outbound customers, service items, orders, approved worksheets + stock consumption; invoice number/status read-back; **bookings ↔ `ActVc` two-way incl. multi-person crew activities, echo suppression and void-in-place cancellation** (`04-erp-sync.md`). Unlinked inbound activities surface on the sync-health screen (and the dispatch-board pool). **Multi-company hardening** in the same phase: several ERP company connections in one install, polished company switcher, per-company sync health
- **`worksheetShadow` + `orderShadow` activity purposes** (`04-erp-sync.md`): status mirrors onto the shadow activity's `ActState` (the manager's OK-discovery Kanban); the per-connection creation-timing choice and two-way notes ship here too. **`workSegment` activity purpose**: per-segment travel/work activities with live or on-approval delivery, incl. the return-after-done trip
- ERP connection configuration UI: connection definition, add-company-from-same-server, capability probe, activity-type + status→`ActState` mapping (with the "create activity states in the ERP" seed tool), poll cadences, **declarative transformations UI + JS hooks and settings import/export** (`04-erp-sync.md` configuration model)
- **`/api/ext/v1` service API framework** + hashed scoped bearer tokens (per company connection) + admin minting UI + rate limiting — the shell for the reduced portal surface. The customer signoff / report / feedback endpoints themselves write Phase-2 entities, so they go live with the Phase 2 customer experience (`08-suite-integration.md` §4)
- **Standalone→ERP initial-load wizard** (company binding + natural-key matching + duplicate review, `04-erp-sync.md`); standalone mode (no adapter) functional
- Notification/email sending via the portal's TemplateKey engine (reused) — order report PDF mail and rejection notices
- **Whitelabel option** (per-deployment domain, theme, email branding — `03-architecture.md`)
- **License/seat enforcement** (per-user pricing): licensed seat count per deployment, activation blocked beyond seats, usage visible in admin
- **Sync health screen** (per-register status, push groups, dead-letter queue, retry); **Audit log** (append-only, who/when/what/device on every state change — schema + write path, not just the screen)
- Time-entry review/export for payroll-side reporting (incl. distance entries)
- In-app docs wiki (`/docs`) + DocLink pattern from day one

Exit: a pilot company runs its real service work for 2+ weeks with invoices issued from ERP off synced worksheets; a dispatcher plans a 5+ technician team (incl. crew jobs) for a week entirely in-app; parts stock in ERP matches reality.

## Phase 2 — Contracts, recurring service, customer experience (8–12 weeks)

Goal: proactive service and the customer-facing surface — kept separate from Phase 1 because it stands cleanly on its own and builds on the Phase-1 document engine + `/api/ext` API.

- **Service contracts/agreements**: covered service item nodes, response-time terms, price rules reference; calendar-based recurring order generation (e.g. yearly maintenance), horizon control; contract coverage view ("42/46 extinguishers inspected this year") on the tree rollups. The ERP contract (`COVc`, read inbound) is the base — per-row service levels (`SVCCode` → `SVCVc`, carrying the recurring cadence); herbe.service overlays the per-service-level extras `SVCVc` can't hold (`02-data-model.md`)
- SLA indicators on orders (response/resolution timers, overdue flags)
- **Customer surface = herbe.portal, exclusively** (owner 2026-07-05: herbe.service ships no customer-facing pages). Portal service modules: equipment + history (QR label deep-link target), request intake → service order, order status incl. "technician on the way" view, report PDFs, order signoff (resendable — reject re-opens the order for more work), satisfaction feedback — built portal-side, reading `/api/ext/v1`. Tenants without portal: emailed report PDFs + on-site signature — nothing web-facing from service
- **Quote flow** for out-of-contract work: quote draft from order → `QTVc` push → confirmation in the portal's quotations module → acceptance read-back (`04-erp-sync.md`)
- **Self-scheduling intake via herbe.calendar Smart Booking** (ERP tenants): booking template targeted at the service intake activity type (+ custom fields: site, serial, fault) → auto-converted to ServiceOrder + Booking; reschedule/cancel links from the confirmation email (ask raised in `13-suite-change-requests.md` CAL-4)
- Customer notifications (sent by service, links landing in the portal): booking confirmed, "technician on the way" with ETA (explicit **"On my way" tap** + static route estimate — no live tracking yet), work-done summary + report PDF, satisfaction survey (1-tap + comment, hosted portal-side; email channel — SMS/in-app are stubs suite-wide)
- **Compliance documents** (`12-documents-templates.md`): certificates per node/coverage with subtree annexes, contract-cycle documents; customer signoff **in herbe.portal** (signing descriptor primary; the no-module fallback attaches the document to the `orderShadow` activity for the portal's delivery-confirmation flow, `13-suite-change-requests.md` POR-2); on-site canvas signature remains the no-portal baseline
- Work templates (incident-type-lite): fault type bundles default checklist, typical parts, estimated duration
- Native wrappers (iOS/Android store presence, NFC, better background behavior) — only the gaps Phase 1 PWA data shows we need; candidates in `03-architecture.md`. (Biometric technician login already ships Phase 1 via the WebAuthn platform authenticator.)
- Reporting v1: utilization, first-time-fix rate, MTTR, revenue per technician (ERP-priced, via `IVVc` rows through the portal's invoice mappers), top problem devices; subtree rollups + coverage %; lot explosion; checklist sampling rules

Exit: recurring contract work generates and completes without manual creation; customers receive and confirm digitally.

## Phase 3 — Optimization & intelligence (ongoing)

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

- Suite design-language compliance; localization readiness from Phase 1 for the portal's full seven-locale set `lv,en,et,lt,fi,sv,no` (i18n scaffolding in Phase 0 — next-intl, portal setup reused; translation of service strings beyond en+lv is a launch-planning item)
- In-app docs wiki grows with every feature; `DocLink` `?`-icons at feature entry points (portal pattern)
- Accessibility of field UI: glove-sized targets, high contrast, one-hand reach
- GDPR: data minimization on device, device-at-rest scope per `03-architecture.md`, retention policies
- **TDD throughout** (`15-testing-strategy.md`): spec rules land as failing tests first; every phase's features ship with their suites; manual-script fallback for anything §5 hasn't arranged yet
- Performance budgets from `03-architecture.md` enforced in CI

## Open items

Everything else from earlier rounds is decided and folded into the docs (Q1–Q5 answered 2026-07-05 — `10-spec-review-gaps.md` §3; round-3 tracker `16-spec-review-round-3.md`; round-5 record `20-spec-review-round-5.md`). Live list:

1. **Pricing/packaging final call** (inputs: verified competitor prices in `01-competitive-analysis.md`; per-user pricing decided, seat licensing in Phase 1; whitelabel/multi-company as packaging axes)
2. **Operations & lifecycle package** — **future work**, not needed for Phase 0/1: DR/rollback story, tenant offboarding & data export, shared→dedicated migration mechanics, retention enforcement (`16` §2.9). (Backup/restore + `/api/ext` rate limiting ride along with Phase 1 hardening where the API ships; the rest is built out later.)
3. **Phase 1 re-estimate at Phase 0 exit** — especially now that Phase 1 absorbed the old Phase 2 scope
4. **Register codes / field maps** to confirm against the launch tenant (Phase 0 list above; incl. calendar's `AccessGroup`-field TODO on `ActVc`; per-tenant onboarding values: main-service-location fallback, `SVOVc` number series, service-level `SVCVc` definitions)
5. Sibling-team responses to the `13-suite-change-requests.md` asks (CAL-*/POR-*/SUITE-1)
