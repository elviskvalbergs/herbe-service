# herbe.service — Phase 2 Implementation Plan

Status: v1.3 (2026-07-15). Scope: **roadmap Phase 2 — "Contracts, recurring service, customer experience"** (`06-roadmap.md:76-90`), the band that was old Phase 3 before the round-5 collapse (`20-spec-review-round-5.md:35`, decision #18). Phase 1 ("The product", plan in `21-phase-1-implementation-plan.md`) is **in progress and landing in waves on `preview`** (ext-read, erp-connection, svoser-ingest merged as of 2026-07-15); this plan takes its outputs as **given at P1 exit** — §3 tracks each seam's current status — but does not re-plan them, exactly as the P1 plan treated Phase 0.

Owner decisions folded in (2026-07-14): recurring generation is **app-side logic** that drives ERP activities so the ERP sees them identically (§4 P2-WS2, resolves the §8 freeze gate); **Reporting v1 ships only the metrics runnable on data we own today** — first-time-fix, MTTR, top-devices (count), doc-11 coverage metrics — while revenue-per-technician (no `IVVc`-row→tech link; `04:142` records this), utilization (no working-hours config yet), and failure-rate (no install base) are **deferred until the data exists** (§4 P2-WS10); **SLA indicators are deferred to Phase 3** (nice-to-have; the coverage-calendar/timezone/holiday surface isn't worth blocking Phase 2) — the design is retained in §4 P2-WS3 and the roadmap line moved (`06:96`).

Review pass 2026-07-15 (v1.3): signoff model stated per owner — worksheet-level on-device confirmation is the **only** signoff without a portal; with a portal, final acceptance is the **order-level signoff in herbe.portal**, which fetches the combined report via the API (§2); the early-shipped `/api/ext/v1` read endpoints accepted as provisional (§2); §3 rows annotated with real status; P2-WS2 aligned to `23-recurring-service-overlay.md`; CAL-9/CAL-10 added; stale cites refreshed.

Same shape as doc 21: a work-package / sequencing plan — what to build, in what order, reuse vs. build, how each package is tested, what still gates a calendar estimate. Not a re-spec; the truth lives in docs 02–13. Line cites point there.

---

## 1. What Phase 2 delivers (exit criteria, from the roadmap)

Two acceptance targets (`06-roadmap.md:90`):

1. **Recurring contract work generates and completes without manual creation** — a maintenance cycle produces its service orders/bookings on schedule, they get planned and executed through the Phase-1 field loop, and the contract coverage view reflects it.
2. **Customers receive and confirm digitally** — the combined order report reaches the customer through herbe.portal (or an emailed PDF for non-portal tenants), and an order-level signoff decision comes back.

Everything below is scoped to those two, plus the supporting surfaces the roadmap bands into Phase 2 (quotes, compliance documents, reporting v1 — SLA is deferred to Phase 3, §4 P2-WS3). Phase-3 guard rails in §11.

---

## 2. Load-bearing constraints (do not violate)

Settled decisions that shape every Phase-2 workstream. Treat as invariants.

- **The customer surface is herbe.portal, exclusively.** herbe.service ships **zero** customer-facing pages (owner 2026-07-05; `08:47`, `08:03`). Every customer link points into the portal.
- **The ERP is the connecting piece for all actual data.** The portal reads invoices/quotes/bookings from the **ERP**, never from herbe.service; direct service↔portal coupling is limited to the customer **signoff / quote / document trigger APIs**, which carry only a *reference* (`08:56`; `20:33`, decision #16).
- **The `/api/ext/v1` contract is NOT frozen — shipped endpoints included.** Round-5 withdrew the "frozen" claim: only the approval-trigger endpoints are committed (`20:17`, decision #5; `08:70`). P1 has meanwhile shipped read endpoints early on preview (`app/api/ext/v1/orders`, `/service-items`, history — accepted, owner 2026-07-15); treat them as **provisional**: the contract may be re-cut, breaking, when the portal module's shape settles. Nothing customer-facing may depend on their stability until then.
- **`COVc` is inbound / read-only.** The app reads the ERP contract header + covered rows for the `contract` charge-type default, coverage, and PM cadence; the app overlay (coverage view, per-service-level extras) **never syncs back**. Write-back of `ContractClass` / row `SVCCode` is a deferred one-way door (`02:131`; `20:64`, §3 open-item #6).
- **PM cadence is ERP-sourced, not invented.** The recurring definition is `SVCVc` (`DaysBetween`/`NrOfTimes`/`DaysFromStart`/`Weekends` + `ActType`/`MainPersons`/`CCPersons`), read per covered `COVc` row via `SVCCode` (`04:99`; `02:131`).
- **HTTP 200 is not proof of a write** — carried over from P1 and P0's live probe. `QTVc` (and any Phase-2 create-push) confirms a real assigned id or reads back before marking the step done (`04:117`).
- **Compliance-document delivery is version-gated; the baseline is offline.** The WebExcellentAPI service/contracts document path (attach to `orderShadow`, create/read the activity, fetch PDFs) is per-connection version-gated and may be hidden; the **emailed report PDF + on-site canvas signature** is the guaranteed baseline for every tenant (`20:22`, decision #10; `12:62`).
- **Signoff is two independent axes.** Scope = `require_worksheet_confirmation` (on-device, per-worksheet, portal-less baseline) and/or `require_order_signoff` (order-level, customer-facing); method = `confirm | sign | digital_sign`, a portal setting — only the portal path reaches qualified `digital_sign` (Smart-ID/Mobile-ID) (`08:64`; `12:54`).
- **The order report merges crew siblings by `crewGroupId`; acceptance is order-level.** One worksheet per technician; the combined report renders all approved worksheets of an order as one document, crew merged. There is **no shared lead-worksheet signature reference** (that model was dropped in round 5 — `02:105`): each technician captures their own on-device worksheet confirmation (the day's-work approval, and the **only** signoff when no portal is used), and whole-job acceptance is the **order-level `OrderSignoff`** — in herbe.portal when present, which fetches the combined report via `GET /orders/{id}/report` (owner 2026-07-15; `02:86`; `12:25`; `08:64`).
- **Customer-facing identifiers are fixed contracts.** The order number shown to customers is the ERP number once synced (app number before, never retroactively changed — `16:36`); the customer-visible status vocabulary is a fixed public mapping (`received/scheduled/in progress/work done/completed/cancelled`), never the internal 9-state machine (`16:88`; `08:71`).

---

## 3. What Phase 2 assumes from Phase 1 (hard dependencies)

If a P1 seam isn't delivered at P1 exit, the dependent Phase-2 workstream slips. Confirm at the P1/P2 handoff. (These are exactly the seams doc 21 built "so Phase 2 stands on them without rework" — `21:247`.) **Status column = what's actually on `preview` as of 2026-07-15** (P1 is landing in waves; owner: remaining items are still in-flight P1 scope, doc 21): ✅ built · 🔶 partial · ⏳ not started.

| P1 output | Consumed by | Status (2026-07-15) | Ref |
|---|---|---|---|
| **`/api/ext/v1` shell** — hashed per-connection scoped bearer tokens, admin minting UI, rate limiting (429 + `Retry-After`) | P2-WS5, all customer endpoints | ✅ built (`lib/api/ext/*`, `lib/security/tokens.ts`, migrations 0014/0015) — read endpoints even shipped early, provisional per §2 | `08:67`; `21:151` |
| **Document engine** — DOCX merge (placeholders/loops/conditionals/images), computed-field sandbox, number series, seeded default order report, render pipeline + converter ADR | P2-WS8 | ⏳ not started (P1 WS12 in-flight) | `12:64`; `21:137` |
| **`orderShadow` / `worksheetShadow` activity purposes** + status→`ActState` map (service-owned, per-connection) + seed tool | P2-WS8 (POR-2 fallback carrier), P2-WS6 | 🔶 partial — `ErpRefPurpose` taxonomy + `erp_refs` table exist (`lib/domain/types.ts`, migration 0012); the shadow **writers**, `ActState` map and seed tool don't yet (P1 WS5 in-flight) | `20:29`, #12; `21:88` |
| **Contract entity stub** (nullable `ServiceOrder.relatedContract`, `ServiceItem.serviceContractLink`) | P2-WS1 | ⏳ not started — columns absent from schema; if P1 exits without it, P2-WS1 adds them itself (trivial) | `02:131`; `21` §11 |
| **Service-item tree + coverage records + HistoryEvent projector** (down-projection + ancestor rollup machinery) | P2-WS1, P2-WS8, P2-WS10 | ✅ built (`lib/domain/{coverage,history-projector}.ts`, stores, migrations 0009/0013) | `02:133-136`; `11:53-55`; `21:142` |
| **Frozen QR `labelId` resolver scheme** (login-routed) | P2-WS6 (portal customer route joins it) | 🔶 partial — `serviceItems.labelId` column exists (migration 0009); the login-routed **resolver** doesn't (P1 WS11 in-flight). Nothing frozen until the resolver URL shape exists — the §8 gate still holds | `16:37`; `08:73`; `21:130` |
| **Bookings entity incl. `enRoute` / `etaMinutes`** — the bookings **table does not exist yet** (only the ext-API DTO fields, always omitted); P1 WS5/WS10 in-flight scope | P2-WS2 (generator writes bookings), P2-WS7, P2-WS9 | ⏳ table not started; DTO fields present | `02:117` |
| **`OrderSignoff` + `CustomerFeedback` entities** — specced in the data model; no code yet | P2-WS5 | ⏳ not started (spec-only — P2-WS5 builds the write paths) | `02:21-22` |
| **Email TemplateKey engine** (copied from portal), service dispatch/config tables; **web push infra** (P2-WS9 assumes it) | P2-WS9 | ⏳ not started (P1 WS14/WS1 in-flight) | `08:106`; `21:151` |
| **Quote producer plumbing** — push-queue FIFO with the `(Phase 2) quote` step reserved; `getrecordlinks` back-link client | P2-WS4 | 🔶 partial — `outbox_ops` table + a single persistence-verified `SVOVc` create exist; the saga/DLQ and `getrecordlinks` client don't (P1 WS4 in-flight) | `04:128`, `:207`; `21:81` |
| **ActVc writers + echo suppression + void-in-place** — the outbound activity path the recurring generator drives | P2-WS2, P2-WS5 | ⏳ not started (P1 WS5 in-flight) — the single riskiest dependency for exit criterion #1 | `04:188-236`; `21:88` |

---

## 4. Workstreams

Eleven Phase-2 packages. Each: **goal**, **key deliverables**, **reuse vs. build**, **depends on**, **TDD focus**. IDs (P2-WSn) are stable references for §5. (P2-WS3 — SLA — is deferred to Phase 3; its design is retained below under its ID so the numbering stays stable.)

### P2-WS1 — Contracts & service levels
**Goal:** the contract spine — ERP contracts read in, overlaid with app-owned coverage, projected onto the tree.
- **Deliverables:** promote the P1 `Contract` stub to a full entity; **`COVc` inbound loader/mapper** (customer, `startDate`/`endDate`, billing cycle, `ContractClass`, `OKFlag`, covered rows — read-only); **`SVCVc` service-level register** load (`Code`, `Comment`, cadence fields, `ActType`/`MainPersons`/`CCPersons`) linked per covered row via `SVCCode`; **app overlay** (never pushed): the coverage view over the service-item tree (subtree refs), per-service-level extras `SVCVc` can't hold (response-time terms, per-level checklists via the `ChecklistTemplate` contract hook), richer coverage rules; **contract coverage view / rollups** ("42/46 extinguishers inspected this year") on tree nodes, reusing the P1 rollup machinery; wire the `contract` charge-type suggestion (activates now that `COVc` is read inbound) (`02:131`, `:179`; `04:99`; `06:80`).
- **Reuse:** P1 tree, coverage records, HistoryEvent rollup, `@herbe/erp-core` register cache/loaders. **Build:** `COVc`/`SVCVc` mappers, the contract overlay model, the coverage-view rollup projection.
- **Depends on:** P1 tree + projector; P1 inbound adapter.
- **TDD:** `COVc`/`SVCVc` mapper golden fixtures; coverage-% rollup correctness (covered vs lot/unit counts); `contract` charge-type suggestion from a linked contract; overlay-never-pushed guard.

### P2-WS2 — Recurring service generation
**Goal:** a maintenance cadence produces its work on schedule, with no manual creation.
- **Design: `23-recurring-service-overlay.md` (authoritative — this section summarizes it).** The architecture is **projection-first, two layers of state**: the forward schedule is *computed* from rules + overrides + blackouts (12–24 months visible, nothing committed); only the near horizon is materialized. This is what removes the real pain — "create activities 6 months ahead to see the plan, then delete-and-recreate on every change" (owner 2026-07-15).
- **Owner decision (2026-07-14): generation is app-side logic; the ERP sees the result identically.** herbe.service runs the scheduler/generator, and the resulting ServiceOrder + Booking **create / edit / remove their `ActVc` activities through the P1 outbound push path** — indistinguishable from ERP-native. No dependency on the ERP's Service Agreement maintenance (customers use the app instead, not both); `SVCVc.ActType`/`MainPersons`/`CCPersons` are *inputs* to what the app writes.
- **Deliverables:** the **projection layer** — `ServiceScheduleRule`s (seeded from `COVc`/`SVCVc`, one per matrix row; editable beyond it) + **`OccurrenceOverride`** (skip / reschedule / reassign / cancel one instance) + **blackout dates** (per-customer windows; national holidays via calendar's per-person import, **CAL-10**); **two lead settings** — `materializeAheadDays` (commit bookings) and `orderLeadDays` (cut the order), tenant default + per-rule override; the **materializer** — projected dates → bookings (1:1 per service item) within the materialize horizon, then ServiceOrders at order lead time with **`groupBy` consolidation at order creation** (bookings stay per-item); `ActVc` written via the P1 writers with **echo suppression** and **void-in-place** on cancel; `after_completion` anchor bump on completion; idempotent re-runs; **coverage projection with rotation** ("n of m due this cycle", rotating units — `11`); reassignment via the **embedded calendar team view (CAL-9)** (`02:131`; `04:99`; `06:80`; `23` §4-7).
- **Reuse:** P1 cron dispatcher + table locks; P1 order/booking creation + `ActVc` writers + **void-in-place + echo suppression** (P1 WS5 — ⏳ per §3); calendar `repeatRules.ts` **copy-first**. Note the copy scope: `paused` and `after_n` live in the calendar's **schema + cron layer** (migrations 58/59/68), not in the pure engine file — copy the pattern, not just the file. **Build:** the rule/override/blackout models, the two-layer materializer, the SVCVc seed mapping. The SVCVc primitive is already built (`lib/domain/recurrence.ts`, 19 tests green — correct first-occurrence formula, 3-way weekends, negative Initial Days).
- **Depends on:** P2-WS1; P1 bookings table + order writers + WS5 (`ActVc` write, void, echo) — all ⏳/🔶 in §3; CAL-9/CAL-10 (fallbacks in `13`).
- **TDD:** cadence projection (first occurrence = Start + Initial Days + Days Between; 3-way weekend modes; negative Initial Days); override/blackout folding (an override survives re-projection; a blackout shifts/skips per rule); two-horizon materialization boundaries; idempotent re-run (no duplicate cycle); **generated `ActVc` doesn't echo back as a new order**; **rule/occurrence change → future bookings edited/voided, past ones untouched**; `groupBy` consolidation (one order, per-item bookings); generation → full P1 field loop → completion feeds the coverage view.

### P2-WS3 — SLA indicators & timers — DEFERRED TO PHASE 3
**Deferred (owner 2026-07-14):** a nice-to-have that opens a full time-accounting surface — per-contract coverage calendars, timezones, national/regional holidays, pause reasons — not worth blocking the Phase-2 customer experience on. Moved to Phase 3 (§11; roadmap `06`). The docs never defined SLA mechanics anyway (the roadmap line — now `06:96` — was a one-liner; "response-time terms" is free text — `02:131`, `04:99`). **Design retained below** so Phase 3 starts from it, not a blank page.
- **Proposed model — two clocks per order, off the status-machine timestamps:** a **response clock** (starts at order creation/receipt for reactive work; stops at first response — work-started by default) and a **resolution clock** (same start; stops at Work done/Confirmed), each targeted from the service-level response/resolution term. Reactive/corrective orders get SLAs; contract-generated PM orders use a due-window. Targets count against a per-contract **business-hours coverage calendar** — the timezone + holiday can-of-worms that justified the deferral. Clock pauses on waiting-for-customer / parts-on-order / customer-delay. States on-track → at-risk (~80%, amber) → breached (red) on the order list + dispatch board + an SLA panel, with a dispatcher notification at at-risk/breach (no multi-tier escalation).
- **When Phase 3 picks it up:** reuses the P2-WS1 service-level overlay (terms), P1 status timestamps, P1 pause-with-reason, P1 web-push; builds the clock/calendar/breach engine as a pure module + the coverage-calendar (timezone + holiday) config. Open choices carried over: response-clock stop event; PM-order SLA vs. due-window; coverage-calendar vs. wall-clock v1; the pause-reason list.

### P2-WS4 — Quote flow (out-of-contract work)
**Goal:** a quote drafted from an order, pushed to the ERP, confirmed by the customer, read back.
- **Deliverables:** **quote draft** from a service order (rows from a work template or an estimated worksheet; prices ERP-truth via `windowactions` preview or post-and-read-back); **`QTVc` push** through the push queue with the order back-link (same convention as invoices; `erpRef` stored; persistence-verified); **auto-send via POR-6** (token-authenticated portal send) — **fallback: the quote lands in the portal quotations module and a human sends it**; **acceptance read-back** — the `QTVc` poll picks up accept/reject → the order gains a `quote accepted/rejected` event (accepted → dispatcher notified, order proceeds; rejected → follow-up flag; **never auto-cancel**) (`04:100`, `:128`, `:202-210`; `13:118-120`).
- **Reuse:** P1 push-queue saga + persistence-verification + `getrecordlinks`; the portal quotations module (customer-facing, **theirs**). **Build:** the quote-draft builder, `QTVc` mapper, acceptance-poll handler.
- **Depends on:** P1 push queue; P2-WS11 (work templates, optional row source); **POR-6** for auto-send (fallback ready).
- **TDD:** `QTVc` push persistence-verification (200-but-empty mode); acceptance read-back sets the right event; rejected order stays open; POR-6-absent fallback path.

### P2-WS5 — Customer signoff / report / feedback API (`/api/ext/v1` go-live)
**Goal:** the committed customer endpoints, writing Phase-2 entities, live for the portal.
- **Deliverables:** turn on the P1-designed endpoints (`08:68`): **`GET /orders/{id}/report`** (combined order report, requested once all worksheets approved), **`POST /orders/{id}/confirm`** (order-level signoff, resendable; body `confirmed|rejected` + optional `reason` + optional `feedback{rating,comment}`; writes `OrderSignoff`; attaches the signed file to `orderShadow`/`SVOVc` where the version allows; `rejected` keeps the order open; independent of the worksheet ERP push), **`POST /orders/{id}/feedback`** (standalone satisfaction, separate axis, idempotent, a low rating never blocks closure); **document-signoff trigger (POR-7)** — token-authenticated "send for signoff", reference-only (`activityId`, optional `documentId`), never content (**not blocking**: the tier-0 poll flow already works; this is a latency optimization). Token scoping: per (deployment, company connection), `customerCodes` narrow-not-widen (`08:64`, `:68`, `:86`; `13:112-114`).
- **Reuse:** the P1 `/api/ext` shell (tokens, rate limit, minting). **Build:** the three endpoint handlers + `OrderSignoff`/`CustomerFeedback` write paths + the `orderShadow` attach.
- **Depends on:** P1 `/api/ext` shell; P2-WS8 (report/doc rendering); P1 `orderShadow`.
- **TDD:** `/api/ext` contract tests consumed as portal fixtures; resendable confirm (reject re-opens the order); feedback idempotency; token scope narrow-not-widen; rejected-order-doesn't-strand-stock.

### P2-WS6 — Portal customer surface enablement
**Goal:** the portal's customer window works against service data — service supplies the API and the joins, the portal builds the pages.
- **Deliverables:** service-side support for the portal-owned surface (equipment+history, request intake, order tracking incl. "technician on the way", report read-out, feedback): the **QR-label resolver's portal customer route joins** the frozen `labelId` scheme (service resolves `labelId=` for the portal side — tentative until label integration is confirmed, §4 item 4); the **customer-visible status mapping** exposed via the API per the fixed public vocabulary; supply the data joins the committed endpoints need. **The portal module shape is still moving** (`08:49`) — this workstream tracks it and adapts; the wider read API stays *designed, not shipped* until it settles (`08:56`, `:70`; `20:17`).
- **Reuse:** portal identity/`identity_links` (portal-owned); the frozen `labelId` scheme. **Build:** the resolver's portal branch, the status-mapping exposure.
- **Depends on:** P2-WS5; the frozen `labelId`; the portal module shape (external).
- **TDD:** resolver routing (tech / portal-customer / unknown / unscoped, no data leak); status-vocabulary mapping; label-integration-off graceful degrade.

### P2-WS7 — Smart Booking intake (CAL-4)
**Goal:** a customer self-schedules a service request against real technician availability.
- **Deliverables:** a herbe.calendar booking template targeting the **service intake activity type** with custom fields (site, serial, fault) → the activity arrives via tier-0 sync → the **intake-type rule converts it to ServiceOrder + Booking**; a **QR-prefilled** booking deep link (sticker → booking page with the serial set); **reschedule/cancel links** in the confirmation email. Ask **CAL-4**: an asset-reference custom-field type (validated at booking) — **fallback: a plain-text serial field + QR-prefilled links**, conversion still works without booking-time validation (`08:35`; `13:59-63`).
- **Reuse:** the P1 intake-type auto-convert (from `ActVc` sync); calendar Smart Booking (**theirs**). **Build:** the intake→order+booking mapping, the QR-prefill link, reschedule/cancel handling.
- **Depends on:** P1 `ActVc` two-way + intake-type rule; **CAL-4** (fallback ready).
- **TDD:** intake activity → ServiceOrder+Booking; serial carried from the QR prefill; reschedule/cancel round-trip.

### P2-WS8 — Compliance & contract-cycle documents + signoff
**Goal:** certificates and contract documents generated off the P1 engine, signed through the portal, with an offline baseline.
- **Deliverables:** the **compliance certificate** doc type (rooted on a Worksheet or a ServiceItem node; order-report content + subtree rollups: covered-units table, last/next service, coverage %; the fire-detector annex loop over covered units incl. exceptions); **contract summary / contract-cycle documents** (rooted on Contract; covered-nodes tree, PM schedule, response terms; auto-generated on contract-cycle events, e.g. a yearly certificate after the annual inspection completes); **Media linkage** to the root entity + the certified nodes (findable from the item card + history); **immutability/versioning** (template version + context snapshot; re-render = a new version; the signed original is never mutated); the **signing descriptor** as primary for qualified signatures (Smart-ID/Mobile-ID via the portal); the **POR-2 no-module fallback** — attach the generated doc to the `orderShadow` activity via record links, the portal presents it like a delivery confirmation, the outcome returns as `ActState` + comment; the **canvas / emailed-PDF baseline** for non-portal / version-gated-off tenants (`12:27-28`, `:46`, `:50`, `:52`, `:54`, `:62`; `06:85`). Note: the portal-side `SVOVc` signing module **already exists on portal preview** (`lib/signing/modules/service-orders.ts`, registered in the registry) — P2-WS8 integrates against real code, not just the descriptor interface.
- **Reuse:** the **entire P1 document engine** (DOCX merge, computed sandbox, number series, render pipeline, template library, settings export/import — a proven fire-safety template set clones to the next tenant); P1 `orderShadow`. **Build:** the certificate / contract-summary doc types, the subtree-annex context projection, the cycle-event trigger, the signing-descriptor integration.
- **Depends on:** P1 document engine + `orderShadow`; P2-WS1 (contract/coverage context); **POR-2** confirmation (fallback ready).
- **TDD:** merge-context golden fixtures (covered-units annex + exceptions); coverage-% in the certificate == the dashboard (shared projection); number-series immutability; POR-2 fallback round-trip via `orderShadow`; version-gate-off → emailed-PDF path.

### P2-WS9 — Customer notifications
**Goal:** the right party sends each customer touch exactly once, with links landing in the portal.
- **Deliverables:** the §4b **notification ownership table** implemented against its target state (`08:79-85`): service sends **booking confirmed/changed** (+ technician rejection notices) and **"technician on the way" + ETA** — the P1 `enRoute`/`etaMinutes` fields get their **UI action** (an explicit "On my way" tap + a static route estimate, no live tracking); the portal sends request-received, work-done+report, the satisfaction-survey ask, and quote-to-confirm (triggered by service). Non-portal tenants: service's own emails with the report PDF attached carry the touch.
- **Reuse:** the copied TemplateKey engine + service dispatch tables. **Build:** the "On my way" action + ETA compute, the service-owned notification rows, the ownership guard (no double-send).
- **Depends on:** P1 email engine; P2-WS5/WS6 (portal links); the P1 booking fields.
- **TDD:** each row fires from the right sender once; "On my way" → ETA in the portal view; non-portal emailed-PDF path.

### P2-WS10 — Reporting v1
**Goal:** the operational metrics that **run on data herbe.service already owns** — skip anything not yet computable (owner 2026-07-14: "skip the reports that are impossible to run at the moment; time will come").
- **Ship (runnable now):**
  - **First-time-fix rate** — % of reactive/corrective orders resolved in a single visit (one completed worksheet) with **no follow-up** order on the same service item within a configurable window and no reopen. From order/worksheet history.
  - **MTTR** — mean elapsed time from the order start trigger to **Work done/Confirmed**; mean **response time** exposed as a companion (wall-clock for now — the business-hours calendar is the deferred SLA/WS3 surface). From P1 status timestamps.
  - **Top problem devices** — ItemModel (make/model) and/or nodes ranked by corrective (non-PM) order/fault-event **count** over a period. From the ItemModel registry + fault/cause/remedy + HistoryEvents.
  - **Coverage %, subtree rollups, lot explosion, checklist sampling** — as **already defined in doc 11** (`11:53-55`, `:26`, `:37`); reuse verbatim, no new definition needed.
- **Deferred until the data/config exists (skip now):**
  - **Revenue per technician** — impossible: Standard has no `IVVc`-row→technician link (invoices resolve to source worksheets only at document level via `getrecordlinks`, and aggregate). Already recorded in `04:142` (doc-sync done 2026-07-15). An app-side *billable-value-booked* proxy (sum of `invoiceable` rows at ERP prices, per logging tech) is the eventual path once per-row pricing/attribution is solid — not built now.
  - **Utilization** — needs a technician **working-hours config** that doesn't exist yet (productive work-segment time ÷ available hours). Build the config first, then the metric.
  - **Failure rate** (corrective orders ÷ installed base) — needs a known install base per model; the count-based "top problem devices" ships now, the rate variant follows.
- **Reuse:** P1 coverage/rollup machinery, HistoryEvent data, P1 status timestamps + work-segment/fault data. **Build:** the four runnable metric queries.
- **Depends on:** P2-WS1 (coverage), P1 history/work-segment data.
- **TDD:** coverage-% and rollups against golden trees; lot-explosion history carry-over; FTF window logic; MTTR math; each shipped metric as a fixture.

### P2-WS11 — Work templates (incident-type-lite)
**Goal:** a fault type bundles its default checklist, typical parts, and estimated duration.
- **Deliverables:** a work-template entity (fault type → default checklist + typical parts + estimated duration), applied at order/worksheet creation and as a quote-draft row source (`06:86`; `01:45`, `:11`).
- **Reuse:** P1 checklist templates, the part catalog. **Build:** the template entity + application flow.
- **Depends on:** P1 checklists + parts; feeds P2-WS4 (quote rows).
- **TDD:** template application populates checklist/parts/duration; edit-after-apply independence.

### P2-WS12 — Native wrapper gaps (only if P1 PWA data shows the need)
**Goal:** close the specific PWA gaps, one codebase, no speculative native build.
- **Deliverables:** **only the gaps Phase-1 PWA data proves we need** — candidates: reliable iOS background sync, **NFC tag reading** (Web NFC is Android-only), OS-keystore at-rest encryption for tenants that demand it. Wrapper choice is decided when a gap becomes real: calendar's native Swift `WKWebView` shell (the iOS reference) or Capacitor if Android needs wrapping too. Biometric login already ships P1 (WebAuthn) (`06:87`; `03:56-58`, `:68-76`).
- **Reuse:** calendar's `ios/` shell + token-pairing pattern, or Capacitor. **Build:** only the proven-gap bridge.
- **Depends on:** P1 PWA field-usage data (gate: don't build without evidence).
- **TDD:** wrapper token pairing; NFC read → node card; background-sync reliability on device.

---

## 5. Sequencing — self-contained value first, portal-gated surface in parallel

Milestones, not calendar dates (§10 re-estimate). The ordering front-loads the **contracts+recurring spine** (self-contained on the P1 tree, the headline exit criterion) while the **customer surface** runs in parallel gated on the portal team's module.

**P2-M0 — Contract spine**
P2-WS1 (`COVc`/`SVCVc` inbound + overlay + coverage view). (Generation owner resolved — app-side, §8.)

**P2-M1 — Projection surface + recurring generation (prove exit criterion #1)**
P2-WS2 in its two layers, in order: first the **projection surface** (rules + overrides + blackouts → the schedule matrix, 12+ months visible, nothing committed — the headline value per `23` §8), then **materialization end-to-end**: projected date → booking → order → `ActVc` → P1 field loop → completion → coverage view updates. The de-risking milestone for the contract half; don't fan out contract features until a generated cycle completes green. Reassignment rides the embedded calendar view (**CAL-9**); holiday blackouts ride **CAL-10** (fallbacks in `13`).

**P2-M2 — Customer surface (prove exit criterion #2), parallel from M0**
P2-WS5 (endpoints go live) · P2-WS9 (notifications incl. "On my way") · P2-WS6 (portal enablement + QR route join). Gated on the portal module shape — every ask has a fallback so service isn't blocked (§9).

**P2-M3 — Documents & signoff**
P2-WS8 (compliance + contract-cycle docs + signing descriptor + POR-2 fallback). Needs the P1 engine + `orderShadow` exercised; produces the artifacts M2 signs.

**P2-M4 — Quotes & intake**
P2-WS4 (`QTVc` push + POR-6 send + acceptance read-back) · P2-WS7 (Smart Booking intake) · P2-WS11 (work templates, feeding quote rows).

**P2-M5 — Reporting & wrappers**
P2-WS10 (reporting v1 — runnable metrics only; deferred ones wait for their data) · P2-WS12 (native gaps, only if P1 data warrants). (SLA — P2-WS3 — deferred to Phase 3.)

**P2-M6 — Pilot**
A contract tenant's recurring work generates and completes without manual creation; customers confirm digitally → the §1 exit criteria.

Critical path: P2-M0 → P2-M1 (contracts→recurring). The customer surface (M2/M3) is a parallel track bounded by the portal team; quotes/reporting (M4/M5) build on already-working machinery.

---

## 6. Reuse ledger (Phase-2 additions)

| Capability | Decision | Source |
|---|---|---|
| Document engine (DOCX merge, computed sandbox, number series, render pipeline, template library) | Reuse P1 as-is | doc 21 WS12 / `12:64` |
| `/api/ext/v1` shell (tokens, rate limit, minting) | Reuse P1 as-is | doc 21 WS14 / `08:67` |
| `orderShadow`/`worksheetShadow` + status→`ActState` map | Reuse P1 as-is | `20:29` / doc 21 WS5 |
| Push-queue saga + persistence-verification + `getrecordlinks` (for `QTVc`) | Reuse P1 as-is | `21` WS4 / `04:207` |
| Portal quotations module (customer-facing accept/reject + share view) | **Do not build** — portal's | `04:204` |
| Portal signing gateways (Dokobit/eParaksts/Smart-ID) | **Do not build** — used portal-side | `08:107` |
| Portal `ARVc` mapper (payment-status enrichment only — **not** per-tech revenue) | Consume portal-side | `04:142` |
| Email TemplateKey engine | Reuse P1 copy | `08:106` |
| Cron dispatcher + table locks (recurring generation) | Reuse P1 copy | `21` §6 |

Rule holds from P1: only `@herbe/erp-core` is shared; everything else is copy-first / consumed via the ERP or the committed APIs (`08:120`).

---

## 7. Cross-cutting (every workstream)

- **i18n** on every new user-visible string (7 locales; ET/EN/LV/LT/FI/NO translated).
- **Design-system compliance** — office surfaces on the portal non-negotiables; new customer-facing rendering (report/certificate PDFs) tenant-themed.
- **Audit** — append-only who/when/what/device on every new state change (signoff, quote decision, contract-cycle generation) via the P1 audit write path.
- **Capability + version gating, never "disabled"** — the compliance-doc path degrades to an emailed PDF; quote auto-send degrades to manual; the label route degrades gracefully.
- **TDD from the first commit; spec rule → named suite**; coverage gates as in P1 (`15`).

---

## 8. Freeze gates & one-way doors

- **Recurring-generation owner — RESOLVED (2026-07-14): app-side.** herbe.service runs the generator; it creates/edits/removes the ERP `ActVc` activities through the P1 outbound path so the ERP sees them identically. No ERP-side Service Management dependency (§4 P2-WS2).
- **`COVc` stays read-only** — enabling `ContractClass` / row-`SVCCode` write-back reverses ownership; deferred, don't build it into the contract model (`20:64`; `02:131`).
- **Persistence-verification on `QTVc` push** — mandatory before a step is marked done (`04:117`).
- **The `/api/ext/v1` read contract is deliberately unfrozen** — commit only the approval-trigger endpoints; re-cut the wider read API once the portal module shape lands (`20:17`; `08:70`).
- **QR `labelId` scheme is already frozen (P1)** — the portal customer route only *joins* it; never re-mint the scheme (`16:37`).

---

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Portal module contract not final (module **is built on portal preview** — pages, confirm/satisfaction routes, `SVOVc` signing, `service_connection_config` — but unreleased and re-cuttable) | Customer surface (M2/M3) reworked if the shape shifts before portal prod | Every sibling ask (CAL-4/9/10, POR-2/6/7) has a fallback; service ships the committed endpoints + emailed-PDF/canvas baseline regardless (`08:49`; `13`) |
| P1 in-flight seams slip (ActVc writers/echo/void, bookings table, document engine — §3 ⏳ rows) | P2-WS2/WS8 start blocked | §3 status column tracked at the P1/P2 handoff; P2-WS2's projection layer needs none of them and can start first |
| Version gate hides the compliance-doc path | Certificates can't deliver digitally | Emailed PDF + on-site canvas signature is the guaranteed baseline (`12:62`; `20:22`) |
| App-generated `ActVc` echoes back as a new order | Duplicate orders from recurring generation | P1 WS5 echo suppression (app-UUID tag); regression test in P2-WS2 |
| Building reports the data can't support (revenue/tech, utilization) | Wasted effort, misleading numbers | Reporting v1 ships only runnable metrics; the rest wait for their data/config (§4 P2-WS10) |
| POR-6 (quote send) not delivered | No quote auto-send | Human sends from the portal quotations module; acceptance read-back still works (`13:120`) |

---

## 10. Open items that gate estimation / start

1. **Phase 2 calendar estimate** — roadmap says 8–12 weeks (`06:76`); re-estimate at P1 exit against the actual P1 seams delivered.
2. ~~Recurring-generation owner~~ — **RESOLVED 2026-07-14: app-side** (§4 P2-WS2, §8).
3. ~~SLA scope~~ — **DEFERRED to Phase 3 (2026-07-14)**: nice-to-have; the coverage-calendar/timezone/holiday surface isn't worth blocking Phase 2. Design + open choices retained in §4 P2-WS3.
4. ~~Reporting metric definitions~~ — **RESOLVED 2026-07-14** (§4 P2-WS10): ship first-time-fix / MTTR / top-devices (count) / doc-11 coverage metrics; **defer** revenue-per-tech (no `IVVc`→tech link — recorded in `04:142`, doc-sync done), utilization (no working-hours config), failure-rate (no install base) until their data exists. Remaining follow-up: build the technician working-hours config before utilization returns.
5. **Portal module shape** — drives the `/api/ext` read-API re-cut and the POR-2 generalization; only the approval-trigger endpoints are committed until it lands (`20:17`; `13:91`).
6. **Sibling-team asks** — CAL-4 (intake asset ref), CAL-6/7/8 (calendar service-activity UX), **CAL-9 (embeddable team calendar view for reassignment)**, **CAL-10 (per-person national-holiday data)**, POR-1/2/6/7 (invoice cross-link, signoff, quote/doc send). Fallbacks ready for each (`13`).
7. **Ops & lifecycle package** — retention enforcement, `/api/ext` rate-limit hardening, tenant export: confirm which ride along Phase 2 vs. defer to Phase 3 (`16:94-104`; `20:66`).

---

## 11. Explicitly out of scope (Phase 3 guard rails)

Do **not** build in Phase 2 (`06:92-107`; `13:65-67`):

- **SLA indicators & timers** (response/resolution clocks, coverage calendar, breach flags) — **moved from Phase 2 (2026-07-14)** because it opens a coverage-calendar/timezone/holiday surface; the design is retained in §4 P2-WS3 so Phase 3 doesn't restart it (roadmap line now at `06:96`).
- **Analytics query layer + MCP server** — **copy-first from herbe.portal (owner 2026-07-14: the service DB will need the same, near-verbatim).** Portal design to replicate (paths in `herbe-portal`): the **`analytics_tokens`** table (hashed token, `scope='mcp'`, multi-company `erp_company_ids[]`, revocable — `drizzle/schema.ts:1866`, `lib/mcp/validate-bearer.ts`); **OAuth/PKCE minting** (`mcp_oauth_codes` + `app/api/mcp/oauth/{authorize,token}` + a cleanup cron; `lib/mcp/oauth-crypto.ts`; connect UI `app/(site)/mcp-connect/`); the **read-only MCP server** (`app/api/mcp/[[...path]]/route.ts`, `lib/mcp/server.ts`, tools in `lib/mcp/tools/`, a read-only `lib/mcp/sql-validator.ts`, per-tenant `customizations/mcp-tools.ts`, **module-gated per company** via `isModuleEnabledForCompany`); a **pgvector semantic-search store** (`cached_embeddings` `vector(1536)` + HNSW cosine, `text-embedding-3-small` — `drizzle/migrations/0056_semantic_search.sql`) powering `semantic_search`/`find_similar`. **Service DB primitives to add when it lands:** the `vector` extension + `cached_embeddings`, `analytics_tokens`, `mcp_oauth_codes`; re-point the tool set at service registers/entities. **Non-breaking to add later** — no Phase-1/2 schema pre-work required, but keep entity tables query-clean so the MCP tools map cleanly.
- Scheduling assist / suggest-technician-by-skills-distance-availability, and the **CAL-5 merged-busy-times availability query** (both **Phase 3**, not Phase 2 — `13:17,63`; `08:41`); route optimization for multi-stop days.
- Usage/meter-based preventive maintenance with predictive due-date drift.
- Part-compatibility mining from approved worksheet usage.
- AI assist (worksheet summary drafting, similar-past-faults retrieval, voice-to-form).
- Live technician tracking; no-login self-scheduling.
- Skills & certifications registry; subcontractor / multi-company; additional non-HansaWorld adapters; IoT hooks.
- Deeper analytics beyond reporting v1. (`CustomerFeedback` itself feeds **Phase-2** reporting per `02:139` — satisfaction per technician/customer/period rides P2-WS10 once P2-WS5 collects it; only the deeper analytics layer is Phase 3.)

Phase 2 stands on the Phase-1 seams (§3) without reworking them; its own contract overlay, recurring generator, and compliance-document types are built so Phase 3's intelligence layer reads from them.
