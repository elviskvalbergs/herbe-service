# herbe.service — Suite Integration & Reuse (herbe.calendar, herbe.portal)

Status: v0.8 (2026-07-08). Customer signoff is **order-level** and resendable: the portal requests the combined order report (`GET /api/ext/v1/orders/{id}/report`, all approved worksheets in one document) and posts the decision to `POST /api/ext/v1/orders/{id}/confirm` (`confirmed | rejected`); a rejection keeps the order open for more work and re-signoff. Satisfaction feedback (order-level, a separate axis) rides the same confirm call or a standalone `POST /api/ext/v1/orders/{id}/feedback`. All committed direct portal→service calls (not ERP-mediated) in the §4 technical contract; confirmation is independent of the worksheet-level ERP push. The portal is the only customer-facing surface; service ships no customer pages, and direct service↔portal integration is reduced to the worksheet- and quotation-approval triggers plus tentative label/QR, everything else via the ERP (the wider `/api/ext/v1` contract stays unfrozen until the portal module settles). "signoff" is the umbrella term for the customer-approval/signature triggers POR-2/6/7 (§4); the shadow-activity Kanban is existing calendar board configuration — columns filter on `(ActType, ActState)` (`lib/pipeline`), states are service-defined and service-seeded, so no new calendar build is needed (§3). Written from code-level review of both sibling repos (calendar `main`-merge b57fcbd, portal v1.0.24).

## 1. Suite reality (verified, not assumed)

| | herbe.calendar | herbe.portal | herbe.service (this spec) |
|---|---|---|---|
| Role | Employee scheduling over ERP activities + Outlook/Google/Zoom; Kanban boards over ERP pipelines; Smart Booking share links | Customer self-service over ERP registers (invoices, quotations, deliveries, e-sign, payments) | Field service execution (orders → work → approval → ERP invoice) |
| Stack | Next.js 16, React 19, Tailwind 4, Neon + raw `pg`, Auth.js v5 | Next.js 16, React 19, Tailwind 4, Neon + Drizzle, Auth.js v5 | same; Drizzle on **Supabase Postgres** (decided 2026-07-04) |
| Tenancy | one deployment, many `tenant_accounts` | one deployment + one Neon DB **per customer** (provisioning CLI) | both, resolved 2026-07-05: multi-tenant core (calendar pattern) + dedicated deployments for whitelabel (portal pattern) — `03-architecture.md` |
| Auth providers | email magic-link only | password+TOTP, magic link, Google, Smart-ID, Dokobit, eParaksts | role-shaped: magic link office, PIN+biometrics field (`05-users-auth.md`) |
| ERP client | `lib/herbe/*`: REST + `updates_after`/`@sequence`, OAuth refresh, two-way `ActVc`, WebExcellentAPI | `lib/erp/*`: `ErpAdapter` contract, register cache + sync runner, WebExcellentAPI (PDF, attachments, activities), write-backs (QTVc patch) | extends portal contract + calendar's incremental/write mechanics (`04-erp-sync.md`) |
| i18n | none | next-intl, `lv,en,et,lt,fi,sv,no` + per-deployment overrides | portal setup reused |
| Cross-app links | `hansa://{serp_uuid}/v1/{company}/{register}/{id}` deep links | same scheme ("lifted from herbe-calendar so behavior is consistent") | same scheme + web deep links below |
| Shared packages | none — conventions are copied between repos, with attribution comments | none | drive extraction (§6) |

**Key consequence:** there is no suite event bus, no outbound webhooks, no shared identity provider, and no shared library today. Integration designs below use only mechanisms that already exist (ERP `ActVc` as a shared backbone, scoped bearer tokens, deep links) plus one new thing: herbe.service's own typed REST API.

## 2. Integration principles

1. **The ERP is the shared backbone wherever a tenant has one.** Calendar and service both speak two-way `ActVc`; the portal reads/writes the same registers. No point-to-point sync for data the ERP already carries.
2. **For app-owned data (worksheets, pre-approval statuses), the owning app exposes a typed REST API** consumed with scoped bearer tokens (portal's `analytics_tokens` pattern: hashed token, scope enum, company scoping).
3. **Deep links over embedded UI.** Each app renders its own domain; cross-app navigation via stable URLs (`https://service.herbe.app/c/{tenant}/orders/{id}`, portal/calendar equivalents) and `hansa://` for the ERP desktop client. Customer-facing links always point into the portal (§4).
4. **Capability gating everywhere**: a tenant without herbe.calendar, without herbe.portal, or without an ERP simply doesn't see the corresponding affordances (portal's WebExcellentAPI gating discipline, applied suite-wide).

## 3. Calendar ↔ service: booking planning

**Tier 0 — via the ERP (primary path, works at launch).** Bookings mirror to `ActVc` per `04-erp-sync.md` (multi-person crew activities, workflow state via `ActType`/`ActState`, native Service Order/Service Item fields, two-way notes, echo suppression); herbe.calendar already renders and edits `ActVc` two-way. Result without any calendar code change: a booking planned in herbe.service appears on the technician's calendar (and Outlook, via calendar's own sync), and an activity created/moved in calendar or ERP flows back into service on the fast poll. Latency = sum of both apps' poll cadences (our 1–5 min + calendar's 15–60 min). Conflict rule: service accepts inbound moves unless the linked worksheet is `In progress` or later — then the move bounces to the dispatcher's inbox (a booking can't retroactively contradict executed work).

**Shadow-activity status mirror — how managers find work needing action.** Each worksheet carries a `worksheetShadow` activity (`ActVc`); each service order likewise gets a status-shadow activity on the same pattern. On every status transition, herbe.service mirrors the record's status onto the shadow activity's workflow state (`ActState`) with an outbound `ActVc` write (the calendar's `actVcSave` mechanics). Managers then work a **Kanban of these shadow activities** — columns are `ActState` — in herbe.calendar *or* in the ERP: a worksheet in `Approved` (or any configured state) surfaces as a card in that column; the manager opens the linked record — natively in the ERP (record link) or via a login-routed deep link into herbe.service — and does the OK. The OK itself stays a manual ERP-side action for now. **herbe.service owns both status→`ActState` maps itself**: worksheet-status→`ActState` and order-status→`ActState` are a per-connection service-side setting, and service seeds the matching `ActState` records (code + name) into the ERP via a one-click setup tool. Nothing here is negotiated with the calendar team — the state values are service-defined and service-seeded. The shadow activity also carries the worksheet's time (the workSegment/time purpose), so ERP-side time reporting works off the same record. **The manager's shadow Kanban needs no new calendar build**: it is an existing herbe.calendar feature — a board whose columns filter on `(ActType, ActState)` (`lib/pipeline`, `lib/herbe/taskRecordUtils.ts`), configured with columns = the service-defined `ActState` codes — or an equivalent ERP-side Kanban over the same activities. The only calendar asks that remain are the niceties CAL-6…CAL-8 (`13-suite-change-requests.md`); the booking activity-type/state values are still nice to share as a suite default (CAL-1), but not blocking.

**The Kanban board: delegate, don't duplicate.** herbe.calendar's Kanban renders ERP activity pipelines with drag-to-update — verified in source: board columns are `(register, register_filter)` pairs synced from ERP views, and a card drag PATCHes `/api/activities/[id]` with **`ActType`/`ActState`** (there is no separate "workflow stage" field). (1) **Office-side status board = herbe.calendar Kanban**: we mirror order/worksheet status into the (shadow) activity's `ActType`/`ActState` (mapping in adapter config); a state dragged in calendar comes back through the activity and is validated by our status state machine — illegal transitions bounce. (2) **herbe.service builds no general Kanban**: our Phase 1 dispatch board stays what Kanban can't be — a time × technician capacity board with an unassigned pool and a map. (3) Status→`ActType`/`ActState` mapping is tenant config, versioned with the register maps.

**Smart Booking as an intake channel (Phase 2).** A herbe.calendar booking template targeting our service intake activity type (+ custom fields: site, serial, fault) becomes a **self-scheduled service request**: the customer books a slot that respects the technician's real availability; the activity arrives via tier 0 and service converts it to ServiceOrder + Booking (intake-type rule, `04-erp-sync.md`). This is the 80 % of D365's self-scheduling at ~0 build cost; the asset-reference field ask is CAL-4 (`13-suite-change-requests.md`).

**Service-aware calendar features (new work in herbe-calendar, phased with service Phase 1–2; raised as CAL-6…CAL-8 + CAL-5 in `13-suite-change-requests.md`):**
- **C1 — service activity recognition (CAL-6)**: per-account config mapping service activity types; recognized activities get a service badge/color class group.
- **C2 — service context on the activity (CAL-7)**: `ActivityDrawer`/`ActivityBlock` show order number, site, worksheet status for recognized activities (read from the agreed `ActVc` fields service already writes); an **"Open in herbe.service"** deep-link button.
- **C3 — guarded editing (CAL-8)**: recognized service activities that are `OKFlag`-locked or execution-started are read-only in calendar; free re-planning while the booking is `planned/confirmed`.
- **C4 (later, service Phase 3)** — availability feed for dispatch assist: service queries calendar's merged busy-times (`lib/availability.ts`) through a scoped API token (CAL-5).

**Tier 1 — direct suite integration (optional, latency/coverage upgrade):** service → calendar via calendar's existing Bearer-token API or per-technician ICS feeds (already a supported calendar source — nearly free read-only path, also the standalone-tenant fallback); calendar → service needs a webhook or delta endpoint (CAL-3). Standalone tenants: calendar integration is an ERP-tenant feature in v1; their technicians live in service's own My-jobs calendar.

## 4. Portal ↔ service: customer surface, signoff, invoices

**Division of labor — FINAL (owner, 2026-07-05): anything that requires customer input or is the customer's business lives in herbe.portal. herbe.service ships no customer-facing surface at all.** Portal already owns customer login (incl. eIDs), notification prefs, invoice display + payment, e-signing.

**Reduced direct integration — owner decision, 2026-07-07.** The portal service module is being developed **independently** on the portal side and must stand on its own, with limited functionality, even without herbe.service; what exactly it becomes is still moving. The **only** direct service↔portal coupling in the near term is the **signoff** API calls (customer signoff) — the confirmation/approval-trigger calls; nothing reads across the wire:

1. **Order signoff trigger** — API endpoints for triggering order signoff (the signoff flow below, `POST /api/ext/v1/orders/{id}/confirm`), plus the portal-requestable combined order report (`GET /api/ext/v1/orders/{id}/report`) it presents.
2. **Quotation signoff trigger** — API endpoints for triggering quotation signoff (quote lands in `QTVc`, the signoff trigger is POR-6; the decision flows back through `QTVc`).
3. **Document signoff trigger (POR-7)** — the token-authenticated "send delivery-confirmation / signing request" call for customer signoff, carrying only a reference (`activityId`, optional `documentId`), never document content.
4. **Possibly label/QR** — the portal side of the QR resolver (§4a) stays on the table, unconfirmed.

**The ERP is the connecting piece for all actual data.** The portal reads service data — invoices via `IVVc`, quotes via `QTVc`, bookings/activities via `ActVc`, and anything the wider module surfaces — **from the ERP, never from herbe.service**. The three signoff triggers above only carry a reference across the wire to fire a notification or fast-path a sync; the underlying data always travels service → ERP → portal via the portal's own ERP sync. **Portal reading data directly from herbe.service is a future step**, taken once the portal service module's shape settles. The wider customer window sketched in earlier rounds (equipment registry + history, request intake, order tracking incl. the "technician on the way" ETA view, approved-worksheet read-out, satisfaction feedback) is the **portal team's own scope**; herbe.service adapts once its shape settles.

The portal repo carries the portal team's v1 design note (`herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`, 2026-07-04, incl. `service_connection_config`) — now their working document for the independent module. The wider `/api/ext/v1` contract this spec previously called frozen (v1.1: QR resolver route, ETA view, feedback module, list endpoints, the client-DTO appendix with per-field ERP provenance from `17-erp-register-reference.md`, indicative-prices disclaimer, `erpProcessed` timeline event, `RLinkVc`-first invoice cross-link) is **downgraded from frozen to future** — it gets re-cut against the portal module's actual shape once that settles; the verified DTO/provenance work is kept as input, not contract. Tenants without portal: customer touchpoints are the emailed report PDF and the on-site canvas signature — the portal is the upgrade path, not a competing service UI.

**Invoices**: nothing new — the portal's existing invoice module (IVVc + ARVc + payment gateways) covers invoices created from approved worksheets; service guarantees the ERP invoice carries the order reference (`04-erp-sync.md` back-link) so the portal can show "from service order X" (cross-link ask: POR-1).

**Quotes**: out-of-contract quotes push to `QTVc` (`04-erp-sync.md` quote flow); the portal's existing quotations module covers confirmation. Note from code review: the public share link covers *viewing*; accept/reject requires portal login + confirmed scope.

**Signoff — two scopes, portal-set method**: signoff is configured on two independent axes (`02-data-model.md`). **Scope** = `require_worksheet_signature` (on-device, per-worksheet — captured by the technician at `Done`, needs no customer-facing interface, so it's the **portal-less baseline**) and/or `require_order_signoff` (order-level, customer-facing). **Method** = `confirm | sign | digital_sign`, a herbe.portal setting (the `SigningModuleDescriptor`); only the portal path can escalate to a qualified `digital_sign` (Smart-ID / Mobile-ID). The order-level path (this section, POR-2/6/7) covers the order service report, quotations and compliance documents: once all the order's worksheets are manager-approved, the portal requests the **combined order report** (`GET /api/ext/v1/orders/{id}/report` — all approved worksheets rendered as one document) and presents it, then `onDecision` → `POST /api/ext/v1/orders/{id}/confirm`, which writes `CustomerConfirmation` on the order (`02-data-model.md`) and attaches the signed file to the order's ERP activity (orderShadow / `SVOVc`) where WebExcellentAPI allows. **The call is resendable**: a `rejected` decision keeps the order open — the office adds a booking + worksheet, and the portal re-requests the (regenerated) report and signoff. Confirmation is independent of the worksheet-level ERP push: parts/time are accounted on manager approval regardless, so a not-yet-confirmed order never strands consumed stock/time. The `ActVc` **activity-vessel** route through the portal's delivery-confirmation flow remains a config-level fallback for compliance documents (POR-2, `12-documents-templates.md`); with no portal, the order-report on-site signature (or the per-worksheet signature) is the baseline.

**Technical contract (reduced, owner 2026-07-07):**
- **Phase 1 (framework only)** — the `/api/ext/v1` shell: hashed scoped bearer tokens per company connection, admin minting UI, auth, and rate limiting from day one (429 + `Retry-After`; calendar's `lib/rateLimit.ts` pattern). The signoff / report / feedback endpoint *shapes* are designed against this contract in Phase 1, but the endpoints themselves go live in Phase 2 — they write Phase-2 entities (`CustomerConfirmation`, `CustomerFeedback`), so placing them earlier would be a phase-crash.
- **Phase 2 (customer experience)** — the customer **signoff** + feedback endpoints, all committed direct portal→service (not ERP-mediated): `GET /api/ext/v1/orders/{id}/report` (the combined order report the portal presents), `POST /api/ext/v1/orders/{id}/confirm` (order signoff, resendable; `confirmed | rejected` + optional `reason` + optional `feedback {rating, comment}`, writing `CustomerConfirmation` on the order), the standalone `POST /api/ext/v1/orders/{id}/feedback` (later survey, order-level, a separate axis from confirmation), the quotation signoff trigger pair (POR-6; the accept/reject decision returns through `QTVc`), and the document signoff trigger (POR-7; reference-only). Feeds per-technician/customer/period reporting.
- **Tentative** — `labelId=` QR resolution for the portal side of §4a, if the label integration is confirmed.
- **Future (re-cut when the portal module settles; no longer frozen)** — the wider read API: `GET /api/ext/v1/…` service items (+ tree paths), orders (detail incl. booking slots, `enRoute` flag, ETA), approved worksheets, history; `POST /api/ext/v1/requests` (idempotency key required). List endpoints take `customerCodes=` + `after=<changeSeq>`.
- **Customer-visible order status** (kept as the working draft for the future contract — the internal 9-state order machine is never exposed verbatim): `New/Accepted → received`, `Planned → scheduled` (+ slot), `In progress → in progress` (+ `enRoute` flag; a paused *worksheet* still shows the order in progress — `Paused` is a worksheet state, not an order state), `Work done/Confirmed → work done`, `Invoiced/Closed → completed`, `Cancelled → cancelled`.

**§4a — QR labels (one sticker, two audiences).** One physical label per service item node encodes **one resolver URL** carrying the node's stable `labelId` (`02-data-model.md`); routing is by login: technician with the app → service item card (F6); portal customer → portal `service-items/[id]` (tentative — item 3 of the reduced integration, resolved via `labelId=`); unknown visitor → login choice; unknown/unscoped label → friendly "not available", no data leak. **The URL scheme is fixed in Phase 1 before the first label is printed** — stickers outlive software; the portal route joins if/when the label integration is confirmed.

**§4b — Notification ownership** (one table so no email is sent twice or never; all portal links assume portal login; every channel is email-only in practice — portal SMS/in-app are stubs). **Target state**: rows owned by herbe.portal apply as the portal module lands and defer with it; under the reduced near-term integration, herbe.service's own emails (with the report PDF attached) carry the customer touch:

| Event | Sender | Template system | Link target |
|---|---|---|---|
| Request received (ack + order number) | herbe.portal | portal `service_request_received` | portal order page |
| Booking confirmed / changed; rejection notices to technicians | herbe.service | service templates (copied TemplateKey engine) | app / portal order page |
| "Technician on the way" + ETA | herbe.service | service templates | portal order detail (ETA view) |
| Work done + report ready (+ signoff invite when signoff enabled) | herbe.portal | portal `service_work_done` (+ existing `signing_invite`) | portal order detail |
| Report PDF to customer (Phase 1, pre-portal) | herbe.service | service templates, PDF attached | attachment only |
| Satisfaction survey ask | part of work-done email | herbe.portal | portal feedback block |
| Quote to confirm | herbe.portal (triggered by service, POR-6) | portal quotation templates | portal quotations module |
- **Token scoping**: one hashed bearer token per (service deployment, **company connection**) — matching the portal's per-`erp_company_id` `service_connection_config`; all data scoped to that company; the caller's `customerCodes` narrow, never widen, the token's own customer-code scope. Minted/revoked in service admin, stored portal-side envelope-encrypted.
- Webhook-less v1: portal fetches on page view; `changeSeq` deltas keep polls cheap (future read API; the near-term triggers are single POSTs and need neither).

**Portal-side implementation notes (relay to the portal doc owner — from this session's code pass):** `getUserScopeForCompany` is deliberately module-local in `app/c/[companyId]/invoices/_lib/scope.ts` and needs extraction to `lib/` before the service modules can use it; `SigningModuleDescriptor` also requires `pdfFilename` and `activitySubject`, and its `onAllSigned(adapter, …)` receives the ERP adapter — the service descriptor ignores it and POSTs to service instead; SMS/in-app template channels are stubs (email-only in practice); portal cron is actually driven by the external ops-runner per its own `CRON-HANDOFF.md`, despite `vercel.json` carrying cron entries.

## 5. Users & identity across the suite

- Employee identity: service reuses calendar's `person_codes` concept for user↔ERP-employee mapping (`05-users-auth.md`); where a tenant runs both apps against one ERP, the mapping data is the same and should be entered once — Phase 1: import/sync person links from calendar's table or via a small admin import.
- Customer identity: portal's `identity_links` stays portal-owned; service's customer-scoped data is keyed by ERP customer codes, which is the shared key. Service has no customer-facing visitors of its own.
- SSO: not built anywhere today (§1); deferred by decision (`05-users-auth.md`, SUITE-1 in `13-suite-change-requests.md`).

## 6. Reuse inventory & mechanics

Ranked by value; "coupling" = what must be untangled to reuse outside the source repo.

| Asset | Source | Coupling | Plan |
|---|---|---|---|
| `ErpAdapter` contract + registry + credential envelope | portal `lib/erp/{types,registry,credentials}.ts` | types.ts is import-clean; registry/creds touch portal DB | **Extract to `@herbe/erp-core`** (Phase 0) |
| Standard Books REST + WebExcellentAPI clients, mappers, typed errors + maintenance guard | portal `lib/erp/standard-books/*` | clients are DB-free; cache stores are Drizzle-bound | Extract clients+mappers; service implements its own cache stores on the shared pattern |
| `updates_after`/`@sequence` incremental sync, OAuth refresh, `ActVc` save (form-encoding, row chunking, `parsePersons`) | calendar `lib/sync/erp.ts`, `lib/herbe/{client,actVcSave}.ts` | moderate (calendar tables) | Fold the mechanics into `@herbe/erp-core`; calendar migrates opportunistically |
| Email template engine (TemplateKey/TemplateDataMap/CHANNELS, render, admin editor) | portal `lib/email/*` | render layer DB-free; dispatch reads `email_config` | Copy-first (Q3 decision — overlap not big enough to justify a shared package); service owns its dispatch/config tables |
| Signing subsystem (Dokobit/eParaksts/Smart-ID gateways, runners, typed signature pad) | portal `lib/{signing,dokobit,eparaksts,smartid,signature}` | gateways DB-free; runners bound to `signing_*` tables | Phase 2, used portal-side (§4) — no extraction needed initially |
| Auth.js config, credentials/TOTP/magic-link providers, session-version | portal `lib/auth/*` | bound to portal user tables | Copy-first into service schema; extraction later |
| i18n setup + locale files structure + overrides admin | portal `lib/i18n/*`, `locales/` | light | Copy-first |
| Cron conventions — `CRON_SECRET` bearer auth is genuinely shared; locking and scheduling differ: portal uses pg advisory locks + the external ops-runner drives production (its `CRON-HANDOFF.md`), calendar uses a table-based lock (advisory locks don't survive Neon serverless pooling) with Vercel cron authoritative and the runner script as fallback | portal / calendar (see left) | none | Copy-first; pick the lock per hosting (Supabase pg session-pooling → prefer the table-based lock) |
| Migration runner (build-time + admin UI) | portal `scripts/migrate-prod.mjs`, `/admin/run-migrations` | light | Copy-first |
| Provisioning CLI (per-customer projects + domains) + `customers.yaml` fleet inventory | portal `lib/provisioning/*`, `bin/provision.ts` | portal-specific env | Adapt (Neon→Supabase Management API) per tenancy decision |
| Admin shell, register list/detail components, status badges, theming | portal `components/*`, `lib/theming` | Tailwind tokens; medium | Copy-first, align via the design-system repo — it exists and is canonical (`tokens.css` + `handovers/SERVICE.md`; SUITE-3 closed) |
| Docs wiki loader + DocLink | portal (`DocLink`) / calendar (loader) | light | Copy-first |
| Deep links (`hansa://` builder) | calendar `lib/serpLink.ts` (already copied into portal) | none | Copy (third consumer strengthens the case for `@herbe/erp-core`) |
| Scoped bearer tokens (hashed, company-scoped) | portal `analytics_tokens` + `lib/mcp/auth` / calendar `api_tokens` | light | Copy pattern for `/api/ext` (§4) |
| APNs + native iOS shell + mobile token pairing | calendar `ios/`, `lib/apns.ts`, `lib/mobileAuth.ts` | moderate | Phase 1/2 reference when native wrapper lands |
| AES-GCM credential crypto | calendar `lib/crypto.ts` / portal `lib/security/envelope.ts` | none | Use portal's envelope format (key-id + rotation-friendly) |

**Mechanics — FINAL (Q3 delegated to tech lead, decided 2026-07-05):** extract **only `@herbe/erp-core`** — the one asset where the overlap is genuinely large (REST + WebExcellentAPI clients, typed errors, write mechanics, mappers; service would be the *third* copy) and the churn cost of divergence is proven (the suite already carries two ERP clients and two crypto formats). **Everything else, including the email-template engine, is copy-first with attribution** — shared packages are a hassle, and none of the rest clears the bar. Timebox stands: if `@herbe/erp-core` extraction exceeds two weeks, copy-first and extract in Phase 1.

## 7. End-to-end workflow across the suite

Target state. The rows landing in the portal's *service modules* ride the future read API (§4) and arrive when the portal module settles; everything through the ERP column works from launch.

```
 herbe.calendar            herbe.service                    ERP                    herbe.portal
──────────────            ─────────────                    ───                    ────────────
 plan/move activity ────► crew bookings (ActVc, multi-person)
 Kanban drag stage ─────► status change (validated)
 Smart Booking intake ──► ServiceOrder + Booking
                          dispatch → worksheet per technician (crewGroupId)
                          execute offline, sign on site
                          manager approves ────────────► worksheet (push group)
                                                          invoice created
                          order → Invoiced  ◄──────────── IVVc read-back ────────► invoice module (pay)
                          quote draft ──────────────────► QTVc ──────────────────► quotations module (confirm)
                          service report PDF ─────────────────────────────────────► service modules (view/signoff)
                          history event                                             service-items history
                          QR label / notification links ────────────────────────────────────► portal service modules
```
