# herbe.service — Feature Roadmap by Development Phase

Status: v0.2 (2026-07-04) — updated after the spec review with real calendar/portal codebase access (`09-spec-review.md`). Sizing assumes a small team (2–3 devs + design shared with the suite); durations are calendar estimates, to be re-planned after Phase 0.

## Phase 0 — Foundations (4–6 weeks)

Goal: de-risk the two hard things (offline sync, ERP mapping) before building features.

- ~~Access + review of the other herbe app repos~~ **done** (calendar + portal reviewed 2026-07-04, findings in `08-suite-integration.md`/`09-spec-review.md`); **still open: the design-system repo** — until it's mirrored, the portal's `app/globals.css` tokens + CLAUDE.md non-negotiables are the working reference
- Decide + execute the **reuse mechanics** with the portal/calendar owners: extract `@herbe/erp` (adapter framework), `@herbe/email-templates` from herbe-portal, or copy-first with attribution (suite precedent) — see `08-suite-integration.md` §6
- **Tenancy ADR**: deployment-per-customer (portal model, recommended) vs multi-tenant single deployment (calendar model) — `03-architecture.md`
- Provision Neon + Vercel projects (via the portal's provisioning CLI if the portal tenancy model is chosen)
- Confirm Standard ERP + Excellent Books service-module register codes and field maps against real tenant systems, incl. `ActVc` activity types for bookings and the invoice back-link field (`04-erp-sync.md` table)
- **Walking skeleton**: PWA shell installable + offline, logs in via Auth.js (credentials + one more provider), pulls Items/Customers from one ERP through the reused adapter, displays them offline, one round-trip outbox op, one scheduled sync job on Vercel Cron — deployed end-to-end
- Project scaffolding, CI/CD, environments; i18n scaffolding (next-intl, portal's 7-locale setup)
- Sync-engine spike outcomes written up as ADRs (local DB choice, conflict rules validated against real ERP behavior, sequence-reset handling, key-sweep deletion reconciliation, incremental-capability probe per connection)

Exit: skeleton demo on a phone in airplane mode; register map signed off; reuse mechanics agreed with sibling-app owners.

## Phase 1 — MVP: the core field loop (10–14 weeks)

Goal: a technician can do a full day's work offline; a manager can approve it; the ERP gets clean data. Replaces paper.

**Master data & entities**
- Customers, Sites, Contacts (ERP-synced + create-in-field with duplicate check)
- Service items with serial numbers, item card, documents/instructions
- Item catalog (parts + services), prices (role-gated visibility)

**Service orders & worksheets**
- Service order CRUD, rows per service item, priorities, statuses
- Worksheet execution: parts (with stock location), services, time entries (start/stop + manual, work/travel), work description, fault/cause/remedy
- Photos (before/after), basic fixed checklists, customer signature with content lock
- Manager approval / rejection with comment; approval triggers ERP push
- Worksheet PDF service report, emailed to customer

**Mobile & offline**
- Offline-first PWA: "download my work" briefcase, outbox, conflict inbox
- My-jobs list + simple day/week calendar of own bookings. Bookings are created by the manager from the order detail screen in Phase 1 (the dispatch board is Phase 2)
- One-tap call, one-tap navigate (Google/Apple/Waze), one-tap camera
- Phase 1 stock scope: parts consume from the **main warehouse** by default (`WorksheetRow.stockLocation` exists from day one, but van-stock locations activate in Phase 2)

**History**
- Service history per service item and customer, offline, including imported pre-app ERP history

**Platform**
- Users, roles (technician / dispatcher-manager / admin in Phase 1; team lead and back office roles activate in Phase 2), Auth.js sign-in incl. Entra ID where the tenant wants it, ERP identity links, device registry + remote wipe
- ERP adapter #1 (the launch tenant's ERP): inbound master data + service orders; outbound customers, service items, orders, approved worksheets + stock consumption; invoice number/status read-back; **bookings ↔ `ActVc` two-way** (Standard ERP tenants — this is what makes the technician's Phase 1 calendar and herbe.calendar see the same schedule; Excellent Books tenants get it where WebExcellentAPI is present)
- Notification/email sending via the portal's TemplateKey engine (reused) — Phase 1 needs it for worksheet PDF mail and rejection notices
- **Sync health screen** (per-register status, dead-letter queue, retry)
- Standalone mode (no adapter) functional

Exit: one pilot company runs its real service work for 2+ weeks with invoices issued from ERP off synced worksheets.

## Phase 2 — Dispatch, stock, scanning (8–12 weeks)

Goal: the planner and the warehouse join the loop.

- **Dispatch board**: day/week, technician rows, drag-and-drop bookings, unassigned-work pool, technician self-assignment option, reassignment
- **Map view** of the day's jobs and (coarse) technician positions
- Booking notifications (push) on assign/change; pause reasons (waiting parts / no access)
- **Van stock**: per-technician location, stock lookup across all locations (incl. offline cache), transfers, consumption already flowing from Phase 1; min-stock indication
- **Barcode/QR**: scan parts into worksheet rows; printable QR labels for service items → scan opens item card/history, confirms arrival, starts work
- Checklist/form **template builder** (field types, required rules, measured values with pass/fail bounds), templates by item/work type
- ERP adapter #2 (the other ERP), adapter framework hardened into config-driven product
- Time-entry review/export for payroll-side reporting

Exit: dispatcher plans a 5+ technician team for a week entirely in-app; parts stock in ERP matches reality.

## Phase 3 — Contracts, recurring service, customer experience (8–12 weeks)

Goal: proactive service and a customer-facing surface.

- **Service contracts/agreements**: covered service items, response-time terms, price rules reference; calendar-based recurring order generation (e.g. yearly maintenance), horizon control
- SLA indicators on orders (response/resolution timers, overdue flags)
- **Customer-facing surface = herbe.portal service modules**, not a new portal (see `08-suite-integration.md` §4 — resolves the overlap with the existing portal product): submit requests (→ service order with duplicate detection), see statuses, order/worksheet history per service item, confirm quotes for out-of-contract work. Built as portal modules following the portal's register-module playbook, reading from herbe.service's API
- Customer notifications: booking confirmed, "technician on the way" with ETA, work-done summary + report PDF, satisfaction survey (1-tap + comment)
- Work templates (incident-type-lite): fault type bundles default checklist, typical parts, estimated duration
- Native wrappers (iOS/Android store presence, NFC tag reading, better background behavior) — only the gaps Phase 1–2 PWA data shows we need; iOS follows the calendar's Swift `WKWebView` shell + token-pairing pattern rather than Capacitor
- Reporting v1: utilization, first-time-fix rate, MTTR, revenue per technician (ERP-priced), top problem devices

Exit: recurring contract work generates and completes without manual creation; customers receive and confirm digitally.

## Phase 4 — Optimization & intelligence (ongoing)

Prioritize by pilot data, not upfront:

- Scheduling assist: suggest technician/slot by skills, distance, availability; later route optimization for multi-stop days
- Meter/usage-based preventive maintenance with predictive drift of due dates (AllDevice pattern)
- AI assist: worksheet summary drafting, "similar past faults on this model" retrieval, voice-to-form capture
- Live technician tracking link for customers; no-login self-scheduling of visits
- Skills & certifications registry with expiry (gates assignment suggestions)
- Subcontractor/multi-company support
- IoT hooks (alert → service order) if a real customer needs it

## Cross-cutting, every phase

- Suite design-language compliance; Estonian/English/Latvian/Lithuanian/Finnish/Norwegian localization readiness from Phase 1 (i18n scaffolding in Phase 0 — next-intl with the portal's locale set `lv,en,et,lt,fi,sv,no` covers all six required languages plus Swedish)
- In-app docs wiki (`docs/wiki/{admin,users}` markdown, both siblings' shared convention) grows with every feature; `DocLink` `?`-icons at feature entry points (portal pattern)
- Accessibility of field UI: glove-sized targets, high contrast, one-hand reach
- GDPR: data minimization on device, encrypted local store, retention policies
- Performance budgets from `03-architecture.md` enforced in CI

## Open items

1. ~~herbe suite repos~~ **resolved** — calendar + portal mirrored and reviewed (2026-07-04). **Design-system repo still missing**; interim reference: portal `app/globals.css` tokens + design non-negotiables in portal CLAUDE.md.
2. Launch-tenant choice decides adapter order (Standard ERP vs Excellent Books first).
3. Register codes marked "confirm" in `04-erp-sync.md`, incl. Sites mapping and the invoice back-link field.
4. Pricing/packaging (per-user flat à la AllDevice vs modular à la Frontu) — product decision, not spec-blocking.
5. Tenancy ADR (`03-architecture.md`) — decide in Phase 0 week 1; blocks provisioning setup.
6. Reuse mechanics (shared `@herbe/*` packages vs copy-first) — needs agreement with portal/calendar owners; `08-suite-integration.md` §6.
7. Suite SSO (shared Auth.js issuer / Entra broker) — suite-level decision, not Phase 1-blocking (`05-users-auth.md`).
8. Portal service modules (Phase 3) need a slot on the herbe.portal roadmap — coordinate early so the API contract (`08-suite-integration.md` §5) is stable by then.
