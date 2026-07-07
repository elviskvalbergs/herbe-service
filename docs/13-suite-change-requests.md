# herbe.service — Change Requests for herbe.calendar & herbe.portal

Status: v0.4 (2026-07-07 — **signoff** adopted as the umbrella term for the customer-approval/signature triggers POR-2/6/7; CAL-1 shrunk to booking activity-type/state values only — the shadow status→`ActState` maps are service-defined and service-seeded (not negotiated), and the manager's shadow Kanban is an existing calendar board config (columns filter on `(ActType, ActState)`, `lib/pipeline`), so no new calendar build). Previous: v0.3 (2026-07-07 — reduced portal integration applied per owner decision; tokenized service customer pages scrubbed everywhere; CAL-6…CAL-8 added for the service-aware calendar features `08` §3 depends on; CAL-1 renamed to the verified `ActType`/`ActState` fields; CAL-4 gains the reschedule/cancel-link ask; POR-5 premise corrected; SUITE-3 closed as shipped; POR-7 and the no-direct-writes standing principle, both added 2026-07-06 on `preview`, carried over intact). Previous: draft v0.2 (2026-07-04). Audience: the Burti suite team; this is the Phase 0 coordination agenda from `06-roadmap.md`, written as concrete, individually decidable requests. Basis: `08-suite-integration.md` (integration design), the sibling apps' source review (`03-architecture.md`, `04-erp-sync.md`), and herbe.calendar's public docs.

**Framing: nothing here blocks the MVP.** The customer surface is **herbe.portal, exclusively** (owner 2026-07-05); herbe.service ships no customer-facing pages, tokenized or otherwise. The portal service module is being developed **independently** on the portal side and must stand on its own, with limited functionality, even without herbe.service (owner 2026-07-07) — so the concrete near-term asks on the portal team shrink to the customer **signoff** triggers — the worksheet signoff trigger (POR-4, reduced), the document signoff trigger (POR-7) and the quotation signoff trigger (POR-6) — and, tentatively, label/QR handling; the wider module (equipment registry, intake, tracking, feedback) is the portal team's own scope and herbe.service adapts once it settles (`08-suite-integration.md` §4). Tier 0 — the ERP as the shared bus (`ActVc` activities, invoices) — requires **zero code changes** in either sibling app; it needs only configuration agreements (CAL-1, CAL-2, POR-2). Everything else buys latency, coverage, or one-window convenience, and each request lists its fallback so it can be declined or deferred without breaking herbe.service's roadmap.

**Standing principle (added 2026-07-06): herbe.service never creates or writes records directly in herbe.portal, for any register.** Every one of these asks — POR-6, POR-7 included — only ever carries a reference (a `sernr`, an `activityId`) across the wire to trigger a notification or fast-path a sync; the underlying data always travels service → ERP → portal via the portal's own ERP sync, never service → portal directly. Where no such trigger API exists yet, the ERP-mediated tier-0 flow is the working baseline, not a stopgap.

## Summary

| ID | App | Request | Needed by | Type | Fallback if declined |
|---|---|---|---|---|---|
| CAL-1 | calendar | Shared booking activity-type/state values (suite default) | Phase 0 | config agreement | per-tenant values; suite default is a nicety, not blocking |
| CAL-2 | calendar | Echo-tagging convention for `ActVc` writers | Phase 0 | config agreement | heuristic self-echo detection (fragile) |
| CAL-3 | calendar | Documented API-token endpoints + activity webhook or delta API | Phase 2–3 (tier 1) | new feature | tier 0 polling, ICS feeds |
| CAL-4 | calendar | Smart Booking: service-intake template fields (asset reference) + reschedule/cancel links in the confirmation email | Phase 3 | small feature | free-text serial field + QR-prefilled booking links |
| CAL-5 | calendar | Availability query API (merged busy-times) | Phase 4 | new feature | herbe.service checks only its own bookings |
| CAL-6 | calendar | Service-activity recognition (badge/colour for configured service activity types) | Phase 2–3 | small feature | service activities render as ordinary activities |
| CAL-7 | calendar | Service context + "Open in herbe.service" deep link in `ActivityDrawer`/`ActivityBlock` | Phase 2–3 | small feature | context lives in the activity text fields service writes anyway |
| CAL-8 | calendar | Guarded editing of service-locked activities | Phase 3 | small feature | service bounces illegal inbound moves to the dispatcher inbox (tier-0 conflict rule) |
| POR-1 | portal | Invoice ↔ service order cross-link in portal UI | Phase 3 | small feature | customer matches by invoice text reference |
| POR-2 | portal | Delivery-confirmation (signoff) flow accepts our documents (activity vessel) | Phase 3 | config/small feature | on-site canvas signature + emailed report PDF |
| POR-3 | portal | ~~Cross-links from portal to herbe.service customer pages~~ — **superseded 2026-07-05**: no service customer pages exist to link to | — | superseded | portal is the only customer surface |
| POR-4 | portal | ~~Native service-data feed~~ — **reduced 2026-07-07**: near-term = worksheet-approval trigger (`POST /api/ext/v1/worksheets/{id}/confirm`); wider module = portal team's own scope | service Phase 2 (API) | reduced/committed | non-portal tenants: emailed report PDF + on-site canvas signature |
| POR-5 | portal | Messaging threads on service entities | optional, later | feature | service questions via our notifications + email |
| POR-6 | portal | Token-authenticated "send quotation for signoff" API | Phase 3 (quote flow) | small feature | human sends from the portal quotation view |
| POR-7 | portal | Token-authenticated "send worksheet/document for signoff" API (customer signoff) | Phase 3 (signing flow) | small feature | tier-0 poll-based flow already works end-to-end — this is a latency optimization only, not a blocker |
| SUITE-1 | both | Suite identity decision (shared IdP or stay separate) | Phase 0 (decision) | decision | stay separate — herbe.service is designed for it |
| SUITE-2 | both | ~~Repo access~~ — resolved: `BITBUCKET_APP_PASSWORD` works via REST API | — | done | mirrors optional convenience |
| SUITE-3 | both | ~~Shared theme-token vocabulary published~~ — **closed/shipped**: design-system repo is canonical (`tokens.css` + `handovers/SERVICE.md`) | — | done | consume the canonical repo |

## herbe.calendar

### CAL-1 — Booking activity-type/state values (Phase 0, config only — suite default, not blocking)

Tier 0 interop reads best when both apps use the **same** activity-type and state values for service bookings. Verified in calendar source: a Kanban drag PATCHes `/api/activities/[id]` with **`ActType`/`ActState`**, and boards render columns filtered on `(ActType, ActState)` (`lib/pipeline`, `lib/herbe/taskRecordUtils.ts`) — so the fields are known; only the values would be shared. Asks (all nice-to-have, none blocking — herbe.service falls back to per-tenant values):

1. Agree a recommended `ActType`/`ActState` value set for service bookings (per tenant, with a suite default), so our adapter writes/reads the same type/state values the calendar produces and a booking renders correctly in calendar views out of the box.
2. Agree a recommended activity type + symbol set for service bookings, for the same reason.
3. Agree how a multi-person (crew) activity's state change behaves in a board — one card or per-person cards — so our N-bookings ↔ 1-activity mapping (`04-erp-sync.md`) round-trips.

**Not an ask: the shadow status→`ActState` maps.** herbe.service owns the worksheet-status→`ActState` and order-status→`ActState` mapping itself — a per-connection service-side setting — and seeds the matching `ActState` records (code + name) into the ERP via a one-click setup tool. There is nothing to agree with the calendar team about these state values. The manager's shadow Kanban is an **existing** calendar feature: a board configured with columns = the service-defined `ActState` codes (columns filter on `(ActType, ActState)`, `lib/pipeline`), so no new calendar build is needed for the core OK-discovery Kanban (`08-suite-integration.md` §3). The only calendar asks that remain for the service-aware experience are the niceties CAL-6…CAL-8.

### CAL-2 — Echo-tagging for `ActVc` writers (Phase 0, config only)

Both apps write the same register; without a convention, each app's poll re-imports its own (or the other's) writes and can ping-pong updates. Ask: agree a marker — e.g. a reserved prefix/field carrying the originating app + record UUID — that every suite writer sets and every suite reader uses to suppress self-echoes. herbe.service already plans idempotency by app UUID (`04-erp-sync.md`); this request is to make it a *suite* convention rather than ours alone.

### CAL-3 — Documented API endpoints + event push (tier 1, Phase 2–3)

Calendar has read/write Bearer API tokens today, but the endpoint list is not public, and there are no webhooks. Asks, in increasing order of effort:

1. **Document the existing token API** (activities read/write) so herbe.service can publish bookings directly for standalone (no-ERP) tenants.
2. **Webhook on activity create/move/stage-change** (HMAC-signed, per-tenant registration) *or* a delta endpoint (`?updates_after=` style — the suite already speaks that dialect) so calendar-side changes reach herbe.service in seconds instead of the ~30 min tier-0 poll loop.

Fallback: tier 0 covers ERP-connected tenants at poll latency; per-technician ICS feeds (already a supported calendar source) give read-only visibility of herbe.service bookings with no calendar-side work.

### CAL-4 — Smart Booking service-intake fields (Phase 3)

Smart Booking templates with an ERP target already create activities with custom fields — that is our self-scheduling intake (`08-suite-integration.md`). Missing for a good service request: an **asset reference**. Ideal: a custom-field type that accepts an external reference (we pre-fill it via QR deep link — the sticker on the machine opens the booking page with the serial already set). Fallback: plain text field for serial + our QR-prefilled links; conversion still works, just without validation at booking time.

Also needed (cited by `06-roadmap.md` for the self-scheduling flow): **reschedule/cancel links in the booking-confirmation email**, so a self-scheduled service request stays self-serviceable end-to-end without a call to the office. Fallback: the customer replies to the confirmation email and the dispatcher re-plans manually.

### CAL-5 — Availability API (Phase 4)

Calendar already merges busy-times across ERP/Outlook/Google per person. Our scheduling assist should query that merge instead of rebuilding it. Ask: an endpoint "busy windows for person X in range Y" on the token API. Fallback: herbe.service suggests slots from its own bookings only.

### CAL-6 — Service-activity recognition (Phase 2–3, small; `08` §3 C1)

Per-account config mapping which activity types are "service" (the CAL-1 booking values); recognized activities — **including the worksheet/order status-shadow activities** (`08-suite-integration.md` §3) — get a service badge / colour class group, so technicians and dispatchers can tell service bookings and shadow cards from ordinary activities at a glance. This is what makes the manager's OK-discovery Kanban legible: the cards sitting in an `Approved` column read as service work needing action. Fallback: service activities render as ordinary activities — tier 0 still works, they're just visually indistinct.

### CAL-7 — Service context + deep link on the activity (Phase 2–3, small; `08` §3 C2)

For recognized service activities, `ActivityDrawer`/`ActivityBlock` show order number, site and worksheet status — read from the agreed `ActVc` fields herbe.service already writes — plus an **"Open in herbe.service"** deep-link button. This is the OK-discovery pivot: a manager working the shadow-activity Kanban (columns = `ActState`) opens a card, sees the context, and clicks straight through to the linked record — natively in the ERP or via the login-routed deep link into herbe.service — to do the OK (`08-suite-integration.md` §3). Fallback: the same context lives in the activity's text/note fields service writes anyway; users follow a pasted URL instead of a button.

### CAL-8 — Guarded editing of service-locked activities (Phase 3, small; `08` §3 C3)

Recognized service activities that are `OKFlag`-locked or whose linked worksheet is `In progress` or later become read-only in calendar; free re-planning stays while the booking is `planned/confirmed`. This keeps the OK-discovery flow honest — a manager can drag a shadow card to browse the board, but can't accidentally re-plan a record that execution has already locked; the OK stays a deliberate ERP-side action on the opened record. Fallback: calendar edits freely and herbe.service's tier-0 conflict rule bounces illegal inbound moves to the dispatcher's inbox — consistency is preserved, at the cost of a rejected-move loop for the calendar user.

**Kanban column config for OK-discovery:** the manager's board is an existing calendar feature — columns filter on `(ActType, ActState)` (`lib/pipeline`) over the shadow activities — configured with columns = the **service-defined** `ActState` codes (service owns and seeds them, see CAL-1), or an equivalent ERP-side Kanban over the same activities. Either way a worksheet reaching `Approved` (or any configured state) simply appears in that column; no new calendar build is needed.

## herbe.portal

The portal hosts the customer surface (exclusivity confirmed 2026-07-05); herbe.service ships no customer pages. The portal's service module is the portal team's **independent** product — it must stand on its own, with limited functionality, even without herbe.service; their v1 design note lives at `herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`. The **only** direct service↔portal coupling in the near term is the customer **signoff** API calls — the worksheet signoff trigger (POR-4, reduced), the quotation signoff trigger (POR-6) and the document signoff trigger (POR-7) — plus, tentatively, label/QR handling. **The ERP is the connecting piece for all actual data: the portal reads service data from the ERP, never from herbe.service.** Portal reading data directly from herbe.service is a **future** step, taken once the module's shape settles (`08-suite-integration.md` §4). POR-1/POR-2 remain small touchpoints; POR-3 is superseded.

### POR-1 — Invoice ↔ service order cross-link (Phase 3, small)

Invoices from our approved worksheets already reach the portal through its ERP feed. Ask: render a link/reference from the invoice view to the originating service order — we guarantee the ERP invoice carries the order reference. For portal tenants the link targets the portal's own service-order view once their module ships; until then (and for non-portal tenants, who get the emailed report PDF) the reference renders as plain text — herbe.service hosts no customer page to link to. "What was this for" is one tap either way. Pure UI addition on data that's already there.

### POR-2 — Delivery-confirmation (signoff) flow for service documents (Phase 3, mostly config)

Portal already routes documents to customers for approval and Smart-ID/Mobile-ID signature (delivery confirmations). `12-documents-templates.md` reuses exactly that flow for *qualified* signatures (customer **signoff**), with the `ActVc` activity as the vessel: our generated document attaches to an activity via record links; the portal presents it like a delivery confirmation; the outcome returns as the activity's state (`ActState`). Ask: confirm this generalization — specifically that (a) the portal's flow can be configured to pick up our activity types, and (b) the outcome writes a state + comment we can poll. If their flow is invoice/delivery-hardcoded, this becomes a small feature request. Fallback: the on-site canvas signature plus the emailed report PDF (the baseline for tenants without portal anyway — herbe.service hosts no customer-facing approval page).

### POR-3 — ~~Cross-links to herbe.service customer pages~~ — superseded 2026-07-05

herbe.service hosts no customer pages, tokenized or otherwise, so there is nothing to link to. The portal is the only customer surface; customer entry points (portal navigation, email notifications, QR labels) all resolve inside the portal. No ask remains.

### POR-4 — Portal service module — reduced 2026-07-07

Previously "superseded/committed" as the full service-modules plan; now **re-cut by owner decision**: the portal service module is developed independently by the portal team and must stand on its own, with limited functionality, even without herbe.service — what exactly it becomes is still moving. Near-term direct integration is only:

1. **Worksheet signoff trigger** — the portal signoff flow calls `POST /api/ext/v1/worksheets/{id}/confirm` with scoped bearer auth.
2. **Quotation signoff trigger** — POR-6; the decision flows back through `QTVc`.
3. **Tentatively, label/QR handling** — the portal side of the resolver in `08-suite-integration.md` §4a.

The wider read API (service items + history, orders/ETA, request intake, feedback) is **future** — re-cut against the portal module's settled shape; everything else flows through the ERP as middleman. Fallback / non-portal tenants: the emailed report PDF and the on-site canvas signature — herbe.service exposes nothing web-facing to customers.

### POR-6 — API to trigger quotation signoff (Phase 3, small)

Verified in portal code: `POST /api/c/{companyId}/quotations/{sernr}/send` already emails the share-token link to chosen recipients — but it requires an authenticated portal user session + CSRF header, so herbe.service cannot call it after pushing a quote into `QTVc` (`04-erp-sync.md` quote flow). Ask: a token-authenticated variant (same bearer-token pattern as the other service↔portal calls) taking `{sernr, recipients?}` — recipients defaulting to the customer's confirmed identity-link contacts — so quote delivery for customer signoff is automated end-to-end. Fallback: the quote still lands in the portal's quotations module; a human sends it from the quotation view. (No service-hosted approval link — herbe.service ships no customer pages.)

### POR-7 — API to trigger worksheet/document signoff (Phase 3, small)

Same shape as POR-6, for worksheet and document signoff instead of quotations. Unlike POR-6, this one is **not blocking today**: herbe.service already pushes the approved worksheet to `WSVc` and attaches the generated document to the ERP `ActVc` activity via record links (`04-erp-sync.md` mapping, `12-documents-templates.md` §Generation & delivery); the portal picks the activity up through **its own ERP sync**, presents it via its existing delivery-confirmation flow, and the outcome (approved/signed/rejected + comment) returns as the activity's workflow stage, which herbe.service polls — this already works end-to-end at tier 0, no suite API required. Ask: a token-authenticated endpoint (same bearer-token pattern as POR-6) taking `{activityId, documentId?}` — no document content in the call, just the reference — that herbe.service can call right after the document/activity link is confirmed persisted, to skip the poll-cycle wait and put the signoff request in front of the customer immediately. Fallback (the default until this ships): the tier-0 poll-based flow above — a latency optimization only, not a blocker, so herbe.service's worksheet-push and document-generation work proceeds regardless of when/whether this lands.

### POR-5 — Messaging on service entities (optional, later)

Portal's contextual messaging (the activities/communication sidebar) is register-generic — verified in source, it rides on ERP records and is mounted across invoices, quotations, deliveries, sales orders, contracts and more. The real gap is that service entities aren't portal ERP registers; the nearest bridge is the booking's `ActVc` activity, which the sidebar could target if the portal ever surfaces service entities. If that happens, we'd consume the threads via POR-4-style events. Fallback (default): service communication goes through our notifications + email.

## Suite-wide

### SUITE-1 — Identity decision (Phase 0 decision, no build required)

Verified from source: every suite app runs its own independent Auth.js instance; there is **no cross-app SSO** today. Decide deliberately: either the suite invests in a shared identity provider (staff SSO across calendar/portal-admin/service), or apps stay separate and we stop promising "suite SSO" anywhere. herbe.service is built to work either way (`05-users-auth.md`); customer-side portal identity should stay separate regardless.

### SUITE-2 — Repository access for development — resolved 2026-07-04

The dev environment's `BITBUCKET_APP_PASSWORD` authenticates the Bitbucket REST API against the `burti` workspace: file reads (`/2.0/repositories/burti/<repo>/src/...`) and full source archives (`bitbucket.org/burti/<repo>/get/main.tar.gz`) both work; git-protocol clone does not, and isn't needed. The empty GitHub mirrors are now optional convenience, not a blocker.

### SUITE-3 — Published theme-token vocabulary — closed/shipped

The design-system repo now exists and is canonical: `tokens.css` names the canonical value for every token where the two apps diverged (portal's Tailwind `@theme` Burti brand tokens — `--color-burti-*`, `--brand-*` aliases — vs the calendar's semantic `--app-*` layer), with a reconciliation guide saying which side aligns; `handovers/SERVICE.md` is a ready, prioritised design brief for herbe.service (field density tier, sunlight/high-contrast scheme), sourced from `14-design-handoff.md`. Action: **consume the canonical repo** — do not transcribe portal tokens from source; `14-design-handoff.md` retargets to the repo. No ask remains on the sibling teams.
