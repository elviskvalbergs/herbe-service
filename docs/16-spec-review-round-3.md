# herbe.service — Spec Review, Round 3: Fork Reconciliation, Integration Blind Spots, Plan Readiness

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

`Cancelled` is a manual order transition, but no rule said what happens to its live children. Added (`02` derivation rules): cancelling an order requires no worksheet beyond `Accepted` (else block with the list — cancel the work first, same pattern as field policies); open bookings auto-cancel (which triggers 2.2 on the ERP side); worksheets in `Draft/Assigned/Accepted` auto-cancel with a technician inbox notice. `Closed` additionally requires all worksheets terminal.

### 2.4 Unlinked inbound activities arrive in Phase 1, their screen was Phase 2 — FIXED

Inbound `ActVc` sync incl. the unlinked-booking rule is Phase 1 (`06`), but the only specified surface for unlinked activities was the dispatch board's unassigned pool (O5 — Phase 2). Fixed (`06`, `07`): Phase 1 surfaces unlinked inbound activities as a task list section on the **Sync health screen** (O11, which managers already read) with the same three actions (attach / create order / dismiss); the board pool takes over in Phase 2.

### 2.5 Inbound crew activity in Phase 1: who is the lead — FIXED

Phase 1 syncs multi-person activities but has no crew UX; a multi-person activity creates N bookings and one worksheet — the lead-selection rule existed only for app-created bookings. Added (`02` crew section): for inbound crew activities the lead defaults to the activity's **main person** (`MainPerson` — the field herbe.calendar already maps); if that person has no linked user, the first linked member becomes lead and sync health warns.

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
