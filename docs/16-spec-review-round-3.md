# herbe.service — Spec Review, Round 3: Fork Reconciliation, Integration Blind Spots, Plan Readiness

> **Historical record — superseded.** Current spec truth lives in docs 02–08, 11–14, 17. Statements below may be out of date; do not implement from this doc.

Status: v1.0 (2026-07-05). Scope: the merged spec (docs 01–15 as of `62d63ac`), reviewed for (a) blind spots in how the specified parts work **together**, and (b) whether every feature sits cleanly in a phase so an implementation plan can be written. Verified against the sibling repos again this round (calendar mirror `b57fcbd`, portal mirror v1.0.24 + service-modules spec v1.1).

**Verdict up front: the spec is implementation-plan-ready for Phase 0 and Phase 1 after this round's fixes** (§1.1 crew contradiction closed by the owner's direct statement on the canonical branch; §1.4 branch hygiene remains a process ask). Round 3 found no new blocker-class design gaps — the seams found this time are short, patchable rules (all patched in this branch, §4) plus a set of operational-lifecycle topics the spec has never mentioned (§2.9) that don't block Phase 0/1 but must be decided before a paying tenant depends on the product.

---

## 1. Fork reconciliation: the `dl0dp4` parallel review line

Round 2 already merged two spec lines. This round found a **third**: branch `claude/spec-review-gaps-dl0dp4` (2026-07-05 13:28–14:44) ran an independent round-2 review from the stale v0.2 base, unaware of the canonical merge — and it **records owner answers of its own**, some of which never reached the canonical line. Reconciliation:

### 1.1 ~~⚠ OWNER~~ RESOLVED — Contradicting owner decisions on the crew ↔ activity model

> **Closed 2026-07-05 (canonical-branch merge):** the owner's direct statement — "the version with multi-person ActVc … is legit" — predates and answers this. Multi-person primary stands; the `dl0dp4` record is superseded. `dl0dp4` can be retired per §1.4.

Two records, both attributed to the owner, both dated 2026-07-05:

| Branch | Recorded owner answer |
|---|---|
| canonical (`j9xlbi` line, this branch) | **Multi-person `ActVc` activity is the primary mode**: N crew bookings ↔ 1 shared activity; per-person activities only as the split fallback (`02`, `04`) |
| `dl0dp4` (R2-11 resolution) | Booking↔worksheet many-to-many, "**one activity per technician**" |

These cannot both stand. **Recommendation: keep the canonical model.** It was the adjudicated merge decision, made with the full audit-line context (the `dl0dp4` session never saw the team-jobs design), and it already *contains* per-person activities as the fallback when crew windows diverge — so the dl0dp4 answer is a degenerate case of it, not an alternative. Needs one line of owner confirmation, then `dl0dp4` can be closed.

### 1.2 Owner answers unique to `dl0dp4` — adopted into the canonical spec this round

These filled genuine gaps and contradict nothing; applied as recorded (§4):

| dl0dp4 record | Gap it closes | Applied in |
|---|---|---|
| Signed snapshot immutable + **billing-adjustment layer**; corrections after `Approved`/synced = **correction worksheet** | Canonical `02` covered rejection/bounce revisions but had no path for (a) manager price/qty fixes on a signed sheet, (b) mistakes discovered after ERP sync/invoice | `02` signature-lock section |
| Stock: **negative van/warehouse quantities allowed** + sync-health reconciliation task | `StockLevel` carried `(+ reserved)` but no reservation flow and no rule for two offline technicians consuming the same last unit | `02` StockLocation section |
| **Customer-facing order number = ERP number once synced**, app number before; never changes retroactively in customer surfaces | `number (app-local + ERP number)` never said which one the customer sees (`/api/ext` returns `orderNumber`) | `02` ServiceOrder |
| **QR label = one resolver URL, routed by login; stable non-guessable `labelId`**, scheme frozen before any label is printed | Labels are printed in Phase 2; the portal QR route arrives Phase 3 — one physical sticker must serve technician *and* customer forever | `02` ServiceItem, `08` §4a, `06` Phase 2 |
| Pause reasons ship **Phase 1** with the state machine | `02`/`07` had them P1, `06` listed them under a P2 bullet — internal inconsistency | `06` |
| **Seven locales** (portal set incl. `sv`) | `06` cross-cutting heading named six languages, then cited the 7-locale portal set | `06` |
| **Notification ownership table** (event → sender → template system → link target; portal links assume login; email-only in practice) | Canonical `08` had the pieces scattered; portal owns `service_request_received`/`service_work_done`, service owns booking/on-the-way/rejection — without one table an email gets sent twice or never | `08` §4b |

### 1.3 dl0dp4 content deliberately **not** adopted

- Its `08-suite-integration.md` — superseded by the canonical `08` (richer: reuse inventory, calendar tiers, Kanban delegation). The notification table (§1.2) was its one unique asset.
- "Booking↔Worksheet many-to-many" — the canonical model (booking → order mandatory, → worksheet 0..1; many bookings per worksheet) is strictly more precise and already covers crew/multi-day.
- Its stack resolution ("Supabase as plain Postgres, auth = NextAuth") — same as canonical; nothing to do.

### 1.4 ⚠ OWNER — Branch hygiene across all four repos

This round's root-cause finding: **spec truth is fragmenting across parallel session branches, in two repos.**

- herbe-service: `dl0dp4` must be retired after 1.1 is confirmed (its unique value is now merged here); older branches (`6v7x5r`, `9a23yu`, `y0zu1u`, `5l1cby`) are strict ancestors/superseded lines — safe to delete.
- herbe-portal: the service-modules design spec + v1.1 addendum live only on `claude/`-prefixed **mirror branches** — not on the portal's Bitbucket `main`. The frozen `/api/ext/v1` contract is currently an unmerged commit in a mirror. Same for the calendar mirror (single `clone-bitbucket` branch).
- **Ask:** designate one canonical branch per repo for spec work (this one for herbe-service), land the portal spec on the portal's real mainline, and delete stale session branches. Otherwise round 4 will be another archaeology exercise.

---

## 2. New blind spots: how the specified parts work together

Round-2 closed 22 seams; these survived it. Each lists the applied fix (§4) or the owner call.

### 2.1 Media completeness vs. approval, PDF, and ERP push — FIXED

Photos/signatures upload as **separate resumable blobs** referenced by outbox ops (`03`). So a worksheet can reach the server `Done` — visible in the approval queue — while its media blobs are still queued on the phone. Approval then triggers the report PDF and ERP push, which consume that media. Nothing gated approval on media completeness. Rule added (`02`): the approval screen shows per-worksheet media upload state; **Approve is blocked while referenced media is missing** (with a "waive" override for the manager, audited — a dead phone must not block invoicing forever); the report renders only referenced-and-present media and is regenerated if waived media arrives later.

### 2.2 Booking cancel/reschedule → what happens to the ERP activity — FIXED

`rescheduled` = cancel-and-recreate (`02`), but activity **deletion is a WebExcellentAPI capability** (`04`) — on REST-tier-only connections the adapter cannot delete the old activity, leaving ghosts on the technician's ERP calendar (and in herbe.calendar). Rule added (`04` ActVc mapping): cancellation writes the cancelled/void state **into** the activity (per-connection config: the `cancelled` workflow stage or the tenant's "cancelled" activity type/flag) rather than deleting; actual deletion only where the capability flag is on; reschedule prefers **in-place update** of the same activity (new time window) over cancel-and-recreate whenever the booking keeps its identity — the cancel-and-recreate bookkeeping stays app-side.

### 2.3 Order cancellation cascade — FIXED

`Cancelled` is a manual order transition, but no rule said what happens to its live children. Added (`02` derivation rules): cancelling an order requires no worksheet beyond `Accepted` (else block with the list — cancel the work first, same pattern as field policies); open bookings auto-cancel (which triggers 2.2 on the ERP side); worksheets in `Draft/Assigned/Accepted` auto-cancel with a technician inbox notice. `Closed` additionally requires all worksheets terminal. *(Superseded by decision #13 — no app-side completion guard; `Closed` is ERP-sync-set from `SVOVc.DoneMark`, `04-erp-sync.md`.)*

### 2.4 Unlinked inbound activities arrive in Phase 1, their screen was Phase 2 — FIXED

Inbound `ActVc` sync incl. the unlinked-booking rule is Phase 1 (`06`), but the only specified surface for unlinked activities was the dispatch board's unassigned pool (O5 — Phase 2). Fixed (`06`, `07`): Phase 1 surfaces unlinked inbound activities as a task list section on the **Sync health screen** (O11, which managers already read) with the same three actions (attach / create order / dismiss); the board pool takes over in Phase 2.

### 2.5 Inbound crew activity in Phase 1: who is the lead — FIXED

Phase 1 syncs multi-person activities but has no crew UX; a multi-person activity creates N bookings and one worksheet — the lead-selection rule existed only for app-created bookings. Added (`02` crew section): for inbound crew activities the lead defaults to the activity's **main person** (`MainPersons` (plural, confirmed in sibling code) — the field herbe.calendar already maps); if that person has no linked user, the first linked member becomes lead and sync health warns.

### 2.6 Portal-facing entities were in the API contract but not in the data model — FIXED

`08` §4 (synced with portal addendum v1.1) exposes `labelId`, `enRoute`/ETA and feedback — but `02` had no `labelId` on ServiceItem, no `enRoute`/"On my way" on Booking, and **no Feedback entity at all**. Added (`02`): `labelId` (stable, non-guessable, survives serial correction) on unit/system/lot nodes; `enRoute` flag + `etaMinutes` set by the technician's "On my way" action (Phase 3 UI, fields from Phase 2 schema); `CustomerFeedback` (order × portal user, rating + comment, idempotent upsert, feeds Phase 3 reporting).

### 2.7 Customer-visible order status vocabulary — FIXED

The portal shows "derived status", but exposing the internal 8-state machine verbatim leaks operational detail (`Work done` pre-approval) and over-promises granularity. Added (`08` §4): a fixed public mapping — `New/Accepted → received`, `Planned → scheduled` (+ slot), `In progress/Paused → in progress` (+ `enRoute`), `Work done/Confirmed → work done`, `Invoiced/Closed → completed`, `Cancelled → cancelled`. Part of the frozen contract.

### 2.8 Key-sweep reconciliation vs. serverless duration limits — FIXED

The nightly key-sweep pages through **every** record ID per register (`04`); on a large tenant that exceeds one function invocation, and unlike the poll loop it had no stated chunking/cursor. One line added (`04`): sweeps persist a per-register cursor in `sync_state` and run as resumable slices under the same `sync-tick` dispatcher; a sweep is "complete" only when a full pass finishes within the reconciliation window — identical in spirit to the portal's full-sync bookkeeping.

### 2.9 ⚠ OWNER (non-blocking) — Operational lifecycle topics the spec never mentions

None of these block Phase 0/1 development, but all become real the day a paying tenant exists. Currently zero coverage anywhere in docs 01–15:

1. **Backup / restore / disaster recovery** — Supabase PITR settings per project, restore drill, and the version-train rollback story (a bad release + per-deployment DB migrations = how do we roll back?).
2. **Tenant offboarding & data export** — "history is the product": a leaving tenant will demand their service history (and GDPR portability). An export (per company: entities + media + documents in an open format) should be a committed feature, roughly Phase 3.
3. **Shared→dedicated migration mechanics** — `03` asserts a tenant "migrates without schema changes" but no mechanism exists (dump/restore per `tenant_id`? provisioning-CLI job?). Fine to defer; say it's deferred.
4. **Retention enforcement** — GDPR bullets say "retention policies per tenant" but nothing enforces them (media, audit log, tombstones, DLQ). Needs a cron job + per-tenant config, Phase 2–3.
5. **`/api/ext` rate limiting / abuse** — the portal proxies customer traffic to us; calendar already ships `lib/rateLimit.ts`. One sentence in the contract (429 + `Retry-After`) plus reuse of that pattern.

Recommendation: accept these as a named "Operations & lifecycle" work package in Phase 2/3 planning; items 1 and 5 are small enough to land with Phase 1 hardening.

### 2.10 Verified again this round (no action)

The calendar/portal claims the spec leans on were re-verified against source: Neon + raw `pg`/Drizzle (no Supabase anywhere in siblings), Auth.js v5 magic-link with `person_codes` gating, Vercel cron authoritative in calendar (15-min daytime / hourly night + 03:00 full) vs. ops-runner in portal, native Swift WKWebView shell (not Capacitor), `ActVc` two-way with OAuth refresh + HSESSION + HTTP/1.1-only HAL, advisory locks + `cron_locks`, no i18n in calendar (portal's next-intl is the only pattern — as `06` says). One nit for Phase 0: calendar's `ACTIVITY_ACCESS_GROUP_FIELD = 'AccessGroup'` carries a "verify against actual ActVc field list" TODO — add it to the register-confirmation checklist.

---

## 3. Phase audit — can an implementation plan be written?

Sweep of every feature named in docs 02–15 against the roadmap:

- **In a phase, unambiguous**: the field loop, tree P1/P2 split, crew (model P1 / UX P2), documents (built-in P1 / engine P2 / compliance P3), field policies (engine P1 / UI P2), `/api/ext` P2, portal modules P3 (portal-side), quote flow P3, Smart Booking P3, wrappers P2/3, adapter + sync admin P1, licensing P1, testing infra P0. ✔
- **Fixed this round**: pause reasons (P1, `06` cleaned), unlinked-activity surface (P1 home on O11), QR resolver scheme (frozen in P2 before first label), feedback/ETA/labelId model homes (schema P2, features P3), correction-worksheet flow (P1 — it's part of the approval loop), negative-stock rule (P2 with van stock; P1 main-warehouse consumption can already go negative ERP-side and lands in sync health).
- **Deliberately unphased, acceptable**: Phase 4 backlog (explicitly "prioritize by pilot data"); operational-lifecycle items pending §2.9 acceptance.
- **Known-stale estimate**: Phase 1 10–14 weeks predates the merged scope growth (tree, kilometers, team-ready model, `ActVc` two-way incl. crew, sync admin, licensing, audit log) — re-estimate is already flagged at Phase 0 exit (Q5); expect the upper bound or a deliberate Phase 1 trim conversation.

**Readiness verdict:** with §4 applied, docs 02–15 are consistent and complete enough to cut a Phase 0 + Phase 1 implementation plan (work packages, dependencies, staffing) — the remaining unknowns are exactly the ones Phase 0 exists to close (register codes, test-ERP behavior, design-system import, estimate re-check). The two §1 owner items don't block plan-writing: 1.1 only affects the `ActVc` mapper's crew mode (an isolated module either way), 1.4 is process. **Recommended next step: write the implementation plan for Phase 0 + Phase 1 off this branch.**

---

## 4. Applied in this round (spec v0.5)

- `02-data-model.md` — billing adjustments + correction-worksheet rule; media-completeness approval gate; order-cancellation cascade; inbound-crew lead rule; negative-stock rule; customer-facing numbering rule; `labelId`; Booking `enRoute`/ETA; `CustomerFeedback` entity.
- `04-erp-sync.md` — activity cancel/reschedule handling without delete capability; resumable key-sweep cursor.
- `06-roadmap.md` — pause-reasons P2 bullet removed (P1); locale list unified at seven; Phase 1 unlinked-activity surface; Phase 2 QR "scheme frozen before first label" note; §2.9 ops package pointer; open-items list updated (Q1 closed, crew confirmation + branch hygiene added).
- `08-suite-integration.md` — notification-ownership table; QR resolver routing; customer-visible status mapping (frozen contract).
- `07-ui-screens.md` — O11 gains the Phase 1 unlinked-activity task list; O4 media-completeness state.
- This document; spec viewer regenerated.

---

## 5. Round 4 — owner decisions 2026-07-06, applied

A fourth pass (on branch `spec-review-gaps-ukjna3`, initially run from a stale base — merged onto this line afterward; the branch-hygiene warning in §1.4 proved itself) re-raised a set of seams; the owner answered on 2026-07-06. All applied:

| # | Owner decision | Applied in |
|---|---|---|
| 1 | Portal integration stays as specified — no change | — |
| 2a | Order `Work done` = **manual technician "job done"**; `Confirmed` = **manual manager** review gate; in-flight states stay derived; auto-transitions are a future opt-in workflow feature | `02` transition rules, `06` P1, `07` O2/O3 |
| 2b | **Work-entry modes**: booking-first / worksheet-prepared-ahead / walk-up-no-booking — one flexible model, all three first-class | `02` Booking, `07` F1/F2/F7/O2 |
| 2c | **Activity as integration vessel**: distinct activity type per purpose incl. a **`worksheetShadow`** mirror (shallow two-way: time window, customer, links, stage) so ERP/calendar/CRM see execution as well as planning | `04` purpose map + "not mapped" note, `06` P2 |
| 3 | **Charge type per worksheet row** (`invoiceable/warranty/contract/goodwill`), default on ServiceOrder → Worksheet, override per row; maps to ERP chargeable/warranty handling | `02`, `04` push flow + register table, `06` P1, `07` O4 |
| 4 | Scoped replication: classical **scope-membership + scope-exit purge** design approved | `03` offline sync, `06` P0 ADR + P1 |
| 5 | ActVc echo/orphan/delete rules confirmed as specced (round 2/3 had closed them); phase homes verified (booking mirror P1, shadow P2) | — |
| 6 | **Multiple service items per order and worksheet stay; every row attributes to a node**; checklists attributed; time stays per member | `02` row attribution, `06` P1, ER diagram |
| 7 | Stock/invoicing pushes clarified: **the worksheet is the only document we deliver by design** — ERP-native Work Sheet processing owns stock + invoice basis; explicit stock posts demoted to a per-connection fallback, Phase 0 confirms which tier each connection needs | `04` worksheet flow + saga note, `06` P0 ADR |
| 8 | Re-signature after corrections is a **manager judgment** (system diffs + recommends; decision audited); immutable after manager approval — confirming and refining the round-3 revision rule | `02` signature lock, `07` O4 |
| 9 | **Work segments → ERP activities** (from a real Frontu↔Standard ERP customer request): discrete work/travel segments with direction, per-kind optional activity types (`travelTo`/`work`/`travelBack`), live or on-approval delivery; return-travel after `Done` attaches to the worksheet and syncs via the outbox with no manual send; tenant-cutoff auto-stop for forgotten timers | `02` TimeEntry, `04` purpose map, `06` P1/P2, `07` F4 |

§1 items closed 2026-07-06: **crew model confirmed — one shared multi-person activity is primary** (1.1; the `dl0dp4` per-person answer is retired). `spec-review-gaps-ukjna3` is the canonical spec branch; the stale herbe-service session branches (`5l1cby`, `9a23yu`, `y0zu1u`, `6v7x5r`, `dl0dp4`, `j9xlbi`, `kva02d`) are all merged/superseded and cleared for deletion — the session environment can't delete remote branches (push restricted to its own branch), so the owner runs the delete. Remaining from 1.4: landing the portal service-modules spec on the portal's Bitbucket mainline (the portal/calendar mirror branches must **not** be deleted until then).

---

## 6. Round 5 — register verification, 2026-07-06 (owner + halocron)

The owner supplied live ERP export structures for `SVOVc` and `WSVc` and enabled the halocron MCP (register dictionary + HAL source); the remaining register unknowns from the Phase 0 checklist were resolved without waiting for demo-system access:

| # | Finding / owner answer | Applied in |
|---|---|---|
| 1 | `SVOVc` (service orders) and `WSVc` (work sheets) verified — **available via REST even where the module UI isn't licensed**; full field structures captured | `04` table + findings, `17` (new) |
| 2 | **Posting `WSVc` does not consume stock; `OKFlag=1` does — and the OK is done by a manager in the ERP for v1** (adapter never sets it); `UpdStockFlag` set at POST, immutable after OK | `04` worksheet flow + findings |
| 3 | Stock levels read from **`ItemStatusVc`** (item × location, incl. `InWSheet`); app shows levels, never computes or posts them; technician van location = `UserVc.Location` (`ServLocation` variant to confirm) | `04` table + findings, `17` |
| 4 | Invoice/worksheet back-link: **record links (`RLinkVc`/`getrecordlinks`) primary**, portal-style; field-map + heuristic fallbacks retained | `04` back-link bullet |
| 5 | Serial registry = **`SVOSerVc`**; Sites = **`DelAddrVc`** (referenced by `SVOVc.DelAddrCode`) | `02`, `04`, `17` |
| 6 | **Legacy REST runs no window actions — ERP does not compute prices on POST**; baseline = app-filled base prices from `INVc`/`PLVc`; customer-specific pricing flagged as an open REST-tier limitation | `04` pricing boundary |
| 7 | `updates_after`/`deletes_after` = base registers only (`UUID`+`ServerSequence` present); `SVOVc`/`WSVc` lack them → windowed scans + `SerNr` key-sweep | `04` API family |
| 8 | WebExcellentAPI `document` PDF does **not** yet cover `SVOVc`/`WSVc` (ERP-side work in progress); app-generated report PDF is the Phase 1 default anyway | `04` findings |
| 9 | Booking activity types: per-purpose per-connection setting reconfirmed (already specced as the activity-purpose map) | — |
| 10 | `UserVc` confirmed as the technician person-code register | `04` table |

Remaining for the demo probe (also in `06` Phase 0): charge-type row fields on `WSVc` rows, `RLinkVc` REST readability, the no-`updates_after` assumption, service-contracts register code, `UserVc.Location` vs `ServLocation` convention, WebExcellentAPI presence, `ActVc` types per connection. Demo access arrives as env vars (host + company number + user/pw) in the session environment.

---

## 7. Round 7 — owner corrections, 2026-07-06 (acting on the round-6 register evidence)

*(Numbering note: there is no separate "Round 6" section heading. The round-6 pass was the register-evidence work folded into §6 above and applied here in §7; `09`/`10` refer to the crew-model revert as "round 6", which is recorded in this section.)*

Two corrections raised directly against the just-verified `WSVc`/`SVOVc` field structures (`17-erp-register-reference.md`), both owner-confirmed same day:

### 7.1 Crew model: reverted to one worksheet per technician (C10 is back)

`WSVc`'s header carries a single `EMCode` (technician) — there is no field structure for a multi-person Work Sheet. The round-4/§1.1 "one shared worksheet, lead + members" model (adopted from spec-line B, `10-spec-review-gaps.md` conflict #1) has no clean 1:1 push target for a crew job: it would need to either fan one worksheet out into N `WSVc` rows at push time (re-deriving per-person attribution from `addedBy` that the round-4 model was designed to avoid keeping elsewhere) or drop the crew members' individual authorship entirely.

**Decision: revert to spec-line A's original answer (C10) — one worksheet per technician.** A crew job now creates **N worksheets**, one per crew booking, sharing the booking's `crewGroupId`. This maps to the ERP with no translation layer: one worksheet's `userId` is one `WSVc.EMCode`, pushed independently, each on its own approval/status lifecycle. The one piece of the round-4 model worth keeping — a single customer signature per job, not one per technician — is preserved via a **lead-worksheet signature reference**: the lead's worksheet captures the signature, sibling worksheets in the `crewGroupId` point to it.

**Applied in:** `02-data-model.md` (Worksheet, Booking, Crew & reassignment sections — v0.8), `04-erp-sync.md` (assignee mapping, `ActVc` crew mapping), `05-users-auth.md` (per-job lead role description), `06-roadmap.md` (Phase 1/2 crew bullets), `07-ui-screens.md` (F4, F5, O3), `08-suite-integration.md` (integration diagram), `09-spec-review.md` and `10-spec-review-gaps.md` (historical annotations pointing here).

> **Correction (2026-07-07, round 5):** the `07-ui-screens.md` application above was incomplete — F5 and O3 were updated, but F4 still carried `addedBy` in the Parts row list and "per-member" in Time & km, both artifacts of the retired shared-worksheet model. `03-architecture.md` (conflict rules) and `15-testing-strategy.md` (crew suite, harness scenarios) carried the same remnants and were never in this list. All fixed in review round 5 (`20-spec-review-round-5.md`).

**Not affected:** the multi-person `ActVc` **scheduling** decision (§1.1 above, confirmed 2026-07-05) — a crew job is still one shared calendar activity for the whole crew; it's a separate layer from the execution documents underneath, and the adapter already treated "N crew bookings ↔ 1 activity" and "N worksheets" as independent mappings, so only the worksheet side changes.

### 7.2 ServiceOrder `Closed`: ERP-sync-set, not a manual/derived app transition

Prompted by inspecting `SVOVc`'s field list in `17-erp-register-reference.md` while resolving 7.1: no field named exactly `Closed` was among the mapped fields, but the order's terminal lifecycle (like `Invoiced`) should be an ERP fact, not something the app decides on its own — the app doesn't have visibility into everything that keeps an ERP-side order "live" (credit holds, pending documents, accounting period rules).

**Decision:** `Closed` is set by ERP sync-back, the same rule as `Invoiced`, never a manual app action and not app-derived from worksheet/order state. The exact source field is unresolved — `DoneMark`/`InvMark` are candidates but neither reads unambiguously as "closed" — so it's added to the Phase 0 demo-probe checklist (`18-demo-probe-handoff.md` #12) rather than guessed at.

**Applied in:** `02-data-model.md` (ServiceOrder status flow), `04-erp-sync.md` (new bullet next to the invoice back-link mechanics), `18-demo-probe-handoff.md` (checklist #12).

### 7.3 Walk-up jobs were claiming ERP/calendar visibility a full phase before the mechanism existed

Found by review: `02-data-model.md`'s walk-up work-entry mode claimed booking-less worksheets "reach the ERP/calendar via the worksheet's shadow activity… so dispatch still sees reality." Walk-up mode ships in Phase 1 (F7 "Start ad-hoc job" is phase-tagged 1 in `07-ui-screens.md`). But `worksheetShadow` — the *only* mechanism giving a booking-less worksheet any ERP/calendar footprint — was specced as Phase 2 only in `06-roadmap.md`. Net effect: for the entire Phase 1 window, a walk-up job would have been invisible to the ERP and to herbe.calendar, directly contradicting the data model's own claim.

**Decision: move `worksheetShadow` into Phase 1, minimal.** Rather than water down the data-model claim to "walk-up jobs are dark until Phase 2," the fix is to ship a fixed-behavior version of the mechanism itself: `worksheetShadow` created when work starts, with the workflow-stage mirror, and no per-connection configurability yet. **Phase 2 keeps** the one genuinely deferrable piece — the per-connection choice of creation timing (on worksheet creation vs. on work start) — plus the separate, more elaborate `workSegment` per-segment activity purpose, which was never required for basic dispatch visibility.

**Applied in:** `06-roadmap.md` (Phase 1 platform bullet, Phase 2 bullet split), `04-erp-sync.md` (activity-purpose map — `worksheetShadow` entry split into Phase 1 fixed behavior / Phase 2 enrichment), `02-data-model.md` (walk-up mode bullet — claim now accurate from Phase 1).
