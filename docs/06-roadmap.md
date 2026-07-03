# herbe.service — Feature Roadmap by Development Phase

Status: v0.1 (2026-07-03). Sizing assumes a small team (2–3 devs + design shared with the suite); durations are calendar estimates, to be re-planned after Phase 0.

## Phase 0 — Foundations (4–6 weeks)

Goal: de-risk the two hard things (offline sync, ERP mapping) before building features.

- Access + review of the other herbe app repos (Bitbucket) and the suite design system; decide shared component/frontend stack accordingly
- Confirm Standard ERP + Excellent Books service-module register codes and field maps against real tenant systems (`04-erp-sync.md` table)
- **Walking skeleton**: PWA shell installable + offline, logs in (local + Entra ID), pulls Items/Customers from one ERP via `updates_after` deltas, displays them offline, one round-trip outbox op — deployed end-to-end
- Tenant model, project scaffolding, CI/CD, environments
- Sync-engine spike outcomes written up as ADRs (local DB choice, conflict rules validated against real ERP behavior, sequence-reset handling)

Exit: skeleton demo on a phone in airplane mode; register map signed off.

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
- My-jobs list + simple day/week calendar of own bookings
- One-tap call, one-tap navigate (Google/Apple/Waze), one-tap camera

**History**
- Service history per service item and customer, offline, including imported pre-app ERP history

**Platform**
- Users, roles (technician / manager / admin), Entra ID SSO, ERP identity links, device registry + remote wipe
- ERP adapter #1 (the launch tenant's ERP): inbound master data + service orders; outbound customers, service items, orders, approved worksheets + stock consumption; invoice number/status read-back
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
- **Customer portal**: submit requests (→ service order with duplicate detection), see statuses, order/worksheet history per service item, confirm quotes for out-of-contract work
- Customer notifications: booking confirmed, "technician on the way" with ETA, work-done summary + report PDF, satisfaction survey (1-tap + comment)
- Work templates (incident-type-lite): fault type bundles default checklist, typical parts, estimated duration
- Capacitor wrappers (iOS/Android store presence, NFC tag reading, better background behavior) — only the gaps Phase 1–2 PWA data shows we need
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

- Suite design-language compliance; Estonian/English/Latvian/Lithuanian/Finnish/Norwegian localization readiness from Phase 1 (i18n scaffolding in Phase 0)
- Accessibility of field UI: glove-sized targets, high contrast, one-hand reach
- GDPR: data minimization on device, encrypted local store, retention policies
- Performance budgets from `03-architecture.md` enforced in CI

## Open items

1. **herbe suite repos & design system** — this environment could not reach herbe.app (network policy) or Bitbucket; Phase 0 depends on that access. Options: add the repos as GitHub mirrors to this session, or open the network policy for herbe.app/Bitbucket.
2. Launch-tenant choice decides adapter order (Standard ERP vs Excellent Books first).
3. Register codes marked "confirm" in `04-erp-sync.md`.
4. Pricing/packaging (per-user flat à la AllDevice vs modular à la Frontu) — product decision, not spec-blocking.
