# herbe.service — Spec Review (2026-07-04)

> **2026-07-05 note:** this document is a historical record of review round 1. Two of its resolutions were later superseded by the spec-line merge (`10-spec-review-gaps.md`): **C10** (second technician = own worksheet) is replaced by the team-job model — one worksheet per job with lead + members, multi-person `ActVc` as the primary mode (`02-data-model.md`, `04-erp-sync.md`); B3's UI answers are updated accordingly in `07-ui-screens.md`. The tenancy decision recorded below (B4) was resolved 2026-07-05 as a hybrid: multi-tenant core + dedicated deployments for whitelabel (`03-architecture.md`).
>
> **2026-07-06 note (round 6):** **C10 is back.** `WSVc` register verification (`17-erp-register-reference.md`) confirmed the ERP Work Sheet header carries a single `EMCode` (technician) — the 2026-07-05 "one worksheet per job, lead + members" merge has no clean 1:1 ERP push target, so it's reverted: one worksheet per technician again, crew jobs sharing a `crewGroupId` across worksheets instead of sharing one worksheet's membership. The multi-person `ActVc` scheduling decision is unaffected — it's a separate layer (one shared calendar entry, N worksheets underneath). See `16-spec-review-round-3.md` §7.

Scope: full consistency + completeness review of spec v0.1 (docs 01–06) against the five questions below, **with code-level review of the actual herbe-calendar and herbe-portal repositories** (mirrored to GitHub 2026-07-04; the design-system repo is still unavailable). Fixes marked ✅ were applied in this branch (spec v0.2); items marked ⚠ need a human decision and are also listed in `06-roadmap.md` Open items.

**Verdict up front:** the product shape (three-document spine, offline-first, ERP-owns-money) is sound and internally consistent after the fixes below. The two things that would have hurt most in development — a stack decision made on a wrong premise, and a customer portal planned in parallel to the existing portal product — are corrected. Remaining blockers to "start developing" are decisions, not unknowns: tenancy ADR, reuse mechanics agreement, design-system repo access, and register-code confirmation against a real tenant ERP. All are Phase 0 week-1/2 items.

## 1. Internal consistency (features work together, no clashes)

| ID | Sev | Finding | Resolution |
|---|---|---|---|
| C1 | Major | ER diagram required every Booking to have a Worksheet, while the Booking text allowed order-only bookings; worksheet-creation moment undefined. | ✅ `02`: Booking → ServiceOrder mandatory, Worksheet optional; worksheet auto-created on accept/start. |
| C2 | Major | Booking had no status model at all (the competitive analysis itself calls independent booking statuses a key D365/SFS lesson). | ✅ `02`: `planned → confirmed → cancelled` (+rescheduled as cancel-and-recreate), ~~aligned with calendar's booking vocabulary~~; execution progress stays on Worksheet. **Superseded in part (noted 2026-07-07):** the calendar-vocabulary cross-reference was wrong and was dropped from `02` in round 2 (`10-spec-review-gaps.md` W20); the status set itself stands. |
| C3 | Major | ServiceOrder status flow (`Planned…Confirmed`) had no defined relationship to worksheet statuses — who flips what was ambiguous. | ✅ `02`: explicit derivation rules. **Superseded twice (noted 2026-07-07):** the "only accept and close/cancel are manual" list is historical — round 4 made `Work done`/`Confirmed` manual decision states, round 7 made `Closed` ERP-sync-set, never manual (`16-spec-review-round-3.md` §5 #2a, §7.2). The derivation-rule principle stands. |
| C4 | Major | Signature "locks the worksheet" clashed with manager rejection and ERP validation bounce (both reopen it). | ✅ `02`: revision rule — signed revisions immutable, re-sign only if customer-visible content changes. |
| C5 | Major | Phase 1 includes technicians' booking calendar, but Phase 1 adapter scope omitted `ActVc` sync and the dispatch board is Phase 2 — nobody could create or sync bookings in Phase 1. | ✅ `06`: ActVc two-way added to adapter #1 scope; Phase 1 bookings created from order detail (O2); board stays Phase 2. |
| C6 | Major | WorksheetRow requires a stock location, but van stock is Phase 2 — Phase 1 location undefined. | ✅ `06`: main warehouse default in Phase 1. |
| C7 | Minor | Worksheet final status `Synced/Invoiced` conflated two concepts; invoicing is order-level. | ✅ `02`: worksheet ends at `Synced`; `Invoiced` lives on the order. |
| C8 | Minor | Roles doc defines 5 roles; Phase 1 lists 3, team lead/back office unassigned to any phase. | ✅ `06`: team lead + back office activate Phase 2. |
| C9 | Minor | Phase 1 "basic fixed checklists" vs Phase 2 builder — source of Phase 1 templates unstated. | ✅ `07` O9: seeded templates managed as data, builder UI Phase 2. |
| C10 | Minor | Multi-technician jobs unaddressed (one assignee per worksheet vs team work). | ✅ `02`: second tech = own worksheet under the same order. |
| C11 | Minor | Dual-ERP tenants ("both, rare, e.g. migration"): master-conflict rules between two ERPs undefined. | ✅ superseded by owner clarification: Standard ERP and Excellent Books are the same product — one adapter; the real model is N company connections per install, each a fully separate company scope (`02` Company scoping, `04` Principle). The "two ERPs at once" question doesn't exist. |

## 2. UI coverage (screens, roles, workflows, UX)

**v0.1 verdict: not covered.** No screen inventory, no navigation model, no admin surface, no workflow-to-screen mapping — the largest single gap for "start developing."

✅ Fixed by new `07-ui-screens.md`: two-shell navigation model, 11 field screens, 11 office screens, 8 admin screens (all phase- and role-tagged), 8 cross-role workflow contracts, field UX standards folding in the suite's design non-negotiables (from portal CLAUDE.md) and calendar's iOS input rule. Remaining for Phase 0/1 design: wireframes per screen; blocked on the design-system repo (B5 below) only for visual detail, not for starting flows.

## 3. Backend/ERP integration (cache refresh, sync, read/send transformation, multi-ERP)

**v0.1 verdict: strong on sync topology (delta pull, outbox, reconciliation), weak on operational detail — and unaware that a production adapter for these exact APIs already exists in the suite.**

| ID | Sev | Finding | Resolution |
|---|---|---|---|
| E1 | Blocker-class | Spec planned to design the ERP adapter from scratch; herbe-portal ships the `ErpAdapter` contract, capability model, register cache, sync runner, WebExcellentAPI client, credential encryption — production-tested, with future-ERP slots (Horizon/Jumis/Moneo) already stubbed, answering the "other ERPs might follow" requirement. | ✅ `03`+`04` rewritten around extending the portal framework; extraction plan in `08` §6. |
| E2 | Major | Spec assumed `updates_after` works everywhere; portal runs `supportsIncrementalSync: false` in production and full-scans; URL shapes differ per installation; server-side `filter[…]` is unreliable on some registers. | ✅ `04`: incremental reads are a probed per-connection capability; full-scan fallback with windowed ranges; ERP filters treated as optimization only. |
| E3 | Major | Cache-refresh semantics undefined (the "how is cache refreshed / data modified on read" question). | ✅ `04`: three-layer model; portal's trustworthy-vs-fresh split + sync-on-read adopted for the server-side ERP cache. |
| E4 | Major | Write mechanics/normalization undefined (form-encoded `set_field`/`set_row_field`, row-chunked text, control-char JSON, locale decimals, HSESSION, Basic-only/HTTP1.1-only HAL, OAuth refresh). All verified in sibling code. | ✅ `04`: "Write mechanics & normalization" section. |
| E5 | Major | Invoice↔worksheet back-link mechanics unspecified. | ✅ `04`: order reference field in the push, `IVVc` match on read-back, flagged heuristic fallback, `ARVc` for payment status. |
| E6 | Major | Pre-app ERP history import (a Phase 1 promise) had no mechanism. | ✅ `04`: initial-load paging through historical registers per serial, windowing rules; volumes to confirm Phase 0. |
| E7 | Minor | Sites absent from register mapping. | ✅ `04` table row (confirm-level). |
| E8 | Minor | Contacts modeled as fields on Customer; in both ERPs contacts are `CUVc` rows + `ContactRelVc` relations (portal-verified). | ✅ `02`: Contact first-class. |
| E9 | ⚠ Minor | Poll cadence 1–5 min × per-register × per-tenant needs a cost/duration sanity check on Vercel cron pricing/limits once tenant count is known; chunking pattern specified (`03`), sizing is Phase 0 spike output. | Open. |

## 4. Suite integration (calendar + portal, technical + workflow)

**v0.1 verdict: calendar integration existed only implicitly via ActVc; the portal wasn't mentioned at all, and Phase 3 planned a competing customer portal.**

| ID | Sev | Finding | Resolution |
|---|---|---|---|
| S1 | Blocker | Phase 3 "Customer portal" would duplicate herbe.portal (which already has auth incl. eIDs, invoices, payments, e-sign, notifications). | ✅ `06`+`08` §4: portal grows service modules (P1–P3) reading service's `/api/ext` API; invoices need zero new portal work. ⚠ Needs a slot on the portal roadmap + owner agreement. |
| S2 | Major | Calendar-side needs were unstated (user expectation: service fields in activity views, links to service). | ✅ `08` §3: C1–C4 backlog — service-activity recognition, order/site/status context + deep link in `ActivityDrawer`, guarded editing of locked/started activities, later availability feed. |
| S3 | Major | Booking conflict semantics between calendar/ERP edits and service execution undefined. | ✅ `08` §3: inbound moves accepted until worksheet `In progress`; later moves bounce to dispatcher inbox. |
| S4 | Major | Standalone (no-ERP) tenants had no calendar path at all. | ✅ `08` §3: explicitly out of v1; ICS-feed fallback identified if demand appears. |
| S5 | Major | Cross-app auth for service↔portal calls undefined; no suite SSO exists (v0.1 assumed silent SSO via shared Supabase — wrong on both counts). | ✅ `05`+`08`: scoped hashed bearer tokens (portal's proven pattern) for app-to-app; SSO reality check documented. ⚠ Suite SSO ADR before Phase 2. |
| S6 | Minor | No deep-link conventions between apps. | ✅ `08` §2: URL scheme + `hansa://` reuse. |

## 5. Code reuse (don't reinvent; consistent admin/settings/docs/templates)

**v0.1 verdict: intent stated, substance impossible before repo access — and the actual reuse surface turned out much larger than the spec guessed.**

✅ `08` §6 is the full inventory with coupling notes. Highlights: portal's ERP framework (E1), TemplateKey email engine + admin template editor (A5), signing subsystem for worksheet signoff, next-intl setup already covering all six required languages, migration runner, provisioning CLI, admin shell + register components, docs wiki + DocLink, cron conventions, credential envelope crypto. Calendar contributes the incremental-sync/`ActVc`-write mechanics, `person_codes` identity mapping, APNs + native iOS shell, availability logic.

⚠ **R1 (decision):** extraction (`@herbe/erp-core`, `@herbe/email-templates`) vs copy-first — recommendation in `08` §6: extract only those two now, copy-first the rest, never block Phase 0 more than two weeks on it. Suite already shows copy-divergence pain (two ERP clients, two crypto formats), and service would create the third copy.

## Blockers summary (all have a defined next step)

| ID | Blocker | Next step | Owner |
|---|---|---|---|
| B1 | ~~Stack premise wrong (Supabase)~~ | ✅ fixed — `03`/`05` now match the verified suite stack | — |
| B2 | ~~Portal duplication~~ | ✅ respec'd as portal modules; ⚠ agree with portal owner | product |
| B3 | ~~No UI spec~~ | ✅ `07` written; wireframes in Phase 0/1 design | design |
| B4 | ~~Tenancy ADR~~ | ✅ decided 2026-07-04: portal model on Supabase Postgres | — |
| B5 | Design-system repo unavailable | decided: mirror it (same as calendar/portal); pending computer access; interim: portal tokens + CLAUDE.md rules | Elvis |
| B6 | Register codes / field maps unconfirmed (service module, Sites, invoice back-link, `ActVc` types, WebExcellentAPI on launch tenant) | Phase 0 verification against the launch **Excellent Books** tenant | tech lead + ERP consultant |

## Decision log (2026-07-04, product owner)

1. **Tenancy**: portal model (deployment + DB per customer) — on **Supabase Postgres** instead of Neon. Consequence accepted: provisioning CLI adapted to the Supabase Management API; DB hosting diverges from siblings. Auth remains Auth.js, not Supabase Auth.
2. **Reuse**: extract `@herbe/erp-core` + `@herbe/email-templates`; copy-first the rest.
3. **Adapter order**: moot — owner clarified Standard ERP and Excellent Books are literally the same product: **one adapter**, portal-style multi-company connections (N per install, each its own customers/items/orders, users switch companies, no cross-company sharing). Launch tenants from the Excellent customer base.
4. **Design system**: mirror the repo when computer access allows; portal tokens as interim reference.
5. **Portal service modules**: confirmed — design spec delivered at `herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`.
6. **Suite SSO**: deferred; Entra ID added per tenant when needed.
7. **Dual-ERP**: question dissolved by the same-product clarification (see 3 and C11) — multiple connections are simply multiple companies.
8. **Pricing**: per-user initially ⇒ seat-based licensing control added as Phase 1 platform feature (`03`, `06`, `07` A2).

## What changed in the spec (v0.1 → v0.2)

- `02-data-model.md` — C1–C4, C7, C10, E8 fixes.
- `03-architecture.md` — B1 stack correction (Drizzle/Auth.js/Vercel Blob; **DB is Supabase Postgres per B4**, not Neon — the "no Supabase" wording here was the round-1 sibling-stack premise, corrected by the B4 tenancy ADR the same day), tenancy ADR, native-wrapper strategy, backend conventions from siblings.
- `04-erp-sync.md` — E1–E7 fixes: adapter-reuse section, capability-driven sync, cache/freshness model, write mechanics, invoice back-link, history import, Sites row.
- `05-users-auth.md` — Auth.js rewrite, provider strategy, identity-link references (`person_codes`/`identity_links`), session/device mechanics, SSO reality check.
- `06-roadmap.md` — Phase 0 rewritten (repo review done, reuse/tenancy decisions in), Phase 1 scope fixes (C5, C6, C8, notifications), Phase 3 portal redirection, updated open items.
- `07-ui-screens.md`, `08-suite-integration.md`, `09-spec-review.md` — new.
