# herbe.service — Review Round 2 & Spec-Line Merge: Resolutions and Open Questions

Status: v2.0 (2026-07-05). Round 2 (2026-07-04) found the fork between the two spec lines plus 22 seam gaps and 12 phase gaps; on 2026-07-05 the product owner confirmed the audit line as legitimate ("multi-person ActVc, docs templates etc"), the lines were **merged**, and every resolvable finding was written into the spec. This document is now the **single tracker**: what was resolved and where, and the questions that still need the owner (§3 — answer these in chat by number, or edit this file).

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
| 2 | Customer surface | Portal service modules (decided, spec delivered) | Own tokenized customer pages, portal feed "optional, later" | **Synthesis**: portal modules primary (later decision stands) **+** line B's tokenized links for QR/ETA/report/feedback and non-portal tenants (`08` §4). Confirm: Q2 |
| 3 | Tenancy | Deployment-per-customer (portal model) — "decided 2026-07-04" | Shared-schema `account_id` (calendar model) — also "decided 2026-07-04" | **Line A kept (later that day)** — but two contradictory owner decisions exist. Confirm: Q1 (blocks the walking-skeleton schema) |
| 4 | Reuse mechanics | Extract `@herbe/erp-core` + `@herbe/email-templates`, copy-first rest (decision log) | No shared packages at all — copy the approach, separate codebases | **Line A kept**; B's counterview noted in `08` §6. Confirm: Q3 |
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
| W21 | Vercel cron can't drive 1–5 min polls | `03`: external ops-runner is the **primary** scheduler |
| W22 | Portal-side contract nits | `08` §4 "Portal-side implementation notes" (relay to portal owner) |

Phase gaps (P1–P12): all applied in `06-roadmap.md` v0.3 — `/api/ext` + tokens in Phase 2 (P1), quote flow Phase 3 (P2), standalone wizard Phase 2 (P3), HistoryEvent projector named P1 (P4), Contract stub P1 (P5), Web Push infra named P2 (P6), calendar C1–C3 commitment raised in `13` (P7), survey noted email-only (P8), PDF-engine ADR in Phase 0 (P9), audit log named P1 (P10), token store rides P1/P2 (P11), merge tooling + remap rule P1 (P12).

## 3. Open questions for the product owner

Answer by number (chat is fine). Everything else is decided or tracked externally.

**Q1 — Tenancy (blocks Phase 0 schema).** Two contradictory decisions both dated 2026-07-04: deployment-per-customer (portal model, currently in the spec) vs shared-schema `account_id` (calendar model, audit line). **Recommendation: deployment-per-customer** — service tenants carry heavy per-tenant ERP sync jobs and photo volume; isolation bounds cron durations and makes data isolation trivial; the provisioning CLI exists. Shared-schema is better only if you expect many small self-service tenants soon. Which stands?

**Q2 — Customer surface synthesis (confirm).** Merged as: portal service modules = primary customer surface (your 2026-07-04 decision, spec already delivered to the portal repo) **plus** the audit line's tokenized deep links (QR label, report approval, ETA, feedback — also the full surface for tenants without portal). Confirm this synthesis, or scale one side back.

**Q3 — Reuse mechanics (soft confirm).** Spec says: extract `@herbe/erp-core` + `@herbe/email-templates`, copy-first everything else, two-week timebox. The audit line argued for zero shared packages (copy the approach only). The timebox already limits the downside. Confirm extraction, or switch to copy-only?

**Q4 — Phase 1 scope (confirm the trim).** The merge grew Phase 1 (item tree, kilometers, team-ready model, projector, audit log — kept) but I moved two audit-line P1 items to Phase 2: **whitelabel deployment option** and **transformations UI + settings import/export** (Phase 1 ships basic connection config; maps live as reviewed config data). Reason: neither is needed for the single-pilot exit criterion. Agree, or pull either back into Phase 1?

**Q5 — Phase 1 estimate.** With the added P1 scope, does 10–14 weeks stand, or re-estimate at Phase 0 exit? (No action needed now — flagging that the number predates the merge.)

**External / tracked elsewhere (no answer needed here):**
- Register-code confirmation against the launch tenant — Phase 0 checklist in `06`.
- Design-system import into `herbe-design-system` (claude.ai/design project → repo) — interim: portal tokens + `14-design-handoff.md`.
- Sibling-team asks — `13-suite-change-requests.md` (CAL-1/CAL-2 are Phase 0 config agreements; the calendar C1–C3 work needs an owner commitment like the portal's).
- Portal-side implementation notes to relay — `08` §4.
