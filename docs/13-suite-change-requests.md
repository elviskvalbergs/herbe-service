# herbe.service — Change Requests for herbe.calendar & herbe.portal

Status: draft v0.2 (2026-07-04). Audience: the Burti suite team; this is the Phase 0 coordination agenda from `06-roadmap.md`, written as concrete, individually decidable requests. Basis: `08-suite-integration.md` (integration design), the sibling apps' source review (`03-architecture.md`, `04-erp-sync.md`), and herbe.calendar's public docs.

**Framing: nothing here blocks the MVP, and herbe.service is a standalone product** — it ships its own deployment, and its tokenized customer links close the loop even without the siblings. The primary customer surface for portal tenants is the **portal service modules** (decided 2026-07-04; design spec delivered to the portal repo), so POR-4 below is superseded by a committed plan; the remaining portal asks are integration touchpoints. Tier 0 — the ERP as the shared bus (`ActVc` activities, invoices) — requires **zero code changes** in either sibling app; it needs only configuration agreements (CAL-1, CAL-2, POR-2). Everything else buys latency, coverage, or one-window convenience, and each request lists its fallback so it can be declined or deferred without breaking herbe.service's roadmap.

## Summary

| ID | App | Request | Needed by | Type | Fallback if declined |
|---|---|---|---|---|---|
| CAL-1 | calendar | Shared activity-type & workflow-stage conventions | Phase 0 | config agreement | none needed — must agree, zero code |
| CAL-2 | calendar | Echo-tagging convention for `ActVc` writers | Phase 0 | config agreement | heuristic self-echo detection (fragile) |
| CAL-3 | calendar | Documented API-token endpoints + activity webhook or delta API | Phase 2–3 (tier 1) | new feature | tier 0 polling, ICS feeds |
| CAL-4 | calendar | Smart Booking: service-intake template fields (asset reference) | Phase 3 | small feature | free-text serial field + QR-prefilled booking links |
| CAL-5 | calendar | Availability query API (merged busy-times) | Phase 4 | new feature | herbe.service checks only its own bookings |
| POR-1 | portal | Invoice ↔ service order cross-link in portal UI | Phase 3 | small feature | customer matches by invoice text reference |
| POR-2 | portal | Delivery-confirmation flow accepts our documents (activity vessel) | Phase 3 | config/small feature | herbe.service's own approval link + canvas signature |
| POR-3 | portal | Cross-links from portal to herbe.service customer pages | Phase 3 | small feature | customer uses our links from email/QR only |
| POR-4 | portal | ~~Native service-data feed~~ — **superseded/committed 2026-07-04**: portal service modules reading `/api/ext/v1` (design spec delivered) | service Phase 2 (API) / portal Phase 3 (UI) | committed | tokenized links carry the flows for non-portal tenants |
| POR-5 | portal | Messaging threads on service entities | optional, later | feature | portal messaging stays invoice-only; service questions via email |
| POR-6 | portal | Token-authenticated "send quotation for approval" API | Phase 3 (quote flow) | small feature | human sends from the portal quotation view, or service emails its own tokenized approval link |
| SUITE-1 | both | Suite identity decision (shared IdP or stay separate) | Phase 0 (decision) | decision | stay separate — herbe.service is designed for it |
| SUITE-2 | both | ~~Repo access~~ — resolved: `BITBUCKET_APP_PASSWORD` works via REST API | — | done | mirrors optional convenience |
| SUITE-3 | both | Shared theme-token vocabulary published as a reference | Phase 0–1 | docs | herbe.service transcribes portal's tokens from source (started — `14-design-handoff.md`) |

## herbe.calendar

### CAL-1 — Activity-type & workflow-stage conventions (Phase 0, config only)

Tier 0 interop rides on both apps mapping the **same** activity types and workflow stages. Asks:

1. Share the register/field names the Kanban writes when a card is dragged (the public docs describe the behavior but not the fields; our adapter must write/read the same workflow-stage field).
2. Agree a recommended activity type + symbol set for service bookings (per tenant, but with a suite default), so a herbe.service booking renders correctly in calendar views and its Kanban out of the box.
3. Agree how a multi-person (crew) activity's stage change behaves in the Kanban — one card or per-person cards — so our N-bookings ↔ 1-activity mapping (`04-erp-sync.md`) round-trips.

### CAL-2 — Echo-tagging for `ActVc` writers (Phase 0, config only)

Both apps write the same register; without a convention, each app's poll re-imports its own (or the other's) writes and can ping-pong updates. Ask: agree a marker — e.g. a reserved prefix/field carrying the originating app + record UUID — that every suite writer sets and every suite reader uses to suppress self-echoes. herbe.service already plans idempotency by app UUID (`04-erp-sync.md`); this request is to make it a *suite* convention rather than ours alone.

### CAL-3 — Documented API endpoints + event push (tier 1, Phase 2–3)

Calendar has read/write Bearer API tokens today, but the endpoint list is not public, and there are no webhooks. Asks, in increasing order of effort:

1. **Document the existing token API** (activities read/write) so herbe.service can publish bookings directly for standalone (no-ERP) tenants.
2. **Webhook on activity create/move/stage-change** (HMAC-signed, per-tenant registration) *or* a delta endpoint (`?updates_after=` style — the suite already speaks that dialect) so calendar-side changes reach herbe.service in seconds instead of the ~30 min tier-0 poll loop.

Fallback: tier 0 covers ERP-connected tenants at poll latency; per-technician ICS feeds (already a supported calendar source) give read-only visibility of herbe.service bookings with no calendar-side work.

### CAL-4 — Smart Booking service-intake fields (Phase 3)

Smart Booking templates with an ERP target already create activities with custom fields — that is our self-scheduling intake (`08-suite-integration.md`). Missing for a good service request: an **asset reference**. Ideal: a custom-field type that accepts an external reference (we pre-fill it via QR deep link — the sticker on the machine opens the booking page with the serial already set). Fallback: plain text field for serial + our QR-prefilled links; conversion still works, just without validation at booking time.

### CAL-5 — Availability API (Phase 4)

Calendar already merges busy-times across ERP/Outlook/Google per person. Our scheduling assist should query that merge instead of rebuilding it. Ask: an endpoint "busy windows for person X in range Y" on the token API. Fallback: herbe.service suggests slots from its own bookings only.

## herbe.portal

The portal hosts the primary customer surface as **service modules** reading our `/api/ext/v1` API (decided 2026-07-04; `herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`); herbe.service additionally keeps tokenized customer links for QR/ETA/report/feedback flows and for tenants without portal (`08-suite-integration.md` §4). POR-1..3 remain integration touchpoints; POR-4 is superseded.

### POR-1 — Invoice ↔ service order cross-link (Phase 3, small)

Invoices from our approved worksheets already reach the portal through its ERP feed. Ask: render a link/reference from the invoice view to the originating service order (we guarantee the ERP invoice carries the order reference; the link can target our tokenized order-status page), so "what was this for" is one tap. Pure UI addition on data that's already there.

### POR-2 — Delivery-confirmation flow for service documents (Phase 3, mostly config)

Portal already routes documents to customers for approval and Smart-ID/Mobile-ID signature (delivery confirmations). `12-documents-templates.md` reuses exactly that flow for *qualified* signatures, with the `ActVc` activity as the vessel: our generated document attaches to an activity via record links; the portal presents it like a delivery confirmation; the outcome returns as the activity's workflow stage. Ask: confirm this generalization — specifically that (a) the portal's flow can be configured to pick up our activity types, and (b) the outcome writes a stage + comment we can poll. If their flow is invoice/delivery-hardcoded, this becomes a small feature request. Fallback: our own emailed approval link + on-site canvas signature (the baseline for tenants without portal anyway).

### POR-3 — Cross-links to herbe.service customer pages (Phase 3, small)

Where a customer already lives in the portal, let them reach the service flows in one tap: portal navigation/dashboard links out to our tokenized pages (equipment, order status, reports) for suppliers that run herbe.service. Plain links, no data integration. Fallback: customers reach our pages from email notifications and QR labels only.

### POR-4 — Native service-data feed (optional, later)

**Superseded — this is now the committed plan** (2026-07-04): the portal grows service modules (service items + history, orders/worksheets incl. request intake, report signoff) reading herbe.service’s `/api/ext/v1` with scoped bearer tokens; full design in `herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`, service-side contract in `08-suite-integration.md` §4. herbe.service’s tokenized links remain the surface for non-portal tenants and for QR/ETA/feedback flows.

### POR-6 — API to trigger quotation sending (Phase 3, small)

Verified in portal code: `POST /api/c/{companyId}/quotations/{sernr}/send` already emails the share-token link to chosen recipients — but it requires an authenticated portal user session + CSRF header, so herbe.service cannot call it after pushing a quote into `QTVc` (`04-erp-sync.md` quote flow). Ask: a token-authenticated variant (same bearer-token pattern as the other service↔portal calls) taking `{sernr, recipients?}` — recipients defaulting to the customer's confirmed identity-link contacts — so quote delivery is automated end-to-end. Fallback: the quote still lands in the portal's quotations module; a human sends it from the quotation view, or herbe.service emails its own tokenized approval link.

### POR-5 — Messaging on service entities (optional, later)

Portal's contextual messaging exists on invoices. If extended to service orders/worksheets, we'd consume the threads via POR-4-style events. Fallback (default): service communication goes through our notifications + email.

## Suite-wide

### SUITE-1 — Identity decision (Phase 0 decision, no build required)

Verified from source: every suite app runs its own independent Auth.js instance; there is **no cross-app SSO** today. Decide deliberately: either the suite invests in a shared identity provider (staff SSO across calendar/portal-admin/service), or apps stay separate and we stop promising "suite SSO" anywhere. herbe.service is built to work either way (`05-users-auth.md`); customer-side portal identity should stay separate regardless.

### SUITE-2 — Repository access for development — resolved 2026-07-04

The dev environment's `BITBUCKET_APP_PASSWORD` authenticates the Bitbucket REST API against the `burti` workspace: file reads (`/2.0/repositories/burti/<repo>/src/...`) and full source archives (`bitbucket.org/burti/<repo>/get/main.tar.gz`) both work; git-protocol clone does not, and isn't needed. The empty GitHub mirrors are now optional convenience, not a blocker.

### SUITE-3 — Published theme-token vocabulary (Phase 0–1, docs)

Both sibling apps implement "the herbe design system" from handover docs, with different tech (`03-architecture.md`): the portal's Tailwind `@theme` Burti brand tokens (`--color-burti-*`, `--brand-*` per-deployment aliases, from `burti-id-brandbook-1909.pdf`) and the calendar's semantic `--app-*` layer. For one tenant branding to span apps, the token vocabulary (names + semantics, not implementations) should be a published suite reference rather than two private docs. The current state of both is captured in `14-design-handoff.md`, which also specifies what herbe.service additionally needs.
