# herbe.service — Phase 2 Implementation Plan

Status: v1.0 (2026-07-14). Scope: **roadmap Phase 2 — "Contracts, recurring service, customer experience"** (`06-roadmap.md:76-91`), the band that was old Phase 3 before the round-5 collapse (`20-spec-review-round-5.md:35`, decision #18). Phase 1 ("The product", plan in `21-phase-1-implementation-plan.md`) is **in progress**; this plan takes its outputs as **given at P1 exit** — it lists the P1 seams it stands on (§3) but does not re-plan them, exactly as the P1 plan treated Phase 0.

Same shape as doc 21: a work-package / sequencing plan — what to build, in what order, reuse vs. build, how each package is tested, what still gates a calendar estimate. Not a re-spec; the truth lives in docs 02–13. Line cites point there.

---

## 1. What Phase 2 delivers (exit criteria, from the roadmap)

Two acceptance targets (`06-roadmap.md:91`):

1. **Recurring contract work generates and completes without manual creation** — a maintenance cycle produces its service orders/bookings on schedule, they get planned and executed through the Phase-1 field loop, and the contract coverage view reflects it.
2. **Customers receive and confirm digitally** — the combined order report reaches the customer through herbe.portal (or an emailed PDF for non-portal tenants), and an order-level signoff decision comes back.

Everything below is scoped to those two, plus the supporting surfaces the roadmap bands into Phase 2 (quotes, SLA, compliance documents, reporting v1). Phase-3 guard rails in §11.

---

## 2. Load-bearing constraints (do not violate)

Settled decisions that shape every Phase-2 workstream. Treat as invariants.

- **The customer surface is herbe.portal, exclusively.** herbe.service ships **zero** customer-facing pages (owner 2026-07-05; `08:47`, `08:03`). Every customer link points into the portal.
- **The ERP is the connecting piece for all actual data.** The portal reads invoices/quotes/bookings from the **ERP**, never from herbe.service; direct service↔portal coupling is limited to the customer **signoff / quote / document trigger APIs**, which carry only a *reference* (`08:56`; `20:33`, decision #16).
- **The `/api/ext/v1` contract is NOT frozen.** Round-5 withdrew the "frozen" claim: only the approval-trigger endpoints are committed; the wider read API is re-cut once the portal module's real shape lands (`20:17`, decision #5; `08:70`). Build the committed endpoints; design — but don't ship — the rest.
- **`COVc` is inbound / read-only.** The app reads the ERP contract header + covered rows for the `contract` charge-type default, coverage, and PM cadence; the app overlay (coverage view, per-service-level extras) **never syncs back**. Write-back of `ContractClass` / row `SVCCode` is a deferred one-way door (`02:131`; `20:64`, decision #6).
- **PM cadence is ERP-sourced, not invented.** The recurring definition is `SVCVc` (`DaysBetween`/`NrOfTimes`/`DaysFromStart`/`Weekends` + `ActType`/`MainPersons`/`CCPersons`), read per covered `COVc` row via `SVCCode` (`04:99`; `02:131`).
- **HTTP 200 is not proof of a write** — carried over from P1 and P0's live probe. `QTVc` (and any Phase-2 create-push) confirms a real assigned id or reads back before marking the step done (`04:117`).
- **Compliance-document delivery is version-gated; the baseline is offline.** The WebExcellentAPI service/contracts document path (attach to `orderShadow`, create/read the activity, fetch PDFs) is per-connection version-gated and may be hidden; the **emailed report PDF + on-site canvas signature** is the guaranteed baseline for every tenant (`20:22`, decision #10; `12:62`).
- **Signoff is two independent axes.** Scope = `require_worksheet_confirmation` (on-device, per-worksheet, portal-less baseline) and/or `require_order_signoff` (order-level, customer-facing); method = `confirm | sign | digital_sign`, a portal setting — only the portal path reaches qualified `digital_sign` (Smart-ID/Mobile-ID) (`08:64`; `12:54`).
- **The order report merges crew siblings by `crewGroupId`.** One worksheet per technician; the combined report renders all approved worksheets of an order as one document, crew merged, single customer signature via the lead-worksheet reference (`16:187-189`; `12:25`).
- **Customer-facing identifiers are fixed contracts.** The order number shown to customers is the ERP number once synced (app number before, never retroactively changed — `16:36`); the customer-visible status vocabulary is a fixed public mapping (`received/scheduled/in progress/work done/completed/cancelled`), never the internal 9-state machine (`16:88`; `08:71`).

---

## 3. What Phase 2 assumes from Phase 1 (hard dependencies)

If a P1 seam isn't delivered at P1 exit, the dependent Phase-2 workstream slips. Confirm at the P1/P2 handoff. (These are exactly the seams doc 21 built "so Phase 2 stands on them without rework" — `21:247`.)

| P1 output | Consumed by | Ref |
|---|---|---|
| **`/api/ext/v1` shell** — hashed per-connection scoped bearer tokens, admin minting UI, rate limiting (429 + `Retry-After`); endpoint *shapes* designed | P2-WS5, all customer endpoints | `08:67`; `21:151` |
| **Document engine** — DOCX merge (placeholders/loops/conditionals/images), computed-field sandbox, number series, seeded default order report, render pipeline + converter ADR | P2-WS8 | `12:64`; `21:137` |
| **`orderShadow` / `worksheetShadow` activity purposes** + status→`ActState` map (service-owned, per-connection) + seed tool | P2-WS8 (POR-2 fallback carrier), P2-WS6 | `20:29`, #12; `21:88` |
| **Contract entity stub** (nullable `ServiceOrder.relatedContract`, `ServiceItem.serviceContractLink`) | P2-WS1 | `02:131`; `21` §11 |
| **Service-item tree + coverage records + HistoryEvent projector** (down-projection + ancestor rollup machinery) | P2-WS1, P2-WS8, P2-WS10 | `02:133-136`; `11:53-55`; `21:142` |
| **Frozen QR `labelId` resolver scheme** (login-routed) | P2-WS6 (portal customer route joins it) | `16:37`; `08:73`; `21:130` |
| **Booking `enRoute` / `etaMinutes` fields** (schema + API present; UI action ships P2) | P2-WS9 | `02:117`; `16:84` |
| **`OrderSignoff` + `CustomerFeedback` entities** designed | P2-WS5 | `02:21-22` |
| **Email TemplateKey engine** (copied from portal), service dispatch/config tables | P2-WS9 | `08:106`; `21:151` |
| **Quote producer plumbing** — push-queue FIFO with the `(Phase 2) quote` step reserved; `getrecordlinks` back-link client | P2-WS4 | `04:128`, `:207`; `21:81` |

---

## 4. Workstreams

Twelve packages. Each: **goal**, **key deliverables**, **reuse vs. build**, **depends on**, **TDD focus**. IDs (P2-WSn) are stable references for §5.

### P2-WS1 — Contracts & service levels
**Goal:** the contract spine — ERP contracts read in, overlaid with app-owned coverage, projected onto the tree.
- **Deliverables:** promote the P1 `Contract` stub to a full entity; **`COVc` inbound loader/mapper** (customer, `startDate`/`endDate`, billing cycle, `ContractClass`, `OKFlag`, covered rows — read-only); **`SVCVc` service-level register** load (`Code`, `Comment`, cadence fields, `ActType`/`MainPersons`/`CCPersons`) linked per covered row via `SVCCode`; **app overlay** (never pushed): the coverage view over the service-item tree (subtree refs), per-service-level extras `SVCVc` can't hold (response-time terms, per-level checklists via the `ChecklistTemplate` contract hook), richer coverage rules; **contract coverage view / rollups** ("42/46 extinguishers inspected this year") on tree nodes, reusing the P1 rollup machinery; wire the `contract` charge-type suggestion (activates now that `COVc` is read inbound) (`02:131`, `:179`; `04:99`; `06:80`).
- **Reuse:** P1 tree, coverage records, HistoryEvent rollup, `@herbe/erp-core` register cache/loaders. **Build:** `COVc`/`SVCVc` mappers, the contract overlay model, the coverage-view rollup projection.
- **Depends on:** P1 tree + projector; P1 inbound adapter.
- **TDD:** `COVc`/`SVCVc` mapper golden fixtures; coverage-% rollup correctness (covered vs lot/unit counts); `contract` charge-type suggestion from a linked contract; overlay-never-pushed guard.

### P2-WS2 — Recurring service generation
**Goal:** a maintenance cadence produces its work on schedule, with no manual creation.
- **Deliverables:** the recurring-order **generator** — reads `SVCVc` cadence per covered `COVc` row, projects due dates (horizon control), emits ServiceOrder + Booking (+ shadow activities); idempotent (no duplicate cycles on re-run); horizon/backfill controls; **coverage projection** so "n of m due this cycle" is visible. **This workstream's design is gated on a freeze decision (§8): who owns generation — an app-side scheduler, or ERP-side Service Management generating activities that flow back inbound.** `SVCVc`'s `ActType`/`MainPersons`/`CCPersons` ("what to generate") points at ERP-side activity generation, but it is not decided (`02:131`; `04:99`; `06:80`).
- **Reuse:** P1 cron dispatcher + table locks; P1 order/booking creation + `ActVc` writers. **Build:** the cadence→due-date projector, generation idempotency, horizon control.
- **Depends on:** P2-WS1; P1 order/booking/shadow writers; **§8 generation-owner decision**.
- **TDD:** cadence projection (all four `SVCVc` fields incl. weekend skip); idempotent re-run (no duplicate cycle); horizon boundary; generation → full P1 field loop → completion feeds the coverage view.

### P2-WS3 — SLA indicators & timers
**Goal:** response/resolution expectations visible on orders, overdue surfaced.
- **Deliverables:** **define the SLA model first** — no clock/breach entity exists today; `02:131` captures only "response-time terms" as free overlay data. Then: response + resolution timers seeded from the service-level overlay, overdue flags on orders, dispatcher-visible indicators. Scope decision needed (§10): full timer/breach/escalation vs. a plain response-time display.
- **Reuse:** P2-WS1 overlay (response-time terms); P1 order status timestamps. **Build:** the timer model + indicators (net-new).
- **Depends on:** P2-WS1; §10 SLA scope decision.
- **TDD:** timer start/stop against status transitions; overdue-flag thresholds; timezone correctness (Europe/Riga).

### P2-WS4 — Quote flow (out-of-contract work)
**Goal:** a quote drafted from an order, pushed to the ERP, confirmed by the customer, read back.
- **Deliverables:** **quote draft** from a service order (rows from a work template or an estimated worksheet; prices ERP-truth via `windowactions` preview or post-and-read-back); **`QTVc` push** through the push queue with the order back-link (same convention as invoices; `erpRef` stored; persistence-verified); **auto-send via POR-6** (token-authenticated portal send) — **fallback: the quote lands in the portal quotations module and a human sends it**; **acceptance read-back** — the `QTVc` poll picks up accept/reject → the order gains a `quote accepted/rejected` event (accepted → dispatcher notified, order proceeds; rejected → follow-up flag; **never auto-cancel**) (`04:100`, `:128`, `:202-210`; `13:108-110`).
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
- **Deliverables:** a herbe.calendar booking template targeting the **service intake activity type** with custom fields (site, serial, fault) → the activity arrives via tier-0 sync → the **intake-type rule converts it to ServiceOrder + Booking**; a **QR-prefilled** booking deep link (sticker → booking page with the serial set); **reschedule/cancel links** in the confirmation email. Ask **CAL-4**: an asset-reference custom-field type (validated at booking) — **fallback: a plain-text serial field + QR-prefilled links**, conversion still works without booking-time validation (`08:35`; `13:57-61`).
- **Reuse:** the P1 intake-type auto-convert (from `ActVc` sync); calendar Smart Booking (**theirs**). **Build:** the intake→order+booking mapping, the QR-prefill link, reschedule/cancel handling.
- **Depends on:** P1 `ActVc` two-way + intake-type rule; **CAL-4** (fallback ready).
- **TDD:** intake activity → ServiceOrder+Booking; serial carried from the QR prefill; reschedule/cancel round-trip.

### P2-WS8 — Compliance & contract-cycle documents + signoff
**Goal:** certificates and contract documents generated off the P1 engine, signed through the portal, with an offline baseline.
- **Deliverables:** the **compliance certificate** doc type (rooted on a Worksheet or a ServiceItem node; order-report content + subtree rollups: covered-units table, last/next service, coverage %; the fire-detector annex loop over covered units incl. exceptions); **contract summary / contract-cycle documents** (rooted on Contract; covered-nodes tree, PM schedule, response terms; auto-generated on contract-cycle events, e.g. a yearly certificate after the annual inspection completes); **Media linkage** to the root entity + the certified nodes (findable from the item card + history); **immutability/versioning** (template version + context snapshot; re-render = a new version; the signed original is never mutated); the **signing descriptor** as primary for qualified signatures (Smart-ID/Mobile-ID via the portal); the **POR-2 no-module fallback** — attach the generated doc to the `orderShadow` activity via record links, the portal presents it like a delivery confirmation, the outcome returns as `ActState` + comment; the **canvas / emailed-PDF baseline** for non-portal / version-gated-off tenants (`12:27-28`, `:46`, `:50`, `:52`, `:54`, `:62`; `06:86`).
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
**Goal:** the core operational metrics, ERP-priced where money is involved.
- **Deliverables:** **utilization, first-time-fix rate, MTTR, revenue per technician** (ERP-priced via `IVVc` rows through the portal invoice mappers), **top problem devices**, **subtree rollups + coverage %**, **lot explosion**, **checklist sampling rules** (`06:89`; `11:53-55`, `:26`, `:37`). **Metric definitions must be decided first (§10):** coverage %, subtree rollups, lot explosion, and checklist sampling have written definitions in doc 11; utilization / FTF / MTTR / top-problem-devices do **not** — each needs a definition decision. Revenue-per-technician needs the `IVVc`-row → technician/worksheet attribution join defined (likely via the `RLinkVc` back-link).
- **Reuse:** the P1 coverage/rollup machinery, HistoryEvent data, the portal invoice mappers. **Build:** the metric queries + definitions, the `IVVc`→technician join.
- **Depends on:** P2-WS1 (coverage), P1 history/work-segment data, the portal invoice mappers; §10 metric-definition decisions.
- **TDD:** coverage-% and rollups against golden trees; lot-explosion history carry-over; metric definitions as fixtures once decided.

### P2-WS11 — Work templates (incident-type-lite)
**Goal:** a fault type bundles its default checklist, typical parts, and estimated duration.
- **Deliverables:** a work-template entity (fault type → default checklist + typical parts + estimated duration), applied at order/worksheet creation and as a quote-draft row source (`06:87`; `01:45`, `:11`).
- **Reuse:** P1 checklist templates, the part catalog. **Build:** the template entity + application flow.
- **Depends on:** P1 checklists + parts; feeds P2-WS4 (quote rows).
- **TDD:** template application populates checklist/parts/duration; edit-after-apply independence.

### P2-WS12 — Native wrapper gaps (only if P1 PWA data shows the need)
**Goal:** close the specific PWA gaps, one codebase, no speculative native build.
- **Deliverables:** **only the gaps Phase-1 PWA data proves we need** — candidates: reliable iOS background sync, **NFC tag reading** (Web NFC is Android-only), OS-keystore at-rest encryption for tenants that demand it. Wrapper choice is decided when a gap becomes real: calendar's native Swift `WKWebView` shell (the iOS reference) or Capacitor if Android needs wrapping too. Biometric login already ships P1 (WebAuthn) (`06:88`; `03:56-58`, `:68-76`).
- **Reuse:** calendar's `ios/` shell + token-pairing pattern, or Capacitor. **Build:** only the proven-gap bridge.
- **Depends on:** P1 PWA field-usage data (gate: don't build without evidence).
- **TDD:** wrapper token pairing; NFC read → node card; background-sync reliability on device.

---

## 5. Sequencing — self-contained value first, portal-gated surface in parallel

Milestones, not calendar dates (§10 re-estimate). The ordering front-loads the **contracts+recurring spine** (self-contained on the P1 tree, the headline exit criterion) while the **customer surface** runs in parallel gated on the portal team's module.

**P2-M0 — Contract spine**
P2-WS1 (`COVc`/`SVCVc` inbound + overlay + coverage view). Resolve the **generation-owner freeze gate** (§8) here — it blocks P2-WS2's design.

**P2-M1 — Recurring generation (prove exit criterion #1)**
P2-WS2 end-to-end: cadence → generated order/booking → P1 field loop → completion → coverage view updates. The de-risking milestone for the contract half; don't fan out contract features until a generated cycle completes green.

**P2-M2 — Customer surface (prove exit criterion #2), parallel from M0**
P2-WS5 (endpoints go live) · P2-WS9 (notifications incl. "On my way") · P2-WS6 (portal enablement + QR route join). Gated on the portal module shape — every ask has a fallback so service isn't blocked (§9).

**P2-M3 — Documents & signoff**
P2-WS8 (compliance + contract-cycle docs + signing descriptor + POR-2 fallback). Needs the P1 engine + `orderShadow` exercised; produces the artifacts M2 signs.

**P2-M4 — Quotes & intake**
P2-WS4 (`QTVc` push + POR-6 send + acceptance read-back) · P2-WS7 (Smart Booking intake) · P2-WS11 (work templates, feeding quote rows).

**P2-M5 — SLA, reporting, wrappers**
P2-WS3 (SLA, once its scope is decided) · P2-WS10 (reporting v1, once metric definitions are decided) · P2-WS12 (native gaps, only if P1 data warrants).

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
| Portal invoice mappers (`IVVc` → revenue) | Consume portal-side | `06:89` |
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

- **Recurring-generation owner** — app-side scheduler vs. ERP-side activity generation. Decide before P2-WS2 design; `SVCVc.ActType`/`MainPersons`/`CCPersons` leans ERP-side but is undecided (`02:131`; `04:99`). **Blocks P2-M1.**
- **`COVc` stays read-only** — enabling `ContractClass` / row-`SVCCode` write-back reverses ownership; deferred, don't build it into the contract model (`20:64`; `02:131`).
- **Persistence-verification on `QTVc` push** — mandatory before a step is marked done (`04:117`).
- **The `/api/ext/v1` read contract is deliberately unfrozen** — commit only the approval-trigger endpoints; re-cut the wider read API once the portal module shape lands (`20:17`; `08:70`).
- **QR `labelId` scheme is already frozen (P1)** — the portal customer route only *joins* it; never re-mint the scheme (`16:37`).

---

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Portal module shape unsettled | Customer surface (M2/M3) stalls | Every sibling ask (CAL-4, POR-2/6/7) has a fallback; service ships the committed endpoints + emailed-PDF/canvas baseline regardless (`08:49`; `13`) |
| Version gate hides the compliance-doc path | Certificates can't deliver digitally | Emailed PDF + on-site canvas signature is the guaranteed baseline (`12:62`; `20:22`) |
| Recurring-generation owner undecided | P2-WS2 can't start | Freeze-gate decision in M0 (§8) |
| `revenue/technician` attribution underspecified | Reporting metric wrong or blocked | Define the `IVVc`→technician join (likely `RLinkVc` back-link) before P2-WS10; treat as a design task, not a query (`06:89`; `16:167`) |
| No SLA model exists | P2-WS3 ambiguous | Decide scope (full timers vs. display) before building (§10; `02:131`) |
| POR-6 (quote send) not delivered | No quote auto-send | Human sends from the portal quotations module; acceptance read-back still works (`13:108`) |

---

## 10. Open items that gate estimation / start

1. **Phase 2 calendar estimate** — roadmap says 8–12 weeks (`06:76`); re-estimate at P1 exit against the actual P1 seams delivered.
2. **Recurring-generation owner** (app vs. ERP) — §8 freeze gate.
3. **SLA scope** — a full timer/breach/escalation model, or a plain response-time display? No model exists today (`02:131`).
4. **Reporting metric definitions** — utilization / FTF / MTTR / top-problem-devices are undefined in the docs; coverage-%/rollups/lot/sampling are defined in doc 11 (`06:89`; `11:53-55`). Plus the revenue-per-technician attribution join.
5. **Portal module shape** — drives the `/api/ext` read-API re-cut and the POR-2 generalization; only the approval-trigger endpoints are committed until it lands (`20:17`; `13:91`).
6. **Sibling-team asks** — CAL-4 (intake asset ref), CAL-6/7/8 (calendar service-activity UX), POR-1/2/6/7 (invoice cross-link, signoff, quote/doc send). Fallbacks ready for each (`13`).
7. **Ops & lifecycle package** — retention enforcement, `/api/ext` rate-limit hardening, tenant export: confirm which ride along Phase 2 vs. defer to Phase 3 (`16:94-104`; `20:66`).

---

## 11. Explicitly out of scope (Phase 3 guard rails)

Do **not** build in Phase 2 (`06:93-105`; `13:63`):

- Scheduling assist / suggest-technician-by-skills-distance-availability, and the **CAL-5 merged-busy-times availability query** (both **Phase 3**, not Phase 2 — `13:17,63`; `08:41`); route optimization for multi-stop days.
- Usage/meter-based preventive maintenance with predictive due-date drift.
- Part-compatibility mining from approved worksheet usage.
- AI assist (worksheet summary drafting, similar-past-faults retrieval, voice-to-form).
- Live technician tracking; no-login self-scheduling.
- Skills & certifications registry; subcontractor / multi-company; additional non-HansaWorld adapters; IoT hooks.
- Deeper analytics beyond reporting v1 (the `CustomerFeedback` captured in Phase 2 feeds Phase-3 reporting — `16:84`).

Phase 2 stands on the Phase-1 seams (§3) without reworking them; its own contract overlay, recurring generator, and compliance-document types are built so Phase 3's intelligence layer reads from them.
