# A4 — M1 vertical slice: implementation plan

Date: **2026-07-21**. Branch: `feature/service-phase1-m1-slice-a4` (off `origin/preview`, which contains A1's corrected loop + A3's documents).
Source: `docs/27-phase1-audit-and-fix-backlog.md` A4 bullet (line 88) + code-architect blueprint (2026-07-21).

## 0. What this slice is (and is not)

**M1 target** (`docs/21-phase-1-implementation-plan.md:165-166`, verbatim):
> Office plans a booking → technician executes one worksheet offline → manager approves (O4) → WS4 pushes SVOVc + WSVc → poll OKFlag + IVVc read-back sets Invoiced/Closed. Threads WS8 (charge type, media gate) + WS9 (F4 execution) + WS5 minimal (worksheetShadow footprint). **Do not fan out until this is green on the fake ERP and the live test ERP.**

**Key fact that shapes every task:** the WS8 domain layer is fully built and already proven end-to-end by `tests/live/erp-contract.test.ts` T7.3–T7.6 (which call the domain functions directly). **A4 puts UI + HTTP routes in front of functions that already work. No new DB schema or migration is created in this slice.** The five A4 pieces are: FIX-15 `--primary` bridge, FIX-9 field-route role gate, WS5-minimal booking, WS9-F4 minimal execution, O4 approval UI (FIX-13).

**Explicitly deferred (scope decisions — flagged in the PR, not silently dropped):**
- **`worksheetShadow` ActVc footprint → WS5-full (M2).** A4's own bullet (doc27:88) lists only the five pieces above; the ActVc write path does not exist and is M2 breadth. It is orthogonal to the push→invoice loop that M1 exists to de-risk.
- **`team_lead`-approve-as-tenant-flag → out of scope.** `worksheet:approve` stays dispatcher-only. No override mechanism is built.
- **WS8 media/checklist/signature gate → not applicable.** No `Media`/`ChecklistResult`/`Confirmation` tables exist yet; nothing to gate on for M1.
- **F4 tabs beyond Work → WS9-full (M2).** Only the Work tab (workDescription) + status stepper are built. A worksheet with zero part/time rows pushes successfully (`lib/sync/push/gather.ts:164-186`).

---

## Global Constraints (binding — reviewers use this as the attention lens)

1. **No new DB schema or migration.** Reuse the existing domain layer: `insertServiceOrder` (`lib/domain/stores/service-orders.ts:39`), `insertWorksheet` (`lib/domain/stores/worksheets.ts:39`), `setWorksheetStatus`, the transition machine in `lib/domain/worksheet-status.ts` (`assertWorksheetTransition`), and `approveWorksheet` (`lib/sync/push/enqueue.ts:50`).
2. **`approveWorksheet` (`lib/sync/push/enqueue.ts:50-119`) is UNTOUCHED.** It is the *only* code path that reaches worksheet status `Approved`. It commits the SVOVc/WSVc push group atomically; do not genericize it.
3. **Auth on every route/page:** `getVerifiedSession(db)` (`lib/auth/session-guard.ts:21`) → 401 (route) / redirect (page) when absent. Tenant-scope every query by `tenantId`. A foreign/absent resource returns 404 / `notFound()` (never 403 that leaks existence), matching `app/(office)/c/[companyId]/layout.tsx:64-76`.
4. **Role gates (exact capabilities — do not widen):**
   - O4 approve route: `hasCapability(role, 'worksheet:approve')` → 403. This line IS FIX-13. `worksheet:approve` is dispatcher-only (`lib/auth/roles.ts:51`).
   - F4 execution: `hasCapability(role, 'worksheet:execute_own')` (technician + team_lead, `roles.ts:38-40`), plus `worksheet.technicianUserId === session.user.id`.
   - Booking route: `hasCapability(role, 'order:view_all')` (the capability the orders stub already names).
   - Field pages: `FIELD_ROLES.includes(role)` else `redirect('/')`.
5. **Transition allow-lists (no route may reach a status it shouldn't):**
   - Booking creation → `Assigned` only.
   - F4 transition route accepts only `to ∈ {Accepted, In progress, Paused, Done}`.
   - Approve route → `approveWorksheet` only (the sole path to `Approved`). `Rejected`/`Synced` are out of scope for A4 routes.
6. **i18n (FIX-18): no hardcoded user-visible strings.** Every new label goes through the locale files `locales/{en,et,fi,lt,lv,no,sv}.json`. Server components call `getTranslations(namespace)`; client components receive strings as props (they cannot call `getTranslations`). Add the key to **all seven** locale files.
7. **Design system:** primary CTA renders forest green (Task 1 makes `bg-primary` = forest). Squares, not circles (no `border-radius: 50%`/`9999px` on identity/UI). Input fill `--herbe-bone`, focus lifts to `--herbe-paper`. Follow the WS1 shell components.
8. **`transitionWorksheet`** (new, `lib/domain/worksheet-transitions.ts`) does exactly: load current status → `assertWorksheetTransition(current, to)` → `setWorksheetStatus`. Nothing else. It is the shared helper for booking (`→Assigned`) and F4 (`→Accepted/In progress/Paused/Done`).
9. **TDD:** write the test with/before the implementation; one commit per green task; mirror the nearest existing test harness (cite it). No test that asserts nothing.
10. **Verification:** `npx tsc --noEmit` must stay clean; run the task's own new/affected tests and report command + output.

---

## 3. Task breakdown

### Task 1 — FIX-15: bridge `--primary` to herbe-forest

**Goal:** the first real Approve/Submit CTA renders forest green, not stock near-black, in both themes.

**File:** `app/globals.css` only. `--herbe-forest` is defined at `app/design-tokens.css:56` (`#134A40`) and imported before the `:root` block (`app/globals.css:2`), so `var(--herbe-forest)` resolves.

**Exact edits:**
- Line 58 (`:root`): `--primary: oklch(0.205 0 0);` → `--primary: var(--herbe-forest);`
- Line 93 (`[data-theme="dark"]`): `--primary: oklch(0.922 0 0);` → `--primary: var(--herbe-forest);`
- Line 94 (`[data-theme="dark"]`): `--primary-foreground: oklch(0.205 0 0);` → `--primary-foreground: oklch(0.985 0 0);` — required companion fix: near-black foreground on a dark-green button in dark mode would be illegible; near-white matches the light-mode pairing at line 59.

**Verify:** `npx tsc --noEmit` clean; `npm test -- app/design-tokens.test.ts` still green (it does not assert `--primary`'s literal value — confirm it still passes). No new test required (pure token change).

**Commit:** `fix(a4): FIX-15 bridge --primary to herbe-forest (doc 27)`

---

### Task 2 — FIX-9: field-route technician role gate

**Goal:** non-technician roles (e.g. a dispatcher) can no longer open field screens. This is the seam WS9 fills with real technician data.

**Design decision (deviates from FIX-13's literal "add to the field layout" — flagged in PR):** keep `app/(field)/layout.tsx` untouched (its hook-free synchronous design is deliberately documented at lines 3-11 and tested by direct call in `app/(field)/layout.test.tsx:30-51`). Add a one-line gate to each field page instead, using a shared constant so it cannot drift. This is the smaller, surgical diff and matches the per-page self-gating every field page already uses.

**Files:**
1. `lib/auth/roles.ts` — add `export const FIELD_ROLES: Role[] = ['technician', 'team_lead']` (co-located with `Role`/`Capability`; single home, no duplicate literal arrays). Reference for style: `OFFICE_ROLES` in `app/(office)/c/[companyId]/layout.tsx:43`.
2. In each existing field page — `app/(field)/today/page.tsx`, `app/(field)/jobs/page.tsx`, `app/(field)/scan/page.tsx`, `app/(field)/inbox/page.tsx`, `app/(field)/more/page.tsx` — immediately after the existing `if (!session) redirect('/login')` guard, add:
   ```ts
   if (!FIELD_ROLES.includes(session.user.role as Role)) redirect('/')
   ```
   (Import `FIELD_ROLES` and `Role` from `@/lib/auth/roles`.)

**Verify:** `npx tsc --noEmit` clean. Extend/add a page test asserting a non-field role is redirected — mirror `app/(field)/today/page.test.tsx` (it already mocks the session via `vi.mock('@/lib/auth', ...)`); add a case with `role: 'dispatcher'` expecting `redirect('/')`. Run the affected field page tests and report output.

**Commit:** `fix(a4): FIX-9 field-route technician role gate (doc 27)`

---

### Task 3 — Domain layer additions (readers, setters, transition helper) + unit tests

**Goal:** add the small set of pure domain functions the three UI routes need. No UI in this task. This unblocks Tasks 4–6.

**Files & signatures (all follow the existing tenant+`deletedAt` idioms in the same files):**
1. `lib/domain/worksheet-transitions.ts` (new): `export async function transitionWorksheet(db, tenantId: string, worksheetId: string, to: WorksheetStatus): Promise<void>` — load current status (via existing getter), `assertWorksheetTransition(current, to)` (from `lib/domain/worksheet-status.ts`), then `setWorksheetStatus(db, tenantId, worksheetId, to)`. Surface `DomainTransitionError` (do not swallow). Do NOT touch `approveWorksheet`.
2. `lib/domain/stores/worksheets.ts` — add three functions, mirroring existing readers (`getWorksheetsForOrder:74`) / setters (`setOrderNumber` idiom in service-orders.ts:158):
   - `getWorksheetsForTechnician(db, tenantId, technicianUserId): Promise<WorksheetRow[]>`
   - `updateWorksheetWorkDescription(db, tenantId, id, workDescription: string): Promise<void>` (thin setter, no validation)
   - `scanWorksheetsForCompanyByStatus(db, tenantId, erpCompanyId, status: WorksheetStatus): Promise<WorksheetRow[]>` (worksheets carry `erpCompanyId`, `drizzle/schema.ts:278` — no join)
3. `lib/domain/stores/customers.ts` — add `scanCustomersForCompany(db, tenantId, erpCompanyId): Promise<CustomerRow[]>` (mirror `scanServiceOrdersForTenant`, service-orders.ts:77).
4. `lib/domain/stores/identity-links.ts` — add `listLinkedTechnicians(db, tenantId, erpCompanyId): Promise<{ id: string; email: string }[]>` — inner join `users` (role ∈ `('technician','team_lead')`) × `identityLinks` (provider='erp', matching erpCompanyId). Only linked technicians are returned, so a booking can never dead-end at approval on a missing identity link (`lib/sync/push/enqueue.ts:69-74`).

**Tests (TDD):** DB-backed unit tests mirroring `tests/unit/domain/orders-worksheets-store.test.ts`'s harness. Cover: `transitionWorksheet` legal + illegal transition (illegal throws `DomainTransitionError`); each new reader returns tenant-scoped rows and excludes soft-deleted; `listLinkedTechnicians` excludes unlinked users and non-tech roles.

**Verify:** `npx tsc --noEmit` clean; the new unit tests green; report command + counts.

**Commit:** `feat(a4): domain readers + transitionWorksheet helper for M1 slice`

---

### Task 4 — WS5-minimal booking (order + assigned worksheet)

**Goal:** an office user creates a ServiceOrder + a technician-assigned Worksheet locally. No ActVc/calendar (deferred). Depends on Task 3's `scanCustomersForCompany` + `listLinkedTechnicians` + `transitionWorksheet`.

**Files:**
1. `app/api/service-orders/route.ts` (new) — `POST`, body `{ erpCompanyId, customerId, technicianUserId, description }`. `getVerifiedSession` → 401; `hasCapability(role, 'order:view_all')` → 403; tenant-scope `erpCompanyId` the way `app/(office)/c/[companyId]/layout.tsx:69-76` does (foreign → 404/notFound semantics for the page; for the route return 404). Then in one `db.transaction`: `insertServiceOrder` → `insertWorksheet({..., technicianUserId})` → `transitionWorksheet(..., 'Assigned')`. Return `{ orderId, worksheetId }`. Optionally set order status to `Planned` via `deriveOrderStatus` (`lib/domain/order-status.ts:22`) — cosmetic, include if cheap.
2. `app/(office)/c/[companyId]/orders/page.tsx` — replace the stub body: `getVerifiedSession` + `hasCapability(role,'order:view_all')` (the file's own comment names this), fetch `scanCustomersForCompany` + `listLinkedTechnicians`, render `<NewBookingForm>` with the options + i18n strings as props. `getTranslations('booking')` server-side.
3. `components/new-booking-form.tsx` (new, `'use client'`) — `<select>` customer, `<select>` technician, `<textarea>` description, submit button (`bg-primary` → forest). `fetch('/api/service-orders', {method:'POST', ...})` then `router.refresh()`. All labels come from props (no hardcoded strings).
4. i18n: add a `booking` namespace to all 7 locale files (customer / technician / description / submit / title labels).

**Tests:** route handler test (call exported `POST` with a constructed `Request` + mocked session via the `vi.mock('@/lib/auth', ...)` seam used in `app/(field)/today/page.test.tsx:15`) asserting the order + `Assigned` worksheet rows are created and technician-linked; a 403 case for a role lacking `order:view_all`. Page render test optional but preferred.

**Verify:** `npx tsc --noEmit` clean; new tests green; report output.

**Commit:** `feat(a4): WS5-minimal booking — office creates order + assigned worksheet`

---

### Task 5 — WS9-F4 minimal execution screen

**Goal:** a technician records work and walks the worksheet from `Assigned` to `Done`, offline-capable UI. Only the Work tab + status stepper. Depends on Task 3 (`getWorksheetsForTechnician`, `updateWorksheetWorkDescription`, `transitionWorksheet`) and Task 2 (`FIELD_ROLES`).

**Files:**
1. `app/(field)/jobs/page.tsx` — replace stub: existing session guard + Task 2 field-role gate → `getWorksheetsForTechnician(db, tenantId, session.user.id)` → list (status + order/customer summary), each linking to `/jobs/${worksheet.id}`. i18n.
2. `app/(field)/jobs/[id]/page.tsx` (new) — F4 minimal: `getVerifiedSession` + field-role gate; `notFound()` if the worksheet is absent, foreign-tenant, or `worksheet.technicianUserId !== session.user.id` or `!hasCapability(role,'worksheet:execute_own')`. Render current status, order/customer summary, a `workDescription` textarea, and status-stepper buttons whose visible targets are exactly `{Accepted (from Assigned), In progress (from Accepted/Paused), Paused (from In progress), Done (from In progress/Paused)}`. No Approved/Rejected/Synced buttons. i18n via props to a small client component.
3. `app/api/worksheets/[id]/transition/route.ts` (new) — `POST`, body `{ to, workDescription? }`. `getVerifiedSession` → 401; load worksheet by `id`+`tenantId` → 404 if absent/foreign; 403 unless `worksheet.technicianUserId === session.user.id && hasCapability(role,'worksheet:execute_own')`; 400 if `to ∉ {Accepted, In progress, Paused, Done}`; if `workDescription` present, `updateWorksheetWorkDescription` first; then `transitionWorksheet(...)` (let `DomainTransitionError` surface as 409).
4. i18n: `worksheet_execution` namespace, all 7 locales (status labels + Accept/Start/Pause/Mark-done buttons).

**Tests:** `app/(field)/jobs/page.test.tsx` + `app/(field)/jobs/[id]/page.test.tsx` (DB-backed, mirror `app/(field)/today/page.test.tsx`); transition-route test covering a legal progression, the `to`-not-in-allow-list 400, the not-your-worksheet 403, and the illegal-transition 409.

**Verify:** `npx tsc --noEmit` clean; new tests green; report output.

**Commit:** `feat(a4): WS9-F4 minimal worksheet execution (Work tab + status stepper)`

---

### Task 6 — O4 approval UI, role-gated (FIX-13)

**Goal:** a dispatcher sees `Done` worksheets and approves one, which triggers the WS4 push. Depends on Task 3 (`scanWorksheetsForCompanyByStatus`). Approve is the only new path that (via `approveWorksheet`) reaches `Approved`.

**Files:**
1. `app/(office)/c/[companyId]/worksheets/page.tsx` — replace stub: `getVerifiedSession` → `hasCapability(role,'worksheet:approve')` else `notFound()` (the file's own comment names this check); `scanWorksheetsForCompanyByStatus(db, tenantId, companyId, 'Done')`; render the list (order/customer/technician/workDescription) each with an "Approve" button (client component). i18n.
2. `app/api/worksheets/[id]/approve/route.ts` (new) — `POST`. `getVerifiedSession` → 401; load worksheet by `id`+`tenantId` → 404 if absent/foreign; **`hasCapability(role,'worksheet:approve')` → 403 (this line is FIX-13)**; call `approveWorksheet(db, { tenantId, erpCompanyId: worksheet.erpCompanyId, worksheetId: id })` (untouched); let `DomainTransitionError`/identity-link `Error` surface as 409/422 with their messages; on success run `buildAdapterForConnection` + `processPushQueue` inline (mirror `app/api/sync/outbox/[id]/retry/route.ts:43-128`) so Approve progresses immediately instead of waiting for the next push-tick cron, wrapped so a push failure does NOT roll back the committed approval (cron retries). Return `{ status, groupId, pushSummary }`.
3. i18n: `worksheet_approval` namespace, all 7 locales.

**Tests:** `app/(office)/c/[companyId]/worksheets/page.test.tsx` (DB-backed); approve-route test covering success (worksheet → Approved, group enqueued) and the **technician-role 403** (proves FIX-13 is wired at the route, distinct from `approveWorksheet`'s own identity guard).

**Verify:** `npx tsc --noEmit` clean; new tests green; report output.

**Commit:** `feat(a4): O4 approval UI role-gated on worksheet:approve (FIX-13)`

---

### Task 7 — M1 proof test (fake ERP) + live-ERP extension

**Goal:** prove the full loop **through the new routes** (not domain functions) — the layer this slice adds. The domain-level chain is already proven by `tests/live/erp-contract.test.ts` T7.3–T7.6; do not re-derive it.

**Files:**
1. `tests/integration/m1-vertical-slice.test.ts` (new) — fake-ERP end-to-end via the routes. Harness mirrors `lib/sync/push/engine.test.ts:1-31` (`startFakeErpServer` + `createStandardBooksAdapter`) and seeds tenant/company/customer/technician(+identityLink) as `lib/sync/push/enqueue.test.ts:30-59` does. Steps: `POST /api/service-orders` → assert order + `Assigned` worksheet; `POST /api/worksheets/[id]/transition` ×3 (`Accepted`, `In progress`, `Done` with a `workDescription`) as the technician session → assert progression + description persisted; `POST /api/worksheets/[id]/approve` as the dispatcher session → assert 200 + `groupId`; drive the push (inline in the approve route) → assert the fake ERP now holds an `SVOVc` and a `WSVc`, and the worksheet row is `Synced`. Negative cases: approve as `technician` → 403; transition another tech's worksheet → 403.
2. `tests/live/erp-contract.test.ts` — add `describe('T9 — M1 vertical slice via routes')` after the existing T8 block, reusing the suite's `beforeAll` `db`/`adapter`/`companyId`/`tenantId` and the `herbe-live-test` marker convention (lines 361-376). Same route-level flow, hitting the real ERP for the final SVOVc/WSVc read-back. Gated on `RUN_LIVE_ERP_TESTS` (`npm run test:live`).

**Verify:** `npm test -- tests/integration/m1-vertical-slice.test.ts` green (fake ERP). Live: run `npm run test:live` if ERP creds are present in `.env.test`; if not runnable in this environment, record that the fake-ERP proof is green and the live block is written and ready, and leave the live run as the single remaining M1 gate for the user to execute.

**Commit:** `test(a4): M1 vertical-slice proof through routes (fake ERP + live block)`

---

### Task 8 — Wrap-up: docs + flags

**Goal:** record M1 status truthfully and surface the scope decisions.

**Files:**
1. `docs/24-phase1-status-and-parallel-handoff.md` — update WS5/WS9/O4 rows to reflect the minimal slice shipped; state M1 status: **green on fake ERP via routes**; live-ERP either green (if run here) or "block written, one command from proof." List the three deferred scope items (worksheetShadow, team_lead flag, media gate) explicitly.
2. This plan file is already the durable record; no changelog entry (internal milestone, not a user-facing production release — `main` changelog rule doesn't apply to a preview feature branch).

**Verify:** full `npx tsc --noEmit` clean; full `npm test` (unit) green; report counts.

**Commit:** `docs(a4): record M1 slice status + deferred-scope flags (doc 27)`

---

## 4. References
- `docs/27-phase1-audit-and-fix-backlog.md` — A4 (line 88), "Is M1 green?" (76-79), FIX-9/13/15/18.
- `docs/21-phase-1-implementation-plan.md` — §5 M1 (165-166), WS5 (86-91), WS9 (114-119).
- `docs/07-ui-screens.md` — F4 (line 25), O4 (line 41).
- `lib/sync/push/enqueue.ts:50-119` — `approveWorksheet` (untouched).
- `tests/live/erp-contract.test.ts:377-758` — existing T7 domain-level live proof.
- `lib/sync/push/engine.test.ts` — fake-ERP push harness.
