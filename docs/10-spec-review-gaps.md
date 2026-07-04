# herbe.service — Spec Review Round 2: Integration Blind Spots & Phase Audit

Status: v1.0 (2026-07-04). Scope: what the spec does **not** say about how its specified parts work together, plus a feature-by-feature phase-assignment audit — the two questions that decide whether an implementation plan can be written from docs 01–09. Verified against the herbe-calendar and herbe-portal codebases (fresh code-level pass this session) and against the portal-side design spec (`herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md`).

**Verdict up front.** The spec is close: after v0.2 the individual subsystems are internally consistent and grounded in verified sibling code. What remains are (a) one process problem — the spec history is **forked**, and the abandoned fork contains real product decisions and whole feature designs that the current line contradicts or lacks; (b) a set of **seam gaps**: places where two specified mechanisms meet (offline sync × ERP cache, booking sync × calendar, approval push × ERP transactions, portal contract × worksheet model) and the joint behavior is undefined; (c) a handful of specified features with **no phase**. None of these needs new research — they need decisions and spec edits. With F1 and W1 resolved, an implementation plan for Phase 0–1 can be written immediately; Phases 2–3 additionally need P1/P2 settled.

---

## F1 — The specification is forked (resolve first)

Two spec lines diverged from the same base (`c800751`) and were never merged:

- **Line A (this branch, tip `8baccf3`, 2026-07-04)** — docs 01–09: the spec review v0.2, the 2026-07-04 decision log, the portal service-modules handshake. Treated here as the current spec.
- **Line B (`origin/claude/herbe-service-audit-y0zu1u`, tip `1554b0a`, 2026-07-03→04)** — a parallel, in places deeper elaboration: docs 07–11 covering suite integration, **service-item hierarchy (tree/lot/coverage model)**, **document generation (DOCX mail-merge + computed-field JS engine)**, **suite change requests (CAL-1…5, POR-1…5, SUITE-1…3)**, and a **design-system handoff brief**.

Line A is newer and carries the product-owner decision log, but it shows no awareness of line B's content. Three kinds of divergence, each needing a different action:

**F1.1 — Direct contradictions (owner decision required):**

| Topic | Line A (current) | Line B |
|---|---|---|
| Crew / team jobs | One assignee per worksheet; a second technician gets **their own worksheet** under the order (fix C10) | **One worksheet per job** with lead + members (`WorksheetMember`, per-member time/rows with `addedBy`), one booking per technician sharing a `crewGroupId`; commit message states multi-person `ActVc` is "the primary crew mode, not a config choice" — which reads like an owner statement |
| Customer surface | herbe.portal service modules; **no own customer pages** (decision B2/S1, design spec delivered to the portal repo) | "herbe.service is a standalone product — it ships … **its own customer pages**"; portal feed is POR-4, "optional, later, not needed" |
| ActVc payload richness | Booking ↔ activity with type/symbol per config | Activity additionally carries a **workflow stage** mirroring order/worksheet status (what herbe.calendar's Kanban drags), the ERP's native Service Order / Service Item fields, notes both ways |

The crew question is the serious one: it changes the data model (Worksheet, TimeEntry, Booking), the ActVc mapping (multi-person activities), the approval flow, and payroll export. Line A's per-tech-worksheet answer was chosen as a consistency fix without line B's context; line B's answer claims to *be* the requirement. Decide explicitly.

**F1.2 — Designs that exist only on line B (adopt-with-a-phase or consciously drop):** service-item hierarchy with `system`/`unit`/`lot` nodes and coverage records ("inspected 79 of 84 detectors" as one row) — nothing in line A handles large installed bases; DOCX document templates with selection rules, number series, immutable versions, and the sandboxed computed-field engine; `DistanceEntry` (kilometers, billable flag); per-tenant field policies; structure templates + spreadsheet import for mass item entry. These are not gold-plating: line A's flat ServiceItem list and single built-in PDF are known competitive weaknesses (its own doc 01 cites AllDevice's tree and compliance documents as table stakes for several target verticals).

**F1.3 — Line B material that fills line A gaps directly:** CAL-2 (echo-tagging convention for ActVc writers — see W2), the CAL/POR change-request framing with fallbacks per request, SUITE-2's note that **Bitbucket access works via `BITBUCKET_APP_PASSWORD` + REST API** (line A's open item 1 still says the design-system repo is unreachable pending mirroring — possibly stale), and doc 11's token-level design-handoff brief.

Recommended mechanics: treat line A as trunk, cherry-pick line B's docs 08/09/10/11 as docs 11–14 after the F1.1 decisions, and renumber/merge the two 07/08 pairs. Half a day of editorial work once the three decisions are made.

---

## W — Seam gaps: specified parts whose joint behavior is unspecified

### Sync machinery

**W1 (structural) — Two store topologies are specified at once; the merge between them is not.** Doc 04's three-layer model says layer 1 is "ERP → server cache (`cached_{register}` tables, portal pattern)" with the portal's trustworthy/fresh semantics. Doc 02's sync metadata says every **domain entity** (customers, orders, worksheets…) carries `erpRef`/`syncState`/`changeSeq`. These are different architectures: the portal serves *from* its cache (the cache is the read model); herbe.service's domain tables are a **peer store** that devices sync from. Unstated: do ERP polls write `cached_*` tables that a mapper then upserts into domain tables (two hops — then define the merge step, its conflict rule with app-side edits, and when `changeSeq` bumps), or do polls write domain tables directly (one hop — then the portal's cache/freshness vocabulary doesn't apply and "sync-on-read" needs redefining)? Every sync feature sits on this answer. Decide in Phase 0, write it into 04.

**W2 — ActVc echo suppression.** Service writes a booking to `ActVc`; the 1–5 min activity poll reads it back; herbe.calendar and ERP users write the same register. Without a self-echo rule the app re-imports its own writes (duplicate bookings, or state rolled back to the pre-move version while a newer local edit is in flight). Line B's CAL-2 already designs the fix (writer-tag convention + heuristic fallback); line A never mentions the problem. Also define: on read-back, match by `erpRef` first, and ignore inbound versions older than the last outbound write (`@sequence` comparison).

**W3 — Inbound mapped-type activity with no service order.** The model mandates Booking → ServiceOrder, but a dispatcher in the ERP or herbe.calendar can create an activity of the mapped type with no order behind it. Options: auto-create a stub order, an "unlinked bookings" inbox for the dispatcher, or ignore-with-warning. Pick one; also state which persons' activities import at all (only users with ERP identity links? what about activities on non-user persons?).

**W4 — Multi-person activities.** `ActVc` carries multiple persons (herbe.calendar creates one cached event per MainPerson + CCPerson). Line A: one booking = one technician. Inbound two-person activity → two bookings or reject? Outbound: two technicians on one job → one activity with two persons or two activities? This is the sync-level shadow of the F1.1 crew decision — answer them together.

**W5 — Outbound push ordering and partial failure.** Worksheet approval triggers several ERP writes (worksheet header+rows, stock transaction(s); Phase 3 adds quotes) against an API with no transactions. Unspecified: dependency order (customer → order → worksheet → stock txn — a worksheet push must queue behind its order's failed push, not run ahead of it), behavior when write 1 succeeds and write 2 fails (retry only the missing piece; never re-post the succeeded one — extend idempotency lookup to cover half-completed groups), and how `erpRefs` are repaired after manual DLQ retry. Specify a per-order saga/queue rule in 04's error-handling section.

**W6 — Duplicate-merge identity remap.** Field-created customer/site/item that back office merges into an existing record (O7): what happens to the provisional UUID living on the technician's offline device and on worksheets already referencing it? Needs: server-side alias table (old id → surviving id), tombstone-with-redirect in the delta feed, automatic FK re-point on ingest of queued ops that still reference the old id. Without this rule, merge corrupts offline replicas.

**W7 — Unlinked technician.** Bookings and approved worksheets sync with the technician's ERP person code; nothing says what happens when the assignee has **no identity link**. Rule needed (suggest: booking saves app-side and queues ActVc write with a sync-health warning; worksheet approval **blocks** with an actionable error, since a wrong/missing technician code on the ERP document is worse than a delay).

**W14 — Time zones.** ERP activities carry local date/times; herbe.calendar had to grow `booked_utc`/`host_timezone`/`booker_timezone` columns to survive this. The service spec is silent on booking timezone semantics while targeting EE/LV/LT/FI/NO tenants. Adopt the calendar's model: store UTC + explicit tz, convert at the adapter boundary.

**W21 — Vercel cron may not carry the polling load.** Doc 03 calls Vercel Cron "both siblings' proven convention" — but the portal's own `CRON-HANDOFF.md` says the opposite: *"we drive the real schedule externally"* via an ops-host runner, because Vercel cron has a 1-minute floor and one schedule per route (its `vercel.json` still carries 10 cron entries — a live contradiction inside the portal repo). Service needs 1–5 min per-register cadences per company connection — exactly the shape that pushed the portal to the external runner. Plan the `scripts/herbe-service-cron.sh` ops-runner as the **primary** scheduler from day one, Vercel cron as fallback; this also affects the E9 cost question.

### Data model seams

**W8 — Contract is referenced but never defined.** `ServiceOrder.relatedContract` and `ServiceItem.serviceContractLink` exist from Phase 1; there is no Contract entity anywhere: no fields, no master-data-ownership row, no register-mapping row (both ERPs have a service-contracts register — sync or app-own?). Minimum fix: define the entity stub now, mark the references nullable-until-Phase-3, add the register row as "confirm".

**W11 — Portal confirmation has no home in the worksheet model.** The frozen `/api/ext` contract includes `POST /worksheets/{id}/confirm` (`portal_confirm` | `esign` + signed file); the worksheet has no customer-confirmation field/state, no Media slot for the signed PDF, and "attach to the ERP activity" doesn't say which activity (the booking's? a new one?). Add: `customerConfirmation {method, signedBy, signedAt, mediaRef}` on Worksheet, surfaced in history and the report; define the ERP attachment target and its WebExcellentAPI gating.

**W13 — HistoryEvent production is unowned.** "Built server-side from synced facts" — no trigger, no job in the cron inventory, no rebuild/idempotency rule, despite "history is the product" and the portal modules reading it over `/api/ext`. Specify: projector runs on worksheet transition + ERP-poll ingest (not cron-only), events carry a deterministic key (source record + type) so rebuilds are idempotent, full rebuild is an admin action.

**W16 — Standalone → ERP transition is half-specified.** The initial-load wizard (04) matches records, but the company identity question is open: existing data carries the implicit local company's `erp_company_id` — is that company *bound* to the new connection (re-stamp nothing) or replaced (re-stamp everything, including devices' offline replicas — see W6)? Recommend: bind, one-way, irreversible per company. Also state plainly that standalone tenants get **no portal surface** (portal modules require an ERP-connected deployment) — implicit today.

**W20 (minor) — Booking status vocabulary claim is wrong.** Doc 02 says `planned → confirmed → cancelled` "matching herbe.calendar's booking status vocabulary"; the calendar's actual statuses are `pending → confirmed / cancelled / rescheduled / failed`. Either align or drop the claim — don't ship a false cross-reference.

### Cross-app contract seams

**W9 — The quote flow exists only on the portal side.** The portal design doc states "out-of-contract service quotes are **pushed by herbe.service into QTVc**" and builds its zero-work story on that. herbe.service has: no Quote entity, no QTVc row in the register mapping, no outbound quote flow in 04, no screen, no phase bullet. Also unspecified: what a quote is generated *from* (estimated worksheet? work template?), who prices it (ERP via `windowactions`/read-back, per the pricing boundary), and the acceptance round-trip (portal writes acceptance into QTVc via **its** adapter → service polls QTVc → then what: order auto-accepted? dispatcher notified?). One more portal-side reality check from code: the public quotation link's accept/reject **requires portal login + confirmed scope** (only viewing is anonymous) — fine, but the service spec shouldn't assume anonymous confirmation. This whole flow needs a section in 04 + 08 and a phase (with P2 below).

**W10 — `/api/ext` token scoping lacks the company dimension.** Doc 08 says tokens are scoped to "tenant + customer codes"; a deployment holds N company connections and the portal stores its config **per `erp_company_id`**. State it: one token per (deployment, company connection), all `/api/ext` data scoped to that company, customer-code scope intersected with the caller's `customerCodes` parameter. And the admin surface for minting/revoking these tokens is missing from doc 07 — the Admin role text promises "API keys" but no A-screen has them (add to A4 or a new A9).

**W12 — Media storage is specified twice, differently.** Doc 03's stack decision: "**Supabase Storage** for media originals (same per-customer Supabase project as the DB)". Doc 03's backend section: "Files: **Vercel Blob** for originals". Same document, same day, direct contradiction — the stack-decision paragraph is the decided one; the Blob line is a stale leftover. (Fixed in this branch alongside the stale "No Supabase anywhere" bullet — see "Fixes applied".)

**W22 — Portal-side contract nits (relay to the portal doc owner).** From the code pass: (a) `getUserScopeForCompany` is deliberately module-local in `app/c/[companyId]/invoices/_lib/scope.ts`, not a `lib/` helper — the service modules need it extracted first; (b) `SigningModuleDescriptor` also requires `pdfFilename` and `activitySubject`, and `onAllSigned(adapter, …)` receives the ERP adapter (built for ERP writes) — the service descriptor must ignore it and POST to service instead; workable, unstated; (c) SMS/in-app template channels are stubs — "notifications" means email-only until further notice (affects the Phase 3 survey and "on the way" promises); (d) Entra ID login exists in **neither** sibling — doc 05 already says this correctly; keep treating it as net-new work.

**W17 — No fleet/ops control plane story.** Deployment-per-customer × per-user licensing implies vendor-side operations the spec never describes: where the deployment inventory lives (portal: `customers.yaml` + provisioning CLI — adopt as-is?), how a version rolls out across N deployments with N database migrations (portal: version train, build-time migration runner — adopt, but say so), who the "super-admin" adjusting seat counts is and where that plane lives (an env/config per deployment? a vendor dashboard?), and per-deployment monitoring (Sentry project per customer or shared DSN with tags). Without this, Phase 1's licensing bullet and every "per-tenant config" sentence have no operational home. One page in 03 settles it.

### Client seams

**W15 — Device-at-rest encryption is asserted, not designed.** "GDPR: … encrypted at rest (device DB)" — a PWA cannot keep a key the device can't reach; IndexedDB has no OS-level encryption story beyond platform disk encryption. Be honest in the spec: baseline = platform disk encryption + offline PIN/biometric app-lock + minimization (briefcase horizon N days, access-instructions visibility already role-scoped) + remote wipe on contact; app-layer crypto (wrapped key unlocked by the PIN) as a hardening option; tenants that demand more get the native wrapper (Keychain/Keystore). Make this the Phase 0 local-DB ADR's explicit scope.

**W18 — Reporting's data appetite exceeds the invoice back-link.** Phase 3 "revenue per technician (ERP-priced)" needs invoice amounts/lines, but 04 specifies number/status read-back only. Cheapest fix: read `IVVc` rows (the portal's invoice mappers already parse them — reuse), or compute from the ERP-computed worksheet read-back at approval. Say which.

**W19 — "Technician on the way" has no mechanism.** Phase 3 promises ETA notifications; positions are Phase 2-coarse and live tracking is Phase 4. Suggest: explicit "On my way" tap on F3 (sets TimeEntry travel start) + static route estimate from site geo → notification. One sentence in 07/08 fixes it; without it the Phase 3 bullet isn't implementable.

---

## P — Phase-assignment audit

Method: every capability named anywhere in docs 02–08 was checked for a phase home in 06/07. Confirmed clean: bookings-in-P1 (C5), stock location default (C6), roles activation (C8), checklist seeding (C9), seat licensing (P1), sync health (P1), payroll export (P2), native wrapper (P3), i18n + docs wiki (cross-cutting). Gaps:

| ID | Capability | Where specified | Phase today | Fix |
|---|---|---|---|---|
| P1 | `/api/ext/v1` API + hashed scoped tokens + admin minting UI | 08 §4, portal doc ("contract **frozen from Phase 2**") | none — absent from every phase bullet list | Add to **Phase 2** platform scope (portal's Phase-3 build consumes it; freezing a contract that no phase builds is how integration deadlines die) |
| P2 | Quote flow: quote generation → QTVc push → acceptance read-back (W9) | portal doc only | none | Spec section first (W9), then **Phase 3** alongside contracts + portal modules |
| P3 | Standalone→ERP initial-load wizard | 04 "Standalone mode" | none | Assign (suggest Phase 2, or "first ERP-enabling customer"); Phase 1 needs only the refusal path ("connection can be added later") |
| P4 | HistoryEvent projector job (W13) | 02 | implied by P1 "history" | Name it in Phase 1 platform bullets + cron/job inventory |
| P5 | Contract entity stub (W8) | 02 references | Phase 3 feature, Phase 1 fields | State: Phase 1 ships nullable references + entity stub; full entity + sync Phase 3 |
| P6 | Web Push infrastructure (VAPID keys, subscription store, fan-out worker) | 03 client, 06 P2 bullet | implied | Name as a Phase 2 platform item — it's a subsystem, not a UI feature |
| P7 | herbe-calendar work items C1–C3 (service-activity recognition, context, guarded editing) | 08 §3 "phased with service Phase 2–3" | no repo commitment | Mirror the portal move: deliver a calendar-side design doc + agreed roadmap slot, or explicitly mark C1–C3 "unscheduled — tier-0 ActVc interop only" so Phase 2 planning doesn't assume them |
| P8 | Satisfaction survey (entity, 1-tap token link, storage) | 06 P3 bullet | Phase 3 | Add the entity to 02 when Phase 3 is spec'd; note email-only channel reality (W22c) |
| P9 | Worksheet PDF **engine** (and line B's DOCX templating, if adopted per F1.2) | 06 P1 bullet / line B doc 09 | P1 bullet without a mechanism | Phase 0/1 ADR: server-side PDF approach (the portal only streams ERP PDFs — no reusable generator exists in the suite); if F1.2 adopts DOCX templates, they land Phase 2/3 sharing the same merge context |
| P10 | Audit log (A7) + append-only audit tables | 03, 07 | "admin screens all Phase 1" | Name in Phase 1 platform bullets (it's schema + write-path work, not just a screen) |
| P11 | ERP api-token/`analytics_tokens`-pattern **service-side token store** | 08 §6 reuse table | — | Rides with P1 |
| P12 | Merge-duplicates tooling (O7) + remap rule (W6) | 07 O7 | O7 is P1 | Keep P1, but the W6 remap rule must be in the sync design from Phase 0 (it constrains op-log format) |

Also stale in 06: Open item 1 says repo access is "pending owner's computer access" — line B records that Bitbucket REST access works via `BITBUCKET_APP_PASSWORD` (SUITE-2 "resolved"); verify and update, since the design-system repo (`herbe-design-system` mirror is still an empty repo as of this session) is the last blocked input for visual design.

---

## What must happen before an implementation plan (ordered)

1. **F1.1 decisions** (owner): crew model, customer-surface stance (reaffirm line A's portal decision or revise), ActVc payload richness. Then the F1 merge (editorial, ~½ day).
2. **W1 store-topology decision** (tech lead): cache-then-merge vs direct-to-domain. This gates the Phase 0 walking skeleton's schema.
3. **Spec edits batch** — W2–W11, W13–W16, W18–W19 are each a paragraph in an existing doc; P1–P12 are roadmap-table edits. No new research needed; roughly a day of writing.
4. Existing open items unchanged: register-code confirmation against the launch tenant (Phase 0, unavoidable), design-system repo mirror (blocks visual design only).

After steps 1–3 the spec supports a straight Phase 0 + Phase 1 implementation plan (workstreams: platform/provisioning, sync engine, adapter, field PWA, office shell — the dependency spine being W1 → adapter → walking skeleton). Phases 2–3 plan cleanly once P1/P2/P7 are settled.
