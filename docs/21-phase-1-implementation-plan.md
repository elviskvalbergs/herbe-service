# herbe.service — Phase 1 Implementation Plan

Status: v1.0 (2026-07-11). Scope: **roadmap Phase 1 — "The product"** (`06-roadmap.md` lines 21–74), the single large phase created when old Phase 1 + Phase 2 were collapsed (round-5 decision #18, `20-spec-review-round-5.md`). Phase 0 foundations are taken as **given** (in progress on a separate worktree); this plan lists P0 outputs it depends on but does not re-plan them.

This is a work-package / sequencing plan: what to build, in what order, what to reuse vs. build, how each package is tested against the P0 harnesses, and what still gates a calendar estimate. It is not a re-spec — the truth lives in docs 02–08, 11–14, 17. Line cites point there.

---

## 1. What Phase 1 delivers (exit criteria, from the roadmap)

Three concrete acceptance targets (`06-roadmap.md:74`):

1. A pilot company runs its **real service work for 2+ weeks**, with invoices issued from the ERP off synced worksheets.
2. A dispatcher plans a **5+ technician team (incl. crew jobs)** for a week entirely in-app.
3. **Parts stock in the ERP matches reality** after a period of app-driven consumption.

Everything below is scoped to reaching those three, and nothing beyond (Phase 2/3 guard rails in §11).

---

## 2. Load-bearing constraints (do not violate)

These are the decisions that shape every workstream. They are settled; treat them as invariants.

- **Server is truth; client is UX.** The status machine, field policies, and merge all enforce server-side; offline taps replay through the outbox and can be bounced as conflict tasks, never silently dropped (`02:70,149`; `01-data-and-ui.md §2`).
- **The push queue is the only ERP writer.** All app→ERP writes go through the outbox → push-queue saga. No HTTP handler, cron route, or component writes ERP directly (`04:57`; `03:114-120`).
- **HTTP 200 is not proof of a write.** Reproduced twice on the live probe: 200 + echoed data, zero rows persisted. Every create-push confirms a real assigned id (`SerNr`/`@url`) or reads back before marking the step done (`04:117`; `19` §11).
- **Service registers have no delta API.** `SVOVc`/`WSVc` lack `UUID`/`ServerSequence` → sync is `TransDate`-windowed scans + resumable `SerNr` key-sweep. The engine must be correct on full-scan-only connections (`17:9`; `19:33`).
- **Capability + version gating, never "disabled".** A feature on an absent capability is hidden or falls back gracefully — never shown disabled. WebExcellentAPI presence gates general actions; service/contracts documents are version-gated by an admin regex against the `systemversion` attribute on the REST `<data>` root (`04:74-79`; `20-...` #10).
- **One worksheet per (order × technician).** `WSVc.EMCode` is single-person. Crew = N worksheets sharing a `crewGroupId`; no shared "lead worksheet" document, no `addedBy` (`16` §7.1; `02:74-77`).
- **We build no second Kanban.** The dispatch board is time × technician capacity only; the status/pipeline Kanban is delegated to herbe.calendar via the status→`ActState` shadow mapping (`06:42`; `04:235`).
- **`erpRef` is a set keyed by purpose**, not a scalar — one entity maps to several ERP records (a worksheet → `WSVc` + `worksheetShadow` `ActVc`) (`02:153-158`).
- **TDD from the first commit; spec rule → named suite.** Coverage gate ≥90% on core-logic packages, ≥80% overall, but the real gate is "every spec rule has a suite" (`15:5-11`).

---

## 3. What Phase 1 assumes from Phase 0 (hard dependencies)

If any of these is not delivered by P0 exit, the dependent workstream slips. Confirm at the P0/P1 handoff.

| P0 output | Consumed by | Ref |
|---|---|---|
| Walking-skeleton PWA (installable, offline, PIN login), one-ERP master-data pull through the reused adapter, one Vercel cron sync job | WS1, WS3 | `06:14` |
| Sync-engine ADRs: local DB choice + device-at-rest scope; **scoped-replication membership model with scope-exit purge proven on-device**; conflict rules validated against real ERP; key-sweep & sequence-reset handling; **PDF-rendering approach** | WS1, WS3, WS4, WS12 | `06:17` |
| `@herbe/erp-core` extracted (ErpAdapter contract, REST + WebExcellentAPI clients, register cache, encrypted creds, incremental + ActVc write mechanics) — or the copy-first fallback | WS3, WS4, WS5 | `08:120`; `04:39` |
| Provisioning CLI adapted Neon→Supabase Management API; fleet inventory + version train; Supabase-branching per-preview DBs | WS14, all deploys | `06:11`; `20-...` #15 |
| Test infra: fake ERP server + fixture recorder, sync simulation harness (incl. scoped-replication scenarios), golden-fixture library, seed engine + scenario packs, fixed role personas, guarded `TEST_AUTH` login, CI coverage gates | every WS | `15:17-94` |
| **Owner-arranged dedicated test ERP** (with/without WebExcellentAPI + a planned version upgrade) + reference device set | WS3/4/5 (blocker), WS9 (mid-P1) | `15:90,108` |
| Design-system P0 items: global sync indicator, record sync badge, job card + my-jobs list, PIN pad, device enrolment; `herbe.service` amber-dot wordmark | WS1, WS9 | `14` §2 |
| Confirmed register codes (`SVOVc`, `WSVc`, `SVOSerVc`, `DelAddrVc`, `ItemStatusVc`, `RLinkVc`, `COVc`) + `ActVc.AccessGroup` verification | WS3 | `06:13`; `20-...` §3 #11 |

---

## 4. Workstreams

Fourteen packages. Each: **goal**, **key deliverables**, **reuse vs. build**, **depends on**, **TDD focus**. IDs are stable references for the sequencing in §5.

### WS1 — Platform foundations & app shell
**Goal:** the two shells, the offline data layer surfaced as product, and the push transport, on top of the P0 skeleton.
- **Deliverables:** field shell (Today · Jobs · Scan · Inbox · More) + office shell (sidebar) with company switcher (`07:6-10`); design-system **field extensions** (field-density scale, sunlight/high-contrast + dark, sync-state colours, charge-type badge, work-entry-mode indicator, revision-state badge, print/PDF tokens — `14` §1); full **briefcase / "download my work"** UI (scoped replication + scope-exit purge), **outbox**, **conflict inbox** as real UI (`06:52-53`; `03:86-101`); **Web Push infra** (VAPID, subscription store, fan-out worker — `06:46`; `03` §3); i18n (next-intl, 7 locales) from first commit; theming + settings model copied from portal.
- **Reuse:** portal theming/`--herbe-*` tokens, i18n setup, admin shell/components, PWA/service-worker patterns (copy-first, `08:109-118`). **Build:** field-mode design tokens & components (net-new, `14` §1-2); scoped-replication client (built on the P0 spike).
- **Depends on:** P0 skeleton + scoped-replication ADR + design-system P0 items.
- **TDD:** sync simulation harness scoped-replication scenarios (offline day + replay; job-reassigned-away purge); Playwright offline install/journey; perf budgets wired into CI (`15:70`).

### WS2 — Identity, auth, roles & licensing
**Goal:** all five roles logging in the way their job shape demands, on devices we can revoke.
- **Deliverables:** separate user store + `IdentityLink[]`; **role-shaped login** — office magic link (+ optional password/TOTP, Baltic eID, Entra ID OIDC per-tenant), technician **PIN on paired device** (enrolment link/QR), **WebAuthn platform-authenticator biometric** unlock in the installed PWA (no native wrapper); rolling-token-extend-on-unlock session model with hard absolute cap; **device registry + remote wipe** (`session_version` bump, wipe-on-N-failed-PIN); **ERP identity link** to `UserVc.Code` with **match-by-email helper** + periodic re-match; **seat/license enforcement** (blocked beyond count, admin usage view) (`05` all; `06:61,69`).
- **Reuse:** portal Auth.js v5 config, TOTP/magic-link/eID providers, `session_version`, AES-GCM crypto envelope; calendar `person_codes` model + `identity-rematch` cron (copy-first, `08:108`).
- **Depends on:** WS1 shell; P0 minimal A2/A3.
- **TDD:** real-auth suite through the UI (magic link via Mailpit, PIN, TOTP, revocation); access-rights matrix as a generated test (persona × route → allow/deny) (`15:68-77`).

### WS3 — ERP adapter, inbound
**Goal:** every Phase 1 register flowing ERP→domain, correctly, on both API tiers and full-scan-only connections.
- **Deliverables:** service-register loaders + mappers (`SVOVc`, `WSVc`, `SVOSerVc`→`unit` nodes, `DelAddrVc`→Sites, `ItemStatusVc`, `COVc` read-only stub, `SVCVc`, `UserVc`, plus reused `INVc`/`PLVc`/`DIVc`/`CUVc`+`ContactRelVc`/`IVVc`); store topology (cache→ingest→domain) with the two separate freshness concepts intact; per-register per-connection **poll cadences**; **windowed scans + resumable key-sweep** for no-delta registers; **capability probe + `systemversion` version gate**; **multi-company hardening** (company switcher, per-company sync health, `erp_company_id` scoping everywhere) (`04:43-122`; `17`; `19`).
- **Reuse:** `@herbe/erp-core` REST + WebExcellentAPI clients, register cache, freshness, `updates_after`/`@sequence` incremental (from calendar). **Build:** service-specific loaders/mappers, key-sweep cursor engine, version-gate matcher.
- **Depends on:** P0 adapter path + confirmed register codes + test ERP.
- **TDD:** mapper unit tests off golden fixtures; fake-ERP integration for paging, sequence-reset, filter-unreliability, control-chars/locale decimals; nightly live-contract replay (non-blocking) (`15:17-32`).

### WS4 — ERP outbound: push-queue saga & write mechanics
**Goal:** the approve→invoice write path, proven reliable — the single highest-risk deliverable.
- **Deliverables:** outbox → **push-queue saga** (FIFO per order; deps customer→order→worksheet→stock-txn-fallback; resume-from-failed step; idempotent stored-ref→natural-key→create; DLQ re-entry repairing `erpRef`); **`SVOVc` create** (no `SerNr`, ERP auto-assigns via `NextSerNr`; number-series onboarding check); **`WSVc` create** on Approved (`WONr=-1`, `SVONr`, `EMCode` via identity link — **approval blocked if technician has no ERP person code**, resolved `Location`, `UpdStockFlag` at POST, rows carry `ItemType` int 1–4, **app-computed totals** via replicated `WSSumup`); **persistence-verification** on every create; **poll `OKFlag=1` back** as the "ERP consumed stock" event; **`Invoiced` via linked `IVVc` (`getrecordlinks`)** and **`Closed` via `SVOVc.DoneMark`** as sync-set read-only; **standalone→ERP initial-load wizard** (company binding, natural-key matching, duplicate review) (`04:124-186`; `20-...` #6).
- **Reuse:** portal write-through + in-flight patterns, `getrecordlinks` client. **Build:** the saga engine, persistence-verification, `WSSumup` port, initial-load wizard.
- **Depends on:** WS3, WS8 (worksheet entity + status machine), WS2 (identity link).
- **TDD:** sync-harness push-group partial-failure + DLQ retry; "no ERP person code blocks approval"; persistence-verification against the fake ERP's "200-but-empty" mode; live create/read-back against the test ERP in the nightly job.

### WS5 — Bookings ↔ ActVc & shadow activities
**Goal:** planning and execution visible in the ERP/calendar, two-way, without ping-pong.
- **Deliverables:** booking↔`ActVc` two-way (persons via identity link, UTC+tz, type/symbol per-tenant, stage←status mirror, notes two-way); **N crew bookings ↔ 1 multi-person activity** with `crewGroupId` stability + detach-to-own-activity fallback; **echo suppression** (app-UUID tag + `@sequence`-vs-pending compare); **intake-type auto-convert** to ServiceOrder+Booking, other unlinked activities → triage task; **void-in-place cancellation** + in-place reschedule; **`worksheetShadow`** (P1 minimal, load-bearing for walk-up visibility) + **`orderShadow`** + **`workSegment`** activity purposes; **status→`ActState` map** (service-owned, per-connection) + one-click **`ActStateVc` seed tool** (`04:188-236`).
- **Reuse:** calendar `actVcSave`, echo/idempotency conventions, `lib/pipeline` Kanban is **theirs** (no build). **Build:** crew mapping, shadow-purpose writers, seed tool.
- **Depends on:** WS3, WS4 (erpRef writeback), WS8 (statuses to mirror).
- **TDD:** two-tech crew on one job; echo-suppression ping-pong scenario; reschedule-in-place vs. new-activity; walk-up worksheet gets a shadow footprint.

### WS6 — ERP connection config UI & sync health
**Goal:** the adapter is real product, operable by an admin, diagnosable under failure.
- **Deliverables:** connection definition UI (base URL, auth, company number, register set, capability flags, timezone, cadences, label/colour, invoice back-link field, **main service location**); add-company-from-same-server; activity-purpose map + status→`ActState` map + seed button; **transformations** — declarative maps + **sandboxed JS transform hooks** (the *same* sandbox WS12 reuses); **settings import/export** (secret-free); **sync-health screen** (per-register status/cursor/counts, push groups, **DLQ browser** edit-and-retry/discard-with-reason, **conflict queue** side-by-side, unlinked-activity triage, per-record inspector) + Observe/Act/Audit admin tools (`04:221-246`; `07` O11/A4).
- **Reuse:** portal ERP-companies admin, config-schema, capability model. **Build:** transformation sandbox + editor, sync-health/DLQ UI.
- **Depends on:** WS3, WS4, WS5.
- **TDD:** transformation-sandbox unit suite (determinism, no I/O, caps); settings round-trip import/export; DLQ retry re-enters at failed step.

### WS7 — Master data & the service-item tree
**Goal:** the tree spine everything attaches to, at scale, offline.
- **Deliverables:** Customers/Contacts/Sites (ERP-synced + **create-in-field with duplicate check**, merge in O7 via the **alias/tombstone-redirect** mechanism); **service-item tree** — `system`/`unit`/`lot` nodes + materialized path + `positionCode` + `labelId`; **group-coverage rows** (`all`/`n of m`/list/all-except) with **history propagation**; minimal **ItemModel** registry (seedable from `DIVc`); **PartCompatibility** (model×part×role) + **equivalence/supersession** + **fits-this-model-first offline lookup** with in-stock substitutes; **structure templates**; **spreadsheet import/export with dry-run diff**; **bulk operations** (filter→move/assign/label/create-group-order) (`11` all; `02:34-56,160-167`).
- **Reuse:** portal customers/contacts stores + cache. **Build:** the tree model, coverage records, compatibility engine, import/dry-run, bulk-ops bar (all app-master, no ERP contract change — `11:97`).
- **Depends on:** WS3 (inbound masters), WS1 (offline layer).
- **TDD:** coverage projection/rollup; merge-with-old-UUID replay; import dry-run diff correctness; fits-first ordering (van→warehouse→rank).

### WS8 — Service orders, worksheets & the status machine
**Goal:** the server-side state machine plus the rules that gate every transition.
- **Deliverables:** ServiceOrder/Row + Worksheet/Row/TimeEntry/DistanceEntry/ChecklistResult/Media/Confirmation/Revision/BillingAdjustment entities; **server-side status machine** (order: derived `Planned`/`In progress`, manual `Work done`/`Confirmed`, ERP-set `Invoiced`/`Closed`; worksheet: Draft→…→Approved→Synced + Rejected; cancellation cascade; rollback); **field-policy engine + config UI** (hidden/read-only/optional/required × role × work type, enforced at transitions, seeded defaults); **charge type** (app-owned, default per order row, inherited by worksheet row, per-row override; P1 suggestion `warranty` from `SVOSerVc` coverage else `invoiceable`; maps 1:1 to `ItemType` int); **correction/revision/billing-adjustment** flow; **media-completeness approval gate** (block + audited waive); approval **triggers the push group** (`02:58-151`; `01-data-and-ui.md §2-3,6`).
- **Reuse:** none directly — this is the app's core domain. **Build:** all, as pure modules with injected I/O (no rules in handlers/components — `03:118`; `15:15`).
- **Depends on:** WS7 (nodes to attribute rows to), WS1.
- **TDD:** state-machine suite (every transition + guard + rollback + cascade); field-policy persona × work-type × required-field matrix; charge-type suggestion + inbound `0`→review; media-gate + waive audit.

### WS9 — Field execution UX (technician)
**Goal:** a technician does a full day offline, gloves-on, in sunlight.
- **Deliverables:** F1 Today, F2 My jobs, F3 job detail, **F4 worksheet execution family** (Work/Parts/Time&km/Checklist/Photos; quantity stepper, part row + stock-location badge, per-row charge-type selector, service-item attribution picker, timer with **return-travel-after-Done** + **pause-with-reason** + tenant-cutoff auto-stop, transition button + blocking-requirements list), **checklist runner + builder (O9)**, **distance entry**, **F5 confirmation/signature** (content lock + re-sign re-entry), camera/media flow, **F9 scanner**, **F7 ad-hoc walk-up job start**, F6 service-item card (offline history), F10 inbox, F11 briefcase/profile (`07` F1-F11; `14` §2 P1).
- **Reuse:** none (net-new field UX); design-system field components from WS1. **Build:** all.
- **Depends on:** WS1, WS8, WS7, WS11 (scan/stock), WS13 (history card).
- **TDD:** Playwright offline journeys (accept→execute→done); checklist pass/fail bounds; timer/segment behaviour; optimistic-UI + conflict-badge flows.

### WS10 — Dispatch & scheduling (office)
**Goal:** one dispatcher plans a 5+ tech week, crews included, in-app.
- **Deliverables:** **O5 dispatch board** (day/week × technician rows, drag-drop bookings, unassigned pool **incl. unlinked inbound activities**, self-assignment toggle, delta-polling); **crew scheduling UX** (crew booking chip, move-as-group / detach member); **O6 map** (jobs + coarse tech positions); booking **notifications on assign/change** over WS1 web push; my-jobs day/week calendar (`06:41-46`; `07` O5/O6).
- **Reuse:** none (net-new); **explicitly not** a Kanban (delegated). **Build:** the board + crew chips + map.
- **Depends on:** WS1 (web push), WS5 (bookings↔ActVc), WS8 (order/worksheet state).
- **TDD:** reassignment → scope-exit purge on the tech device; crew move-as-group; unlinked-activity triage actions.

### WS11 — Van stock, scanning & QR labels
**Goal:** parts flow into worksheets and ERP stock matches reality; one sticker serves the technician forever.
- **Deliverables:** **van-stock resolution chain** (`UserVc.Location` → connection main-service-location → ERP main stock); cross-location lookup (incl. offline cache, staleness-labelled); transfers; min-stock indication; **scan part barcode → worksheet row**; **printable QR labels** for units *and* `system`/`lot` nodes; **freeze the label resolver-URL scheme** (`labelId`, login-routed) **before the first label prints** — hard gate (`06:48-50`; `11:74`; `08` §4a).
- **Reuse:** `ItemStatusVc` read path from WS3. **Build:** resolution chain, scan integration, label generator, resolver route.
- **Depends on:** WS3 (stock levels), WS7 (nodes/labelId), WS9 (worksheet rows).
- **TDD:** resolution-chain fallbacks (unpopulated `UserVc.Location`); scan-to-row; resolver routing (tech/customer/unknown/unscoped).

### WS12 — Documents
**Goal:** an approved order produces a themed report and any tenant DOCX, rendered off the critical path.
- **Deliverables:** **seeded default order-level report PDF** (renders all approved worksheets of an order as one doc, crew merged by `crewGroupId`, zero authoring); **DOCX template engine** (placeholders, loops incl. covered-units-of-a-lot, conditionals, images, localized formatting); **computed fields** via the **shared JS sandbox from WS6**; **template library** (upload, field-catalog browser, **test render + validation**, selection rules, version diff); **document number series** (immutable after first final render); **auto-generation on approval** via a queued render job; **PDF converter ADR + implementation** (LibreOffice/Gotenberg, sized to Vercel limits) (`12` all; `06:38`).
- **Reuse:** portal TemplateKey email engine for delivery mail (copy-first). **Build:** DOCX merge + converter pipeline, computed sandbox (shared), library UI.
- **Depends on:** WS6 (sandbox), WS7 (coverage/rollup context), WS8 (approval trigger), P0 PDF-rendering spike.
- **TDD:** merge-context golden fixtures; loop over coverage exceptions; sandbox determinism; Gotenberg PDF smoke in CI; number-series immutability.

### WS13 — HistoryEvent projector (platform component)
**Goal:** truthful per-node and per-customer history, offline, idempotent.
- **Deliverables:** projector with three triggers (worksheet transitions, ERP-ingest, item-status change), **deterministic keys** (source id + type + revision), **group-event down-projection + ancestor rollup** via row-level node attribution, **admin rebuild (A8)**, delta-fed to devices; pre-app ERP history import (`02:133-136`; `06:57-58`).
- **Reuse:** none. **Build:** as a cron-driven platform component.
- **Depends on:** WS7 (tree/coverage), WS8 (transitions/attribution), WS3 (ingest).
- **TDD:** idempotent re-run; rebuild == incremental; merge re-attach; group projection/rollup.

### WS14 — API shell, standalone, admin & ops
**Goal:** the remaining platform surfaces that make it a sellable product.
- **Deliverables:** **`/api/ext/v1` shell** (hashed scoped bearer tokens per company connection, admin minting UI, rate limiting 429+`Retry-After`) — **shell only; signoff/report/feedback endpoints are Phase 2**, but their shapes are designed against the contract now; **standalone mode** (no adapter) functional; **whitelabel option** (per-deployment domain/theme/email branding via dedicated deployment); **audit log** (append-only who/when/what/device — schema + write path, not just the screen); email/notification via reused **TemplateKey engine** (order-report mail, rejection notices); **admin surfaces** (A1 tenant settings, A5 templates, A6 modules, A7 audit, A8 migrations/projector-rebuild, A9 document-template library); **in-app `/docs` wiki + DocLink** from day one; **time-entry export** for payroll (`06:60-72`; `08` §4).
- **Reuse:** calendar `api_tokens` + `lib/rateLimit.ts`, portal docs-wiki + DocLink, migration runner. **Build:** standalone flows, `/api/ext` scoping, seat admin.
- **Depends on:** WS2 (tokens/roles), WS6 (settings), WS8 (audit write path).
- **TDD:** `/api/ext` contract tests consumed as portal fixtures; standalone-mode capability gating (F8/F9/O8 absent); token scope narrow-not-widen.

---

## 5. Sequencing — vertical slice first, then breadth

Milestones, not calendar dates (durations are the explicit P0-exit re-estimate, §10). The ordering front-loads the **highest-risk path (ERP writes)** so it is proven before breadth is built on it.

**M0 — Bridge from P0 (foundations on the skeleton)**
WS1 (shell + offline layer + tokens) · WS2 (all five roles logging in) · WS3 (inbound master data + service orders + `unit`/tree read) · WS8 minimal (order + worksheet entities + status machine core). Design front-loads the **O4 approval family** — the largest single UI item and the gate on the whole approve→invoice loop (`14:105`).

**M1 — Thin vertical slice (prove the write path end-to-end)**
Office plans a booking → technician executes one worksheet offline → manager approves (O4) → **WS4** pushes `SVOVc` + `WSVc` → poll `OKFlag` + `IVVc` read-back sets `Invoiced`/`Closed`. Threads WS8 (charge type, media gate) + WS9 (F4 execution) + WS5 minimal (`worksheetShadow` footprint). **This is the de-risking milestone** — it exercises the saga, persistence-verification, no-delta sync, and the un-OK'd-worksheet handoff against the test ERP. Do not fan out until this is green on the fake ERP *and* the live test ERP.

**M2 — Breadth (the field operation)**
WS5 full (crew, echo suppression, shadow purposes, status→ActState + seed) · WS10 (dispatch board + crew UX + web push + map) · WS11 (van stock + scanning + QR labels — **freeze the label scheme here**) · WS7 full (tree at scale, coverage, compatibility, bulk ops, import) · WS8 full (field policies + config, correction/revision/billing-adjustment) · WS9 full (all F-screens) · WS12 (report + DOCX engine) · WS13 (history projector).

**M3 — Config & standalone (make it a product)**
WS6 (connection config, transformations, settings import/export, full sync-health/DLQ) · WS14 (`/api/ext` shell, standalone + initial-load wizard, whitelabel, seat licensing, audit log, admin surfaces, `/docs` wiki).

**M4 — Hardening & pilot**
Perf budgets enforced in CI (`15:70`); multi-company hardening; reference-device + gloves/sunlight field pass (`15:108`); pilot tenant runs real work 2+ weeks → the exit criteria (§1). Backup/restore + `/api/ext` rate limiting ride along here (`16` §2.9 items 1, 5).

Critical path runs M0→M1 through WS3→WS8→WS4→WS5; WS7/WS12/WS13 can proceed in parallel once WS8's entities exist; WS6/WS14 are last because they wrap already-working machinery in product UI.

---

## 6. Reuse ledger (concrete)

| Capability | Decision | Source |
|---|---|---|
| ErpAdapter contract, REST + WebExcellentAPI clients, register cache, encrypted creds, incremental + `ActVc` write | **Extract** `@herbe/erp-core` (P0) | `herbe-portal/lib/erp/standard-books/*`, `herbe-calendar/lib/herbe/*` |
| Email TemplateKey engine (types, render, defaults, dispatch) | Copy-first | `herbe-portal/lib/email/*` |
| Auth.js v5 (magic link, TOTP, eID, `session_version`), crypto envelope | Copy-first | `herbe-portal/lib/auth`, `security` |
| Scoped bearer tokens + rate limit | Copy-first | `herbe-calendar/lib/apiTokens.ts`, `lib/rateLimit.ts` |
| Docs wiki + DocLink, migration runner, admin shell, theming, i18n | Copy-first | `herbe-portal` |
| Cron dispatcher + table-based locks | Copy-first (prefer table lock on Supabase pooling) | `herbe-calendar` cron + `cronLock.ts` |
| Provisioning CLI | Adapt Neon→Supabase Mgmt API | `herbe-portal/lib/provisioning` |
| Pipeline/status Kanban | **Do not build** — delegated | `herbe-calendar/lib/pipeline` |

Rule: only `@herbe/erp-core` becomes a shared package; everything else is copy-first with attribution to avoid premature coupling across three apps (`08:120`).

---

## 7. Cross-cutting (every workstream)

- **i18n** on every user-visible string from the first commit (7 locales; ET/EN/LV/LT/FI/NO translated in P1, `sv` follows) (`07:185`).
- **Design-system compliance**: field-mode tokens for field surfaces; portal non-negotiables verbatim on office surfaces (square indicators, `--herbe-bone`→`--herbe-paper` inputs, forest-green CTA, red brand+destructive only, no circular avatars); inline-SVG wordmark `.service` variant (`14:103,186`).
- **Accessibility**: gloves/sunlight/one-hand acceptance criteria into CI + design review; accessibility overrides tenant branding (`14` §3).
- **Audit**: append-only, who/when/what/device on every state change — write path lands with WS8, not deferred to the screen (`06:70`).
- **Docs wiki grows with each feature**; DocLink `?` at F11, O2, O4, A4, A5 (`07:171`).
- **Perf budgets** as CI assertions (offline cold-start <3s, briefcase <1min/4G, replay <30s) (`03:122-129`).

---

## 8. Freeze gates & one-way doors

- **Label resolver-URL scheme** (`labelId`, login-routed) — frozen before the first QR label prints (WS11). Stickers outlive software (`08` §4a).
- **Charge-type enum** — locked to string set 31 (`1`–`4`), push integer / read label, 1:1 with app charge types; never conflate with `INVc.ItemType` (`20-...` #9).
- **Persistence-verification** — mandatory in every create-push before a step is marked done (`04:117`).
- **`/api/ext/v1` contract** — the two approval-trigger endpoints are the only committed surface; the wider read API is re-cut once the portal module's shape settles (`20-...` #5, open item §10).

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ERP write reliability (silent non-persist) | Corrupt invoicing | Persistence-verification + live read-back; nightly live-contract job; front-load in M1 |
| No delta on `SVOVc`/`WSVc` | Missed/duplicated records | Windowed scans + resumable key-sweep; validate on full-scan-only fake-ERP mode |
| Scoped-replication correctness (stale gate codes on a lost phone) | Security/GDPR | P0 on-device purge proof; harness reassignment-purge scenario is a release gate |
| Auth/session breadth (3 login shapes, offline token extend) | Lockout or over-exposure | Reuse portal providers; dedicated real-auth UI suite; absolute cap + `session_version` |
| DOCX→PDF converter vs. Vercel limits | Report blocked | Converter ADR early (WS12), seeded by P0 spike; render off the critical path in a queue |
| Sibling config asks (CAL-1/CAL-2) unanswered | Booking friction | Every ask has a fallback (per-tenant values, heuristic self-echo) — no hard code dependency (`13`) |
| Phase 1 scope (absorbed old P2) vs. small team | Slip | Milestone gating; M1 slice proves risk before breadth; deliberate trim conversation at re-estimate |

---

## 10. Open items that gate estimation / start

1. **Phase 1 re-estimate at P0 exit** — the 10–14-week figure predates the merged scope (tree, km, crew, ActVc two-way, sync admin, licensing, audit). Expect the upper bound or a deliberate trim (`16:119`; `20-...` §3 #10).
2. **Remaining probe items** — `WSVc` row charge-type fields, `RLinkVc` REST readability edge cases, `ActVc.AccessGroup` verification (most others resolved in `19`/`20`).
3. **CAL-1 / CAL-2** — booking `ActType`/`ActState` conventions + echo-tagging: config agreements, fallbacks ready.
4. **Pricing/packaging final call** (per-user + seat decided; whitelabel/multi-company as axes).
5. **Ops & lifecycle package** — acceptance as Phase 2/3 scope; only backup/restore + `/api/ext` rate limiting ride along in M4 (`16` §2.9).
6. **Portal module shape** — drives the re-cut (small) `/api/ext` contract; only the two approval-trigger endpoints committed until it exists.

---

## 11. Explicitly out of scope (Phase 2/3 guard rails)

Do **not** build in Phase 1 (`06:76-105`; `11:102-103`; `12:65`):
- Phase 2: service contracts + recurring generation + coverage-view rollups + SLA timers; lot explosion; checklist sampling rules; compliance certificates + contract-cycle docs; portal customer surface + signoff/report/feedback `/api/ext` endpoints + signing descriptor + `orderShadow` no-module fallback; quote flow; Smart Booking intake; native wrappers; reporting v1.
- Phase 3: scheduling assist / route optimization; usage-based PM; compatibility mining from usage; AI assist; live tracking; skills registry; subcontractors; additional non-HansaWorld adapters; IoT.

The Phase 1 tree + coverage records, `worksheetShadow`/`orderShadow`, the DOCX engine, and the `/api/ext` shell are deliberately built so Phase 2 stands on them without rework.
