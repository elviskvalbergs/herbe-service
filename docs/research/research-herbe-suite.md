# Research: the herbe suite (herbe.calendar, herbe.portal, herbe.warehouse)

Date: 2026-07-03. Method: direct fetches of herbe.app, calendar.herbe.app (product page + public docs), portal.herbe.app — network now open, all first-hand. Feeds `07-suite-integration.md`.

## Suite

Built by SIA Burti (Riga, Latvia; ERP specialists ~20 years). Positioning: "Different tools, same team" — automation of routine tasks, data flow between systems without re-entry. Three apps share data model and identity:

- **herbe.calendar** — team scheduling & client booking (calendar.herbe.app)
- **herbe.portal** — customer-facing document hub (portal.herbe.app)
- **herbe.warehouse / HApp** — mobile stock: barcode scanning (Zebra/Honeywell/phone), goods receipt, movements, stocktaking, sales orders; syncs with Excellent ERP (happ.lv)

No public pricing on any of the three.

## herbe.calendar (verified from product page + /docs)

**Views**: Day, 3D, 5D, Week, Month; side-by-side team views with color-coded sources; favorites + quick switching.

**Connected sources**: Standard ERP read/write, Excellent Books read/write (activities created/edited/rescheduled in-app), Outlook read/write, Google (personal + Workspace) read, Teams/Meet/Zoom meeting links, Calendly live sync, arbitrary ICS feeds, per-country holidays.

**Kanban Boards**: board = ERP pipeline, column = workflow stage (stage names shown unmodified), drag card → writes the activity's workflow stage to ERP immediately; empty stages hidden. Docs do not specify the underlying register/field names.

**Unified Tasks**: ERP tasks + Microsoft To Do + Google Tasks in one panel; complete, copy-to-event, create inline.

**Smart Booking**: booking templates (duration + buffer, availability windows, custom fields with required flags, holiday avoidance, day limits) with an **ERP target** — which connection and activity type receives the record — plus optional Outlook/Google event and Zoom link. Share links ride on saved favorites: `/book/<token>`, visibility Busy-only/Titles/Full, no login for the booker. Availability = windows minus busy across all connected sources. Confirmation email with cancel link; conversion analytics (views vs bookings) per link.

**ERP connection mechanics** (admin docs): auth = OAuth via Standard ID (client id/secret) or basic auth; API base URL e.g. `https://erp.company.com/api`; incremental sync every 15 min business hours, hourly off-hours, nightly full reconciliation; multi-company = independent connections (own credentials, sync state, color), commonly 2–3 per tenant.

**API tokens** (admin docs): Bearer tokens, read-only or read/write scope, for "BI dashboards, export scripts, and custom integrations"; endpoint list not public; instant revocation; optional expiry. **No webhooks documented.**

**Clients**: PWA; native iOS app in TestFlight (widgets, Focus-mode-aware push: reminders, activity assignments, watched-item comments); pairing via `/mobile-pair`.

**Deployment**: hosted, or self-hosted on the customer's own Vercel account. (Confirms the Vercel deployment family; the DB behind each app is a per-app hosting choice — Auth.js v5 + Postgres in both siblings, herbe.service on Supabase by decision — see `03-architecture.md`.)

**Docs index**: /docs — users: getting-started, calendar-view, search, tasks, kanban, calendar-sources, booking-pages, repeat, favorites, settings, mobile-app, notifications; admin: overview, installation, migrations, azure-ad, google-workspace, smtp, erp-connections, pipeline, accounts, config, members, cron-jobs, cache, tokens, notifications-admin, analytics-bi, troubleshooting.

## herbe.portal (verified from landing page)

Customer-facing hub, Latvian-first UI (LV language default), login/signup at portal.herbe.app.

- **Invoices**: all supplier invoices in real time, searchable across periods; customers see "rēķinus, līgumus, pasūtījumus" (invoices, contracts, orders)
- **Payments**: pay overdue invoices by card or bank link, no waiting for payment details
- **Digital signing**: Mobile-ID / Smart-ID from mobile — approve deliveries, accept offers, sign contracts
- **Contextual messaging**: questions asked directly on an invoice; replies, attachments, signatures in one inbox
- **Multi-company switching** and **white-label branding** (from suite page; not detailed on portal landing)
- EU-hosted, GDPR ("Atbilst VDAR"), 24/7

Not documented publicly: API, data feed mechanics, pricing, portal-user identity model beyond signup/login.

## Benchmark: Dynamics 365 Field Service portal (learn.microsoft.com, page dated 2025-10)

Power Pages website template bound to one FS environment; contacts of service accounts get signup invitations. Customer picks **customer asset + incident type** (determines duration) → books slot; system creates the work order and books the matching resource (territory, incident-type characteristics, account, asset; shortest travel wins). Email notifications; reschedule/cancel in portal; **track the dispatched technician**; post-work feedback. Limitations: standalone template (doesn't integrate with other Power Pages sites), user resources only, no crews/multi-resource incidents, no Arabic/Hebrew. Self-scheduling home page still labeled **preview** (Oct 2025 docs); 2025w2/2026w1 release waves add nothing portal-side — Microsoft's investment is dispatcher AI (Scheduling Operations Agent, preview 2025-06-30; multi-resource + scheduled optimization previews 2026), schedule board, mobile, ERP integration.

## Implications recorded in the spec

1. Bookings-as-`ActVc` (already decided in `02-data-model.md`/`04-erp-sync.md`) gives herbe.calendar interop with zero suite-to-suite code (tier 0 of `07-suite-integration.md`).
2. herbe.calendar Kanban makes an app-side pipeline board redundant — mirror worksheet/order status to activity workflow stage instead.
3. Smart Booking's ERP-target mechanism is a ready-made customer self-scheduling intake (D365-parity 80%).
4. herbe.portal already owns invoices/payments/signing/messaging — service modules (assets, orders, reports, booking, ETA, feedback) are the gap herbe.service fills.
5. Suite-to-suite APIs (calendar webhooks, portal data contract) are not public → Phase 0 coordination item with Burti, tier 0 carries the MVP meanwhile.
