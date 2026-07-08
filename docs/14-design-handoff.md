# herbe.service — Design-System Handoff: What's Missing to Build This App

Status: v0.5 (2026-07-08). The brief for whoever does the herbe design-system work: what the current design system does **not** cover and herbe.service cannot ship without. The `herbe-design-system` repo is the working surface and `herbe-design-system/handovers/SERVICE.md` the designer-facing entry point derived from this brief; the design-system import has landed (`tokens.css`, `shared.css`, pattern cards, per-app handovers), so §1 asks already satisfied by `tokens.css` are dropped with pointers. Every section is derived from the current `02-data-model.md` and `07-ui-screens.md`. Worksheet is one-per-technician (no per-row `addedBy`); crew-job grouping is Phase 1; the A4 activity-purpose map lists the seven purposes in `04-erp-sync.md`; CustomerFeedback rendering is portal-side, not in this app's screen count.

## Starting point (sibling apps verified from source 2026-07-04; re-verified against the `herbe-design-system` repo 2026-07-07)

- The **`herbe-design-system` repo is populated and canonical** (v2.0): `tokens.css` (the published token vocabulary — `--burti-*` palette → `--herbe-*` semantic aliases → `--bg`/`--fg`/`--status-*` roles, dense/comfy density-tier presets, a dark-surface override), `shared.css` as the reference component implementation, the principles card, 8 pattern cards + foundation cards under `preview/`, and per-app handover docs under `handovers/` (incl. `SERVICE.md`, the designer entry point for this brief). There is still no shared *code* component library — each app implements the system in its own stack: herbe.portal with shadcn/ui + Radix + Tailwind v4, herbe.calendar with hand-rolled CSS custom properties (`app/design.css`).
- The two apps' token implementations, read from source (both predate the repo and will converge on `tokens.css` per their handover docs):
  - **herbe.portal** `app/globals.css`: Tailwind v4 `@theme` block titled "BURTI — design tokens, sourced from `burti-id-brandbook-1909.pdf` (Sept 2022)". Self-hosted **Poppins** as `--font-sans`; named brand palette `--color-burti-*` (black `#231F20`, white, rowanberry `#CD4C38`, high-sky `#00AEE7`, forest `#134A40`, mud `#212722`, …). Per-deployment theming: `--brand-*` aliases (e.g. `--brand-accent`, `--brand-danger`) overridden via `<style>` injection at the page root (`lib/theming`); rule in source: "Do not inline hex values in components."
  - **herbe.calendar** `app/design.css`: a **semantic token layer** on top of the Burti palette — `--app-bg/-alt/-soft/-hover/-elev`, `--app-line`, `--app-fg/-muted/-subtle/-faint`, `--app-accent`, `--app-cool/-warn/-danger/-success`, shadows, selection — with **dark as the default theme** and a `[data-theme="light"]` override.
- herbe.service builds on **shadcn/ui + Radix + Tailwind** (portal's approach — decision in `03-architecture.md`) and should adopt the calendar's *idea* of a semantic layer over the brand palette: components consume semantic tokens, tenants override brand aliases.
- The existing system (`herbe-design-system` v2.0: principles + 8 pattern cards + foundation cards) is designed for **office web apps**: desktop-first data views, forms, dialogs, settings. That covers herbe.service's back-office surfaces (dispatch, approval, admin) reasonably well, and several existing pattern cards are directly reusable — `pattern-detail-view.html` for order/service-item detail, `pattern-data-table.html` for register lists, `pattern-workflow-modules.html` for status banners and danger zones, `pattern-dropdowns-and-selectors.html` for status/category pickers, `pattern-chips-and-avatars.html` for badges and identity chips.
- What it has never had to cover is a **field tool**: offline, one-handed, gloves, sunlight, time pressure. That's the gap this document specifies — plus, new since v0.1, a set of **approval/administration surfaces of a complexity neither sibling app has** (media-completeness gating, revision diffing, dead-letter queue triage, licensing).

Design constraints that override everything, including tenant branding (`03-architecture.md` theming — "field-UI accessibility rules override brand colors where they conflict"; restated in `herbe-design-system/handovers/SERVICE.md`): glove-usable target sizes, sunlight-readable contrast, one-hand reach, zero network dependence on any technician screen.

## 1. Token-level gaps

| Gap | What's needed |
|---|---|
| **Field-mode sizing scale** | Touch targets ≥ 48 px (primary actions 56–64 px), enlarged type scale for arm's-length reading, spacing that tolerates imprecise taps. Defined as a token mode (e.g. `density: field` vs `density: office`), not a separate system — same semantics, bigger values. |
| **Sunlight / high-contrast mode** | A high-contrast variant of the palette (critical text/controls ≥ 7:1) switchable by the technician (or auto via ambient light where available). Dark mode too — vans at 06:00 in a Nordic winter (`tokens.css` ships a dark-surface override block to build the field dark scheme on; the high-contrast scheme has no base yet). |
| **Sync-state colors + iconography** | Canonical tokens for `local / pending / synced / conflict` (`02-data-model.md` "Sync metadata"). These appear on every record chip and list row in the field UI; they must be one vocabulary app-wide, colorblind-safe, and never color-only (icon + color). |
| **Charge-type badge** | `invoiceable / warranty / contract / goodwill` — a four-value categorical badge on worksheet rows, order defaults, and printed reports ("warranty — no charge"). New since v0.1 (`02-data-model.md` "Charge type"). |
| **Work-entry-mode indicator** | Small iconography distinguishing booking-first / prepared-ahead / walk-up jobs on the job card (`02-data-model.md` "Work-entry modes") — a booking-less worksheet needs to silently read as normal, not broken. |
| **Signature revision-state badge** | `signed / superseded-by-correction / re-sign-requested / proceed-on-existing (audited)` — no vocabulary exists yet (`02-data-model.md` "Signature lock vs. rejection/correction"). |
| **Print/PDF tokens** | Header/footer, table, and severity styling for generated documents (`12-documents-templates.md`): the built-in worksheet report renders from theme tokens with no DOCX template. Verified 2026-07-07: no `@media print` styling exists anywhere in the design-system repo. |

**Already covered by the design system (dropped from the ask list, v0.4)** — three v0.3 asks turned out to be satisfied by the imported repo; herbe.service consumes these rather than commissioning them:

- **Published token vocabulary**: `tokens.css` is the unified vocabulary the v0.3 ask wanted built (`--burti-*` → `--herbe-*` → semantic roles + density presets; `13-suite-change-requests.md` SUITE-3). What survives of the old ask is only the **precedence rule** — accessibility tokens beat brand tokens on field surfaces — already stated in `handovers/SERVICE.md` and `03-architecture.md`.
- **Severity / pass-fail tokens**: `tokens.css` defines `--status-success/-warning/-danger/-info/-neutral` (each with `-soft`/`-fg` variants); checklist pass/fail and document severity boxes map onto these. The *print* rendering of them is still the Print/PDF row above.
- **Status colors for the three state machines**: the badge language exists (`--status-*` + `preview/audit-status-badges.html` + `pattern-chips-and-avatars.html`); what remains is the *mapping*, not new tokens — ServiceOrder (9 states incl. `Cancelled`), Worksheet (9 states incl. `Rejected`), Booking (`planned / confirmed / cancelled` — `rescheduled` is recorded as cancel-and-recreate, and `enRoute` is a flag on the booking, not a state; both per `02-data-model.md`). The manual-vs-derived distinction (`Work done`, `Confirmed`) stays a real gap — see the pattern in §3.

## 2. Component-level gaps

Priority: **P0** = walking skeleton (Phase 0), **P1** = MVP (Phase 1), **P2** = Phase 2, **P3** = Phase 3.

### Offline & sync (nothing like this exists in the suite)

- **P0 — Global sync indicator**: online/offline/syncing/error, always visible, non-blocking; tap → sync detail.
- **P0 — Record sync badge**: the four sync states on any list row/card.
- **P1 — Outbox & conflict inbox**: list items for pending ops and bounced transitions (`03-architecture.md` conflicts), with per-item retry/resolve affordances.
- **P1 — "Download my work" (briefcase)**: scope summary (N orders, M photos, X MB), progress, partial-failure state, stale-data banner ("last synced 2 days ago").

### Technician field surfaces

- **P0 — Job card + my-jobs list**: booking/worksheet card with status, time window, customer, site, one-tap call/navigate, work-entry-mode indicator (a booking-less card has no time slot and must still read as intentional, not broken); the single most-used component in the product.
- **P1 — Day/week technician calendar** (own bookings; renders Bookings, `02-data-model.md`).
- **P1 — Worksheet execution screen family**: big-target quantity stepper, part row with stock-location badge (a worksheet has exactly one technician — round 6 correction, `02-data-model.md` — so no per-row authorship chip is needed), per-row **charge-type selector** (4 values, field-policy gated), per-row **service-item attribution picker** (when a worksheet spans multiple nodes), start/stop **timer control** (work/travel/waiting, with a **return-travel variant that stays live after the worksheet is `Done`** — a timer that must remain tappable in an otherwise "closed" document, no existing pattern for this), pause-with-reason picker, status-transition button with blocking-requirements list (field policies: "missing: km, remedy code").
- **P1 — Crew-job grouping** (P1 confirmed by owner 2026-07-07): on a multi-technician job, each technician has their own worksheet sharing a `crewGroupId` — approval queues and job cards need a "grouped by job" treatment (N worksheets, one visual cluster) rather than a single shared document with per-row attribution. The richer crew UX (dispatch-board crew group chip, detach-member) ships in Phase 1 with the board itself.
- **P1 — Checklist runner**: the five field types (bool, number with min/max + pass/fail rendering, text, photo-required, selection), section progress, required-on-complete errors (`02-data-model.md` ChecklistTemplate).
- **P1 — Signature capture**: full-screen canvas, name field, legal text slot, content-lock confirmation, plus a **re-entry state** for "signature requested again" after a correction (see revision-chain pattern, §3).
- **P1 — Camera/media flow**: capture with before/after tagging, thumbnail strip, upload-state per photo (offline-queued).
- **P1 — Distance entry**: two mutually-exclusive sub-inputs collapsing to one derived value — direct km, or odometer before/after with computed result — plus billable toggle (`02-data-model.md` DistanceEntry).
- **P1 — Ad-hoc job start**: a primary CTA from the customer/site card that creates order + worksheet in one action with no booking (`02-data-model.md` "walk-up" work-entry mode) — new since v0.1.
- **P1 — Scan overlay**: barcode/QR viewfinder with success/failure states (parts + service item labels).
- **P1 — Alternatives suggestion row**: out-of-stock part → in-stock substitutes ranked van → warehouse → preference (`11-service-items-and-parts.md`).

### Item hierarchy (Phase 1, `11-service-items-and-parts.md`)

- **P1 — Tree browser** with rollup badges + **flat filtered list** sharing one filter state; path breadcrumb ("Store 14 / Fire safety / …").
- **P1 — Coverage picker**: "all / n of m / exceptions" entry on group rows, **plus a paired display mode** for the same coverage record read back on a manager report — entry (technician, gloves) and display (manager, report) are different UX problems on the same data; no FSM product has a good one, this needs real design work on both sides.
- **P1 — Bulk-operations bar**: filter → multi-select → action (move, assign contract, print labels, create group order); **spreadsheet import dry-run diff view** — worth designing as a reusable pattern, since item-hierarchy bulk-entry and future contract/PM data entry both need it, not a one-off.

### Order & worksheet approval (the single largest gap — one line in v0.1, several distinct components)

This is now the most complex screen family in the product (`07-ui-screens.md` O2/O3/O4) and needs to be scoped as such, not folded into a generic "approval screen" bullet:

- **P1 — Order workflow status banner + manual-action buttons**: `Work done` (technician-set) and `Confirmed` (manager-set) are explicit human decisions layered on five derived states — reuse the existing `pattern-workflow-modules.html` status-banner atom, but the banner needs a visual distinction for "this state was a person's decision" (see manual-vs-derived pattern, §3).
- **P1 — Worksheet approval queue** (O3): two list types feeding one screen — worksheets in `Done`, and **orders in `Work done`** (the "job done" review queue) — need to read as related but distinct queues, not one undifferentiated list.
- **P1 — Worksheet review** (O4), the core approval surface, needs all of:
  - **Media-completeness gate**: an aggregate "N of M media present" badge (distinct from the per-photo upload chip in the camera flow), with **Approve blocked while media is missing** and an audited manager override ("approve without N pending photos").
  - **Charge-type review row control**: manager reviews/overrides the 4-value charge type per row, same interaction shape as price review.
  - **Billing-adjustment layer entry**: an editable overlay on signed content (adjust billable qty/price/discount) that keeps the customer-signed snapshot immutable and visible side by side with the adjusted version.
  - **Re-sign diff decision**: a revision diff (customer-visible changes highlighted, field-level not row-level) with a binary decision — "ask re-sign" / "proceed on existing signature" (audited) — plus the audit trail display.
  - **Correction-worksheet launch**: an action that creates a new worksheet under the same order, referencing the original, for mistakes discovered after `Synced`.
  - **ERP-bounce reopening**: the worksheet returns here with the ERP's rejection reason surfaced verbatim.

### Dispatch & back office

- **P1 — Dispatch board**: time × technician grid, drag-and-drop booking chips, **crew group chip** (renders a multi-technician job as one unit on the day grid, moves as one, has a detach-member interaction for splitting off one person — e.g. the apprentice leaves at lunch), unassigned pool (including unlinked inbound activities, see below), map view with job pins + coarse technician positions.
- **P1 — Unlinked-activity triage row**: a three-way action row (attach to order / create order / dismiss) for inbound ERP/calendar activities that don't map to an order — it lives on both the sync-health screen (O11) and the dispatch unassigned pool (O5); same component, two locations.
- **P1 — Register merge flow**: what a back-office user sees when merging a field-created provisional record into an existing one (`07-ui-screens.md` O7, `02-data-model.md` "Record merges") — needs a clear before/after and a note that history re-attaches.

### Sync health & administration (was one under-scoped bullet in v0.1 — actually four distinct components)

- **P1 — Sync health screen**: per-register status cards (per connection × register: status, cursor, last sync, row counts, error classes — reuses portal's cache-status panel pattern).
- **P1 — Dead-letter-queue browser**: not just a retry button — a payload viewer with **edit-and-retry** and **discard-with-reason**.
- **P1 — Conflict queue**: side-by-side version comparison with a pick/merge action.
- **P1 — Per-record sync inspector**: a drawer/panel linked from *every* record detail page (register, cursor, last sync, error, for that one record) — new, cross-cutting, touches every detail page in the app.

### Admin surfaces with no design-system precedent (absent from v0.1 entirely)

- **P1 — Users & roles (A2) additions**: device-enrolment QR/link generator, ERP identity-link mapping table with a match-by-email helper, and a **seat counter + upgrade prompt** (licensed vs. active users, activation beyond the licensed count blocked) — a SaaS-commerce UI pattern with zero precedent in either sibling app.
- **P1 — ERP connection (A4) additions**: capability-probe result display, **activity-purpose map** (a seven-row per-purpose type/symbol mapping table, `04-erp-sync.md`: `booking` / `worksheetShadow` (ships Phase 1, minimal) / `orderShadow` / `intake` / `workSegment` (Phase 1 config) / `documentVessel` / `historyImport`), invoice back-link field, poll cadence and maintenance-window settings, plus transformations editor (declarative maps + JS hooks), settings import/export, `/api/ext` token minting/revocation table.
- **P1 — Checklist template builder (O9)**: sections, field types, required rules, bounds, versioning, assignment by item/work type — structurally a form-builder; nothing like it exists in portal or calendar. Distinct from, and more complex than, the checklist *runner* (P1, technician-facing) already listed above.
- **P1 — Document-template library (A9, `12-documents-templates.md`)**: upload, field-catalog browser, test-render + validation report, selection-rule editor, number series, computed-field definitions. No precedent anywhere in the suite; closest reference point is portal's A5 email-template editor (per-key defaults + overrides, variables panel), worth citing as a starting shape even though the domain (DOCX templates, not HTML email) differs.

### Auth & device (Phase 0–1, `05-users-auth.md`)

- **P0 — PIN pad login**: large-target unlock screen, failure/rate-limit/wipe-warning states.
- **P0 — Device enrolment**: QR/link pairing flow + a minimal device list — the walking skeleton's PIN-on-paired-device login (`06-roadmap.md` Phase 0) can't exist without pairing. P1 finishes the registry admin surface (last sync, remote wipe).

## 3. Pattern-level gaps (design rules, not components)

1. **Offline states matrix.** Every technician screen must define: fresh / cached-stale / conflict / empty-because-never-synced. The design system needs the canonical pattern (banner? badge? timestamp?) once, so screens don't invent it.
2. **Transition-gated validation.** Errors surface at status transitions, not per keystroke (`02-data-model.md` field policies): the pattern for "you can't complete yet, here's the list" needs one canonical treatment.
3. **One-hand reach layout.** Primary actions in thumb zone; destructive actions out of it; the rule set for phone-first field screens.
4. **Gloves + sunlight acceptance criteria.** Written pass/fail criteria a design can be tested against (target size, contrast, state discernibility outdoors) — goes into CI/design review as the `06-roadmap.md` cross-cutting item.
5. **Localization headroom.** ET/EN/LV/LT/FI/NO from Phase 1: components must survive +40% string length (Finnish/German-length words in badges and buttons).
6. **Manual-vs-derived state pattern** (new). Order, Worksheet, and Booking all mix derived states with human-judgment gates (`Work done`, `Confirmed`). One canonical visual treatment for "this state was a person's decision, here's who and when" vs. "this state is computed" — likely a lock/hand icon plus attribution copy ("set by Jānis, 14:32"), applied consistently across all three state machines.
7. **Audited-override pattern** (new). Three separate features need "override with a reason, audited" — media-completeness waive, re-sign proceed-on-existing-signature, billing-adjustment layer. Design one shared component, not three bespoke ones.
8. **Revision/correction-chain pattern** (new). Signed-revision-immutability, correction worksheets, and the billing-adjustment layer all need one visual language for "this record has history you're not looking at right now, click to see it." Currently three separate asks that should converge on one pattern card.
9. **Diff-display pattern** (new). Both the re-sign decision and worksheet-review's diff-from-plan emphasis need shared diff rendering — old value struck/greyed, new value highlighted, field-level not row-level.

## 4. Screen inventory needing design (Phase 0–1 order first, then Phase 2)

Re-derived against `07-ui-screens.md` v0.5 in full (superseding v0.1's list, which predated round 4 and several screens below).

**Phase 0 — walking skeleton** (matches the roadmap's skeleton scope, `06-roadmap.md` Phase 0)
1. PIN login + device enrolment (A2, A3 — the Phase 0 minimal cut: enrolment link/QR + device list)
2. Read-only master-data list — items/customers pulled from one ERP, displayed offline, in a tenant theme (the walking-skeleton screen; **not** the Today feed — F1/F2 are Phase 1)

**Phase 1 — MVP**
3. Today / My jobs — bookings and booking-less worksheets in one list, plus the own-bookings day/week calendar (F1, F2)
4. Job / booking detail (site access notes, history shortcut) (F3)
5. Worksheet execution: parts / time & km / checklist / photos tabs, charge type + service-item attribution per row, return-travel-after-done timer (F4)
6. Signature capture, incl. re-sign re-entry state (F5)
7. Service item card + full service history timeline (F6)
8. Customer / site card, incl. field-creation and ad-hoc job start (F7)
9. Inbox — conflict tasks, assignment notices, rejection comments (F10)
10. More / profile — briefcase, device info, offline lock (F11)
11. Orders list + Order detail, incl. manual `Work done`/`Confirmed` actions and prepared-ahead worksheet creation (O1, O2)
12. Worksheet approval queue — both queue types, crew jobs grouped by `crewGroupId` (P1, owner 2026-07-07) (O3)
13. Worksheet review — the full component set in §2 above (O4)
14. Customers / sites / service items registers, incl. merge flow (O7)
15. Sync health & administration — status cards, DLQ browser, conflict queue, per-record inspector, unlinked-activity triage (O11)
16. Tenant settings, Users & roles incl. seat counter, ERP connection incl. activity-purpose map (A1, A2, A4)
17. Email/notification templates, Modules, Audit log, Migrations/ops (A5–A8)
18. Van stock, Scanner (F8, F9)
19. Dispatch board incl. crew group chip, Map view (O5, O6)
20. Stock overview (O8)
21. Checklist template builder (O9)
22. Item tree browser + coverage picker + bulk-operations bar (`11-service-items-and-parts.md`)
23. Document-template library (A9)

**Phase 2**
24. Reports (O10)
25. ETA/`enRoute` UI on Booking, field-side (`08-suite-integration.md`; CustomerFeedback rendering is portal-side and not part of this app's screen inventory)

**Correctly out of scope** — customer-facing pages: the customer surface is herbe.portal's service modules, designed portal-side within the portal's design system (`08-suite-integration.md` §4); herbe.service needs no customer-facing screens.

## 5. Deliverable format

- **Tokens**: CSS custom properties / Tailwind v4 `@theme` definitions (portal's CSS-first convention — no `tailwind.config.ts`), with the office/field density modes and light/dark/high-contrast schemes.
- **Components**: specs compatible with shadcn/ui + Radix composition (states, sizes, tokens used), in the same handover-doc structure the other apps received — plus Figma/claude.ai-design sources.
- **Patterns**: short written rules (§3) with one reference screen each.
- **Priority order**: §2 P0 items and screens 1–2 first — they gate the Phase 0 walking skeleton. Within P1, the O4 worksheet-review component set (§2) is the largest single item and should be scoped early since it gates the approve→invoice workflow end to end.

## 6. Inputs we still need from the design side

1. `burti-id-brandbook-1909.pdf` (the portal's tokens and `herbe-design-system/tokens.css` cite it as their source) — the derived token values are in the repo, the brandbook itself is not.
2. The claude.ai/design export — **available**: it landed in the `herbe-design-system` repo (`tokens.css`, `shared.css`, `preview/` cards — principles, 8 patterns, foundations; `handovers/` incl. `PORTAL.md`, `CALENDAR.md` and `SERVICE.md`, the actionable prioritised version of this brief). No longer outstanding.
3. Any existing field-app explorations, if they exist (brand assets — logos, app icons, hero imagery — are already in the repo under `assets/`).
