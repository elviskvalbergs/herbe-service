# 27 — Phase 1 cross-workstream audit & fix backlog

Date: **2026-07-20**. Audited: WS1, WS2, WS4 (merged to preview), WS12 (unmerged branch).
Baseline verified green at audit time: `tsc` clean, **961/961** unit, **20/20** live vs the real ERP.
Method: four parallel read-only audits, each comparing spec (`docs/21` §4) ↔ claims (`docs/24`) ↔ code.

Verdict in one line: **each workstream is solid in isolation; the integration seams between them have two real bugs (both on the invoicing/worksheet money path) and several security gaps that are inert only until a login UI + email transport exist.** Fix the two 🔴s before anything user-facing builds on `approveWorksheet`.

---

## Fix backlog (ranked, assignable)

Each item: severity · where · what · why it matters · fix. IDs are stable — reference them in commits/PRs.

### 🔴 Critical — fix before dependent work

**FIX-1 (WS4) · worksheet regresses Synced→Draft every minute + description wiped.**
`lib/sync/ingest/worksheets.ts:182` applies flag-derived status unconditionally on update; `sync-tick` full-pulls WSVc every 60s; a freshly pushed WSVc reads back `OKFlag=0` → `deriveWorksheetStatusFromErp` defaults to `'Draft'`, so within ~60s of a successful push the worksheet regresses and its `workDescription` (never sent in the push) is blanked; `reconcileWorksheetRows` then reimports synthetic labor/distance rows as local part rows. This is the missing **echo-suppression** rule (`docs/04:195`). It sits inside the exact un-OK'd handoff M1 exists to prove; only the flattering `OKFlag=1` case is tested. **Fix:** mirror `service-orders.ts:190-193` — never downgrade below the local status for a record with a pending/completed outbound push; apply only `Invalid→Rejected` / `OKFlag→Synced` upgrades; don't overwrite `workDescription`/rows on self-pushed records. Remove the stale "no locally-advanced status to protect yet" comment (`worksheets.ts:22-25`). Add a live test that pushes then runs `syncConnection` and asserts the worksheet stays `Synced`.

**FIX-2 (WS2) · unauthenticated magic-link request auto-creates a user.**
`POST /api/auth/magic-link/request` mints a token for any `tenantId`+`email` with no invited/existing check; `authorizeMagicLink` (`lib/auth/magic-link-provider.ts:66-73`) auto-creates a `users` row (default role `technician`). Inert only because no mail transport is wired and tenant UUIDs are secret. **The day email sends, anyone with a tenant UUID self-provisions and reads tenant data.** Compounds with deferred seat enforcement (unbounded accounts). **Fix (before wiring any mail transport):** issue tokens only for pre-existing/invited users; drop auto-create on consume.

### 🟠 Important

**FIX-3 (WS4) · outbox push routes build the adapter without credentials.**
`app/api/sync/outbox/route.ts:83` + `.../[id]/retry/route.ts:~74` use `getAdapter(company.adapterType, company.adapterConfigJson)`; prod creds live encrypted in `apiCredsEncrypted`, `adapterConfigJson` has no `auth`, zod throws → 502. The client-facing push path is nonfunctional against a real connection (masked in tests by fake adapters; live proof bypassed the route). **Fix:** `buildAdapterForConnection(db, company.id)` in both; guard undefined company.

**FIX-4 (WS4) · conflict-inbox retry is a no-op and can't heal a dead lane.**
Retry enqueues a *new* group on `order:<id>`, but the FIFO gate is the oldest non-succeeded group (the original failed one) → nothing runs, groups stack, `outbox_ops` stays `failed` forever. Only recovery is `POST /api/admin/push-retry` with a raw stepId + ops secret (no UI). **Fix:** retry should re-drive/reset the existing dead group (or its steps), not stack a new one; clear the `outbox_ops` row on eventual success.

**FIX-5 (WS4) · order description echo-truncated to 60 chars.**
Push sends `CustComplaint1 = description.slice(0,60)` (`builders.ts:91`); SVOVc re-ingest overwrites local `description` with the 60-char echo (`service-orders.ts:163-185`). Descriptions >60 chars are lost locally. Same echo-suppression family as FIX-1. **Fix:** don't overwrite app-authored `description` from the echo on records with a pending/completed push (or store full text in a field the echo doesn't clobber).

**FIX-6 (WS2) · session revocation not enforced on `/api/sync/customers`.**
`route.ts:26` uses bare `auth()`; a signed-out-everywhere / `session_version`-bumped user keeps pulling the full tenant customer list until the JWT ages out (≤24h). Sole remaining bare-`auth()` route. **Fix:** `getVerifiedSession(db)`.

**FIX-7 (WS2) · no rate limiting on any auth endpoint.**
Login (argon2 → CPU-DoS lever), TOTP verify (6-digit), magic-link request (unauthenticated unbounded token-row inserts). Only `/api/ext` is throttled. **Fix:** reuse the ext token-bucket keyed on IP+tenant+email on the auth routes.

**FIX-8 (WS2) · device "remote wipe" is a `revokedAt` no-op.**
`devices/[id]/revoke/route.ts:26-30` stamps `revokedAt` only — no `session_version` bump, no purge; doc-21's wipe deliverable is effectively unbuilt; N-failed-PIN is a 24h lockout, not a wipe. **Fix:** bump session version on revoke (once device-bound sessions exist); document wipe-on-N as not-built.

**FIX-9 (WS1) · field-shell routes check session but not role.**
`app/(field)/*/page.tsx` redirect only when no session; a dispatcher can open `/today`. Harmless now (placeholders) but it's the seam WS9 fills with real technician data. **Fix:** add the office-shell-style role gate to the field layout before WS9 lands.

**FIX-10 (WS12) · "covered-units-of-a-lot" report loop missing, undisclosed.**
`lib/documents/context.ts:71,202` passes `row.coverage` as an opaque blob, never calling `resolveCoveredIds`/`coverageFraction` (WS7 shipped these). A spec-named Phase-1 deliverable (`docs/21` WS12 / `docs/12`) with no template dot-path and no mention in the deferred list — the branch's "Done" overstates by this much. **Fix:** materialize `coveredUnits[]` on `OrderReportServiceItem`, OR add it explicitly to the deferred list. Blocks WS12 merge.

**FIX-11 (WS12) · no recorded whole-branch verification.**
Unlike every prior slice, no `tsc`/coverage/test-count record in the trail. **Fix:** run `tsc --noEmit` + `vitest run --coverage` on the current branch tip and record it before merge.

### 🟡 Cross-cutting (fold into the owning session; several appeared in ≥2 audits)

**FIX-12 · `hasCapability` throws on an unknown role string** (`lib/auth/roles.ts:72-74`) — flagged by BOTH the WS1 and WS2 audits; now reachable on every office page load via `getVisibleNavSections`. `users.role` is a bare `text` column, no CHECK. **Fix:** return `false` for unknown roles + add a DB CHECK/enum before any user-management UI can write arbitrary strings.

**FIX-13 · `approveWorksheet` is not role-gated** (`lib/sync/push/enqueue.ts:49`) — checks transition + identity link, never `worksheet:approve`. No HTTP route yet, so unexploited — but whoever builds the O4 approval route (M1 slice) MUST add `hasCapability(role,'worksheet:approve')`. Also resolve the `team_lead`-approve-as-tenant-flag question (doc 21) — no override mechanism exists today.

**FIX-14 · admin role is not additive** (`lib/auth/roles.ts:61-69`) — an admin sees one office nav item, contradicting the org principle "admin = additive capability, not a separate surface" (see portal precedent / user memory). Product decision needed before WS10/WS9 make it visible. **Recommend:** make admin capabilities a superset.

**FIX-15 · shadcn `--primary` never bridged to the herbe palette** (`app/globals.css:58,93`) — still stock greyscale; the first real "Approve/Submit" CTA using `bg-primary` renders near-black, not forest green. **Fix:** map `--primary` → `--herbe-forest` before the M1 approval button ships.

**FIX-16 · PWA app icons are rounded** (`public/icons/icon-{192,512}.png`) — a Principle-6 identity violation the CSS grep-test structurally can't catch; the progress ledger wrongly claims "square." **Fix:** regenerate as plain squares; let the OS mask.

**FIX-17 · perf-budget + a11y CI wiring absent** (doc 21 §5/§7 asked for it) — no Lighthouse/axe step. WS9/WS10 inherit an empty safety net. **Fix:** wire budgets into CI (small) or explicitly defer in doc 24.

**FIX-18 · i18n content not extracted** (WS1) — plumbing works end-to-end but every new-component string is hardcoded English; 1 real key across 7 locales. **Fix:** as each UI workstream (WS9/WS10) builds real screens, route strings through the locale files from the first commit (§7 rule) — don't let the hardcoded-English debt compound.

### 💡 Minor (WS4 — confirm/park)
Labor `Quant` rounds up to the quarter hour (`builders.ts:242` — confirm business rule); a 429 dead-letters instead of retrying (`adapter.ts:49-51`); no explicit fetch timeout (`fetch-json.ts` — add AbortSignal); WSVc natural-key adoption swallows content silently (`engine.ts:303-320` — log it); non-serialized SVOVc double-create window on crash (`engine.ts:211-221` — marker lookup would close it); `sweepInvoiceStatus` no per-candidate isolation/bounds (`invoice-status.ts:61-77`).

### Ops (not code)
**Gotenberg is an external service** (WS12 converter). Production needs a hosted instance + `GOTENBERG_URL` per environment (ADR 0004 addendum leaves hosting open). Provision before documents go live in prod.

---

## Is M1 green?

**No.** The WS4 leg (approve → SVOVc+WSVc push + persistence verification → DoneMark/IVVc read-back) is proven at the library level on both fake and live ERP, and the two freeze gates (persistence verification, charge-type int/label) hold. But M1 per `docs/21` §5 also needs: **WS5-minimal booking** (not started), **WS9 F4 offline execution** (field tabs are placeholders), the **O4 approval UI** (`approveWorksheet` has no route/screen — called only from tests), WS8's media gate threaded into approval, and the `worksheetShadow` footprint. And FIX-1 sits inside the un-OK'd handoff the milestone exists to prove. Doc 24 correctly claims **WS4 done, not M1 done**.

---

## Updated sequencing (supersedes doc 24 §4 wave table)

### Wave A — NOW (fixes + close M1). Parallel-safe grouping:
- **A1 · WS4 loop fixes** (FIX-1, FIX-3, FIX-4, FIX-5) — one session, adapter/saga-exclusive. **Prereq for the M1 slice.** FIX-1 is the priority.
- **A2 · WS2 security hardening** (FIX-2, FIX-6, FIX-7, FIX-8, FIX-12) — one session, `lib/auth`-scoped. Independent of A1 → parallel.
- **A3 · WS12 finalize + merge** (FIX-10, FIX-11) — one session on the WS12 branch. Independent → parallel.
- **A4 · M1 vertical slice** — WS5-minimal booking + WS9-F4 execution screen + **O4 approval UI role-gated** (FIX-13) + `--primary` bridge (FIX-15) + field-route role gate (FIX-9). **Start after A1 lands** (it builds on the corrected `approveWorksheet` loop). This is THE M1 gate; when its loop is green on fake **and** live ERP, M1 is green.

Small polish (FIX-14 admin-additive decision, FIX-16 icons, FIX-17 CI budgets) — fold into A2/A4 or a quick housekeeping pass; none block.

### Wave B — after M1 green: M2 breadth, fully parallel
WS9 full (all F-screens) · WS5 full (crew, echo suppression, shadow purposes) · WS10 (dispatch board + web push producers + map) · WS11 (van stock + scanning + QR — freeze label scheme, replaces the `erp:` placeholder). WS12 already merged in Wave A.

### Wave C — M3: product wrap
WS6 (connection config UI, sync-health/DLQ browser — absorbs FIX-4's ops surface + transformations + settings import/export) · WS14 remainder (standalone wizard, whitelabel, seat licensing → resolves FIX-2's compounding risk, audit log, admin surfaces). Then M4 hardening/pilot.

**Critical path unchanged:** A1 → A4 (M1) → Wave B. A2/A3 ride alongside A1 without contention.
