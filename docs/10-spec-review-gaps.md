# herbe.service — Review Round 2 & Spec-Line Merge: Resolutions and Open Questions

Status: v2.0 (2026-07-05). Round 2 (2026-07-04) found the fork between the two spec lines plus 22 seam gaps and 12 phase gaps; on 2026-07-05 the product owner confirmed the audit line as legitimate ("multi-person ActVc, docs templates etc"), the lines were **merged**, and every resolvable finding was written into the spec. This document is the **single tracker**: what was resolved and where. **All open questions were answered by the owner on 2026-07-05 (§3)** — the spec has no open internal decisions left; remaining externals are listed at the end of §3.

---

## 1. Merge record (2026-07-05)

Line A (`service-spec-review` — decision log, portal handshake) + line B (`herbe-service-audit` — team jobs, item hierarchy, documents, change requests, design handoff) are now one tree:

- **Docs 01, 11–14** adopted from line B (verified competitive pricing; service-item hierarchy; document templates; suite change requests; design handoff) — renumbered, cross-references fixed.
- **Docs 02–08** hand-merged: line A's review fixes (booking statuses, order derivation, signature revision, Contact-as-CUVc, company scoping) + line B's additions (team jobs, DistanceEntry, field policies, tree model, adapter contract, transformations, ActVc mapping, platform blueprint).
- Adjudication rule where the lines contradicted: **explicit later decisions (line A's 2026-07-04 decision log) stand; line B's content wins everywhere else.** Every adjudication is listed below — the two where both lines claim an owner decision are open questions (Q1, Q3).

Conflicts adjudicated:

| # | Topic | Line A said | Line B said | Merged as |
|---|---|---|---|---|
| 1 | Crew model | One worksheet per technician (C10) | One worksheet per job, lead + members; multi-person `ActVc` primary | **Line B — owner-confirmed 2026-07-05.** `02`, `04`, `05`, `07` rewritten |
| 2 | Customer surface | Portal service modules (decided, spec delivered) | Own tokenized customer pages, portal feed "optional, later" | **Owner 2026-07-05: portal exclusively** — no customer-facing surface in service at all; tokenized-pages layer removed again (`08` §4, Q2 answer) |
| 3 | Tenancy | Deployment-per-customer (portal model) — "decided 2026-07-04" | Shared-schema `account_id` (calendar model) — also "decided 2026-07-04" | **Owner 2026-07-05: both** — multi-tenant core (`tenant_id` in schema) + dedicated deployments for whitelabel/overlay customers (`03`, Q1 answer) |
| 4 | Reuse mechanics | Extract `@herbe/erp-core` + `@herbe/email-templates`, copy-first rest (decision log) | No shared packages at all — copy the approach, separate codebases | **Decided 2026-07-05 (delegated)**: extract `@herbe/erp-core` only; email templates and everything else copy-first (`08` §6, Q3 answer) |
| 5 | Native wrapper | Calendar's Swift `WKWebView` shell pattern | Capacitor | Both listed as candidates, decided Phase 2/3 on real data (`03`). No action now |
| 6 | Worksheet final status | `Synced` (invoicing on order) | `Synced/Invoiced` | Line A (review fix C7) |
| 7 | Booking cardinality | Order mandatory, worksheet optional + statuses | Worksheet mandatory, no statuses | Line A (review fixes C1/C2), crew additions on top |
| 8 | Sync metadata | Single `erpRef` + `erp_company_id` | `erpRefs[]` per connection | Line A; B's adapter-agnostic `origin` phrasing kept |
| 9 | Repo access open item | "Pending mirror" | "Resolved via `BITBUCKET_APP_PASSWORD`" | Line B (resolved twice over); design-system **import** still open |
| 10 | Kanban / dispatch scope | (unaddressed) | Delegate pipeline view to calendar Kanban; board = time × tech only | Line B (`08` §3, `07` O5) |
| 11 | Smart Booking intake | (unaddressed; portal request form only) | Calendar Smart Booking as self-scheduling channel | Both — two intake channels (`08` §3, `06` P3) |

## 2. Round-2 findings — all resolved in the spec

Seam gaps (W) from review round 2, with the resolution's home:

| ID | Gap | Resolved in |
|---|---|---|
| W1 | Store topology (cache vs peer store) | **Owner-decided 2026-07-05**: portal cache/loader → ingest/mapper → domain tables → device deltas; push queue is the only ERP writer. `04` "Store topology" |
| W2 | ActVc echo suppression | `04` ActVc mapping (app-UUID tagging, `@sequence` comparison) + CAL-2 (`13`) |
| W3 | Inbound activity without an order | `04` ActVc mapping: intake types auto-convert; others → dispatcher unlinked-booking task; never silent order creation |
| W4 | Multi-person activities | Dissolved by the crew decision: N crew bookings ↔ 1 activity, split on window divergence (`04`) |
| W5 | Push ordering / partial failure | `04` push-queue saga: FIFO per order, dependencies, push groups, resume-from-failed-step |
| W6 | Duplicate-merge remap | `02` "Record merges": alias table, tombstone-redirect, op rewrite at ingest |
| W7 | Unlinked technician | `04`: booking write queues + warning; worksheet approval blocks |
| W8 | Contract entity undefined | `02` Contract stub; register row in `04` (confirm) |
| W9 | Quote flow missing service-side | `04` "Quote flow": draft → QTVc push → portal confirmation → read-back. Phase 3 (`06`) |
| W10 | `/api/ext` token/company scoping + admin UI | `08` §4 (token per company connection), `07` A4 |
| W11 | Portal confirmation had no model home | `02` `CustomerConfirmation` on Worksheet |
| W12 | Media storage contradiction | Fixed round 2 (Supabase Storage everywhere; `12` aligned in merge) |
| W13 | HistoryEvent production unowned | `02` projector rules; named Phase 1 platform item (`06`); rebuild in `07` A8 |
| W14 | Time zones | `02` Booking (UTC + tz), `04` adapter conversion, connection tz config |
| W15 | Device encryption asserted, undeliverable | `03` "Device data at rest" honest scope; Phase 0 ADR |
| W16 | Standalone→ERP transition | `04` standalone: company binding rule; wizard = Phase 2 (`06`) |
| W17 | No fleet-ops story | `03` "Fleet operations": customers.yaml + CLI + version train + super-admin |
| W18 | Reporting needs invoice rows | `04` back-link section: `IVVc` rows via portal mappers (Phase 3) |
| W19 | "On the way" ETA mechanism | `06` P3: "On my way" tap + static route estimate |
| W20 | Booking-status vocabulary claim wrong | `02`: false cross-reference dropped |
| W21 | Vercel cron limits vs 1–5 min polls | **Owner-decided 2026-07-05**: Vercel cron primary via a per-minute dispatcher route (`/api/cron/sync-tick` fans out by DB due-times); ops-runner + `CRON-HANDOFF.md` maintained as documented fallback (`03`) |
| W22 | Portal-side contract nits | `08` §4 "Portal-side implementation notes" (relay to portal owner) |

Phase gaps (P1–P12): all applied in `06-roadmap.md` v0.3 — `/api/ext` + tokens in Phase 2 (P1), quote flow Phase 3 (P2), standalone wizard Phase 2 (P3), HistoryEvent projector named P1 (P4), Contract stub P1 (P5), Web Push infra named P2 (P6), calendar C1–C3 commitment raised in `13` (P7), survey noted email-only (P8), PDF-engine ADR in Phase 0 (P9), audit log named P1 (P10), token store rides P1/P2 (P11), merge tooling + remap rule P1 (P12).

## 2b. Owner inputs 2026-07-05 (applied)

1. **Activity-purpose map**: every distinct ActVc use (bookings, intake, time-entry mirror, document vessel, history import) gets its own activity-type setting per connection — `04` adapter configuration model, `07` A4.
2. **Sync administration tools**: observe/act/audit surface specified — per-record sync inspector, force full sync, pause/resume, DLQ edit-and-retry, conflict queue — `04` "Error handling & sync administration", `07` O11.
3. **Cron**: Vercel cron primary for now (dispatcher-route pattern); external ops-runner docs maintained as fallback — `03` (supersedes the round-2 W21 resolution).
4. **Quote sending automation**: portal's send endpoint exists but is session-bound; new ask POR-6 (token-authenticated trigger) — `13`, wired into the `04` quote flow.

## 3. Open questions — ALL ANSWERED 2026-07-05

| Q | Question | Owner's answer | Applied in |
|---|---|---|---|
| Q1 | Tenancy | "Like in portal — SaaS multitenant is an option, as is customer-specific deployment when they need their design or overlay customisations." → **multi-tenant core** (`tenant_id` on every domain table, shared SaaS deployment default) **+ dedicated deployments** (whitelabel domain/theme/overlay hooks) provisioned per customer; same codebase, one version train | `03` tenancy + fleet ops, `02` company scoping, `05` multi-tenancy, `06` Phase 0 |
| Q2 | Customer surface | "Anything that requires customer input or is the customer's business is in portal. **No customer-facing stuff in service.**" → tokenized-pages layer removed; portal service modules are the entire customer window (equipment/QR target, requests, order status + ETA view, reports, signoff, feedback); non-portal tenants: emailed PDFs + on-site signature. Portal-team scope updated — design-spec **addendum delivered to the portal repo** | `08` §4, `02` CustomerConfirmation, `04` quote/standalone, `06` P3, `12` approval, `13` framing + POR-3/4, `14` §11, README, `01` d12 |
| Q3 | Shared packages | "No strong opinion — hassle, but possibly worth it for big overlap. You decide." → **extract `@herbe/erp-core` only** (the third-copy risk is real there); email-template engine and everything else copy-first; two-week timebox stands | `08` §6, `04`, `03`, `06` Phase 0 |
| Q4 | Phase 1 trim | Confirmed: whitelabel option + transformations UI/settings export stay Phase 2 | `06` (no change needed) |
| Q5 | Phase 1 estimate | Acknowledged: re-estimate at Phase 0 exit | `06` header note (no change needed) |

**Remaining external items (not spec decisions):**
- Register-code confirmation against the launch tenant — Phase 0 checklist in `06`.
- Design-system import into `herbe-design-system` — interim: portal tokens + `14-design-handoff.md`.
- Sibling-team asks — `13-suite-change-requests.md` (CAL-1/CAL-2 Phase 0 config agreements; calendar C1–C3 owner commitment; portal POR-1/POR-2/POR-6).
- Phase 1 re-estimate at Phase 0 exit (Q5).
