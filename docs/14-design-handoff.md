# herbe.service — Design-System Handoff: What's Missing to Build This App

Status: v0.3 (2026-07-06, round-7 correction: worksheet is one-per-technician, not shared lead+members — removes the per-row `addedBy` crew-attribution ask, adds crew-job grouping). Previous: v0.2 (2026-07-06). Previous: v0.1 (2026-07-03). Audience: whoever does the herbe design-system work (the claude.ai/design project, `fa6160ab-a783-4cce-b0b1-fb2b88c0b84c`, still pending import — `06-roadmap.md` open items) — in practice, `herbe-design-system/handovers/SERVICE.md` is the actionable version of this brief. This is the brief: what the current design system does **not** cover and herbe.service cannot ship without.

**Why v0.2:** v0.1 was written 2026-07-03, before three spec-review rounds (`09`, `10`, `16-spec-review-round-3.md`, plus the round-4 owner decisions folded into `02-data-model.md` v0.7 and `07-ui-screens.md` v0.3). Those rounds materially reshaped the highest-complexity screens (order/worksheet approval, sync administration) and added a whole admin surface (document templates) with no design-system precedent. v0.2 re-derives every section from the current `02-data-model.md` and `07-ui-screens.md` rather than patching v0.1 line by line — treat this as the current source of truth and v0.1 as superseded.

## Starting point (verified from the sibling apps' source, 2026-07-04)

- There is **no shared component library** in the suite. "Design system" today = a handover document each app re-implements: herbe.portal with shadcn/ui + Radix + Tailwind v4, herbe.calendar with hand-rolled CSS custom properties (`app/design.css`).
- The two token implementations, read from source:
  - **herbe.portal** `app/globals.css`: Tailwind v4 `@theme` block titled "BURTI — design tokens, sourced from `burti-id-brandbook-1909.pdf` (Sept 2022)". Self-hosted **Poppins** as `--font-sans`; named brand palette `--color-burti-*` (black `#231F20`, white, rowanberry `#CD4C38`, high-sky `#00AEE7`, forest `#134A40`, mud `#212722`, …). Per-deployment theming: `--brand-*` aliases (e.g. `--brand-accent`, `--brand-danger`) overridden via `<style>` injection at the page root (`lib/theming`); rule in source: "Do not inline hex values in components."
  - **herbe.calendar** `app/design.css`: a **semantic token layer** on top of the Burti palette — `--app-bg/-alt/-soft/-hover/-elev`, `--app-line`, `--app-fg/-muted/-subtle/-faint`, `--app-accent`, `--app-cool/-warn/-danger/-success`, shadows, selection — with **dark as the default theme** and a `[data-theme="light"]` override.
- herbe.service builds on **shadcn/ui + Radix + Tailwind** (portal's approach — decision in `03-architecture.md`) and should adopt the calendar's *idea* of a semantic layer over the brand palette: components consume semantic tokens, tenants override brand aliases.
- The existing system (`herbe-design-system` v2.0: principles + 8 pattern cards + foundation cards) is designed for **office web apps**: desktop-first data views, forms, dialogs, settings. That covers herbe.service's back-office surfaces (dispatch, approval, admin) reasonably well, and several existing pattern cards are directly reusable — `pattern-detail-view.html` for order/service-item detail, `pattern-data-table.html` for register lists, `pattern-workflow-modules.html` for status banners and danger zones, `pattern-dropdowns-and-selectors.html` for status/category pickers, `pattern-chips-and-avatars.html` for badges and identity chips.
- What it has never had to cover is a **field tool**: offline, one-handed, gloves, sunlight, time pressure. That's the gap this document specifies — plus, new since v0.1, a set of **approval/administration surfaces of a complexity neither sibling app has** (media-completeness gating, revision diffing, dead-letter queue triage, licensing).

Design constraints that override everything, including tenant branding (`README.md` principle 1, `03-architecture.md` theming): glove-usable target sizes, sunlight-readable contrast, one-hand reach, zero network dependence on any technician screen.

## 1. Token-level gaps

| Gap | What's needed |
|---|---|
| **Field-mode sizing scale** | Touch targets ≥ 48 px (primary actions 56–64 px), enlarged type scale for arm's-length reading, spacing that tolerates imprecise taps. Defined as a token mode (e.g. `density: field` vs `density: office`), not a separate system — same semantics, bigger values. |
| **Sunlight / high-contrast mode** | A high-contrast variant of the palette (critical text/controls ≥ 7:1) switchable by the technician (or auto via ambient light where available). Dark mode too — vans at 06:00 in a Nordic winter. |
| **Sync-state colors + iconography** | Canonical tokens for `local / pending / synced / conflict` (`02-data-model.md` "Sync metadata"). These appear on every record chip and list row in the field UI; they must be one vocabulary app-wide, colorblind-safe, and never color-only (icon + color). |
| **Severity + pass/fail tokens** | `ok / warning / critical` used by checklist results (bool / number-with-min-max / text / photo-required / selection field types — `02-data-model.md` ChecklistTemplate) and by document display rules (`12-documents-templates.md` — "critical KPI prints as a red warning box"). One definition serving UI *and* generated PDFs; the checklist runner's pass/fail rendering and the print-severity boxes are the same token, not two asks. |
| **Status colors for three state machines** (corrected from v0.1's "two") | ServiceOrder (8 states), Worksheet (9 states), **and Booking** (`planned/confirmed/cancelled/rescheduled` + `enRoute`) all need a stable color/shape language shared by list badges, board chips, and the portal timeline. Additionally: two states in the Order/Worksheet machines are **manual human decisions** (`Work done`, `Confirmed`) rather than derived — see the manual-vs-derived pattern in §3. |
| **Charge-type badge** | `invoiceable / warranty / contract / goodwill` — a four-value categorical badge on worksheet rows, order defaults, and printed reports ("warranty — no charge"). New since v0.1 (`02-data-model.md` "Charge type"). |
| **Work-entry-mode indicator** | Small iconography distinguishing booking-first / prepared-ahead / walk-up jobs on the job card (`02-data-model.md` "Work-entry modes") — a booking-less worksheet needs to silently read as normal, not broken. |
| **Signature revision-state badge** | `signed / superseded-by-correction / re-sign-requested / proceed-on-existing (audited)` — no vocabulary exists yet (`02-data-model.md` "Signature lock vs. rejection/correction"). |
| **Tenant theme-token vocabulary** | Unify what exists: portal's `--brand-*` aliases over the `--color-burti-*` palette + calendar's semantic `--app-*` layer (see Starting point) into one published vocabulary herbe.service implements (`13-suite-change-requests.md` SUITE-3) — plus the **precedence rule**: accessibility tokens beat brand tokens on field surfaces. |
| **Print/PDF tokens** | Header/footer, table, and severity styling for generated documents (`12-documents-templates.md`): the built-in worksheet report renders from theme tokens with no DOCX template. Today no print styling exists in the system at all. |

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
- **P1 — Crew-job grouping**: on a multi-technician job, each technician has their own worksheet sharing a `crewGroupId` — approval queues and job cards need a "grouped by job" treatment (N worksheets, one visual cluster) rather than a single shared document with per-row attribution.
- **P1 — Checklist runner**: the five field types (bool, number with min/max + pass/fail rendering, text, photo-required, selection), section progress, required-on-complete errors (`02-data-model.md` ChecklistTemplate).
- **P1 — Signature capture**: full-screen canvas, name field, legal text slot, content-lock confirmation, plus a **re-entry state** for "signature requested again" after a correction (see revision-chain pattern, §3).
- **P1 — Camera/media flow**: capture with before/after tagging, thumbnail strip, upload-state per photo (offline-queued).
- **P1 — Distance entry**: two mutually-exclusive sub-inputs collapsing to one derived value — direct km, or odometer before/after with computed result — plus billable toggle (`02-data-model.md` DistanceEntry).
- **P1 — Ad-hoc job start**: a primary CTA from the customer/site card that creates order + worksheet in one action with no booking (`02-data-model.md` "walk-up" work-entry mode) — new since v0.1.
- **P2 — Scan overlay**: barcode/QR viewfinder with success/failure states (parts + service item labels).
- **P2 — Alternatives suggestion row**: out-of-stock part → in-stock substitutes ranked van → warehouse → preference (`11-service-items-and-parts.md`).

### Item hierarchy (Phase 2, `11-service-items-and-parts.md`)

- **P2 — Tree browser** with rollup badges + **flat filtered list** sharing one filter state; path breadcrumb ("Store 14 / Fire safety / …").
- **P2 — Coverage picker**: "all / n of m / exceptions" entry on group rows, **plus a paired display mode** for the same coverage record read back on a manager report — entry (technician, gloves) and display (manager, report) are different UX problems on the same data; no FSM product has a good one, this needs real design work on both sides.
- **P2 — Bulk-operations bar**: filter → multi-select → action (move, assign contract, print labels, create group order); **spreadsheet import dry-run diff view** — worth designing as a reusable pattern, since item-hierarchy bulk-entry and future contract/PM data entry both need it, not a one-off.

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

- **P2 — Dispatch board**: time × technician grid, drag-and-drop booking chips, **crew group chip** (renders a multi-technician job as one unit on the day grid, moves as one, has a detach-member interaction for splitting off one person — e.g. the apprentice leaves at lunch), unassigned pool (including unlinked inbound activities, see below), map view with job pins + coarse technician positions.
- **P1 — Unlinked-activity triage row**: a three-way action row (attach to order / create order / dismiss) for inbound ERP/calendar activities that don't map to an order — the Phase 1 home is the sync-health screen (O11), the Phase 2 destination is the dispatch unassigned pool (O5); same component, two locations.
- **P1 — Register merge flow**: what a back-office user sees when merging a field-created provisional record into an existing one (`07-ui-screens.md` O7, `02-data-model.md` "Record merges") — needs a clear before/after and a note that history re-attaches.

### Sync health & administration (was one under-scoped bullet in v0.1 — actually four distinct components)

- **P1 — Sync health screen**: per-register status cards (per connection × register: status, cursor, last sync, row counts, error classes — reuses portal's cache-status panel pattern).
- **P1 — Dead-letter-queue browser**: not just a retry button — a payload viewer with **edit-and-retry** and **discard-with-reason**.
- **P1 — Conflict queue**: side-by-side version comparison with a pick/merge action.
- **P1 — Per-record sync inspector**: a drawer/panel linked from *every* record detail page (register, cursor, last sync, error, for that one record) — new, cross-cutting, touches every detail page in the app.

### Admin surfaces with no design-system precedent (absent from v0.1 entirely)

- **P1 — Users & roles (A2) additions**: device-enrolment QR/link generator, ERP identity-link mapping table with a match-by-email helper, and a **seat counter + upgrade prompt** (licensed vs. active users, activation beyond the licensed count blocked) — a SaaS-commerce UI pattern with zero precedent in either sibling app.
- **P1 — ERP connection (A4) additions**: capability-probe result display, **activity-purpose map** (a five-row per-purpose type/symbol mapping table: booking / intake / time-entry mirror / document vessel / history import), invoice back-link field, poll cadence and maintenance-window settings; P2: transformations editor (declarative maps + JS hooks), settings import/export, `/api/ext` token minting/revocation table.
- **P2 — Checklist template builder (O9)**: sections, field types, required rules, bounds, versioning, assignment by item/work type — structurally a form-builder; nothing like it exists in portal or calendar. Distinct from, and more complex than, the checklist *runner* (P1, technician-facing) already listed above.
- **P2 — Document-template library (A9, `12-documents-templates.md`)**: upload, field-catalog browser, test-render + validation report, selection-rule editor, number series, computed-field definitions. No precedent anywhere in the suite; closest reference point is portal's A5 email-template editor (per-key defaults + overrides, variables panel), worth citing as a starting shape even though the domain (DOCX templates, not HTML email) differs.

### Auth & device (Phase 0–1, `05-users-auth.md`)

- **P0 — PIN pad login**: large-target unlock screen, failure/rate-limit/wipe-warning states.
- **P1 — Device enrolment**: QR/link pairing flow, device registry admin list (last sync, remote wipe).

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

## 4. Screen inventory needing design (Phase 0–1 order first, then P2/P3)

Re-derived against `07-ui-screens.md` v0.3 in full (superseding v0.1's list, which predated round 4 and several screens below).

**Phase 0 — walking skeleton**
1. PIN login + device enrolment (A2, A3)
2. Today / My jobs — read-only list, including booking-less worksheets (F1, F2)

**Phase 1 — MVP**
3. Job / booking detail (site access notes, history shortcut) (F3)
4. Worksheet execution: parts / time & km / checklist / photos tabs, charge type + service-item attribution per row, return-travel-after-done timer (F4)
5. Signature capture, incl. re-sign re-entry state (F5)
6. Service item card + full service history timeline (F6)
7. Customer / site card, incl. field-creation and ad-hoc job start (F7)
8. Inbox — conflict tasks, assignment notices, rejection comments (F10)
9. More / profile — briefcase, device info, offline lock (F11)
10. Orders list + Order detail, incl. manual `Work done`/`Confirmed` actions and prepared-ahead worksheet creation (O1, O2)
11. Worksheet approval queue — both queue types (O3)
12. Worksheet review — the full component set in §2 above (O4)
13. Customers / sites / service items registers, incl. merge flow (O7)
14. Sync health & administration — status cards, DLQ browser, conflict queue, per-record inspector, unlinked-activity triage (O11)
15. Tenant settings, Users & roles incl. seat counter, ERP connection incl. activity-purpose map (A1, A2, A4)
16. Email/notification templates, Modules, Audit log, Migrations/ops (A5–A8)

**Phase 2**
17. Van stock, Scanner (F8, F9)
18. Dispatch board incl. crew group chip, Map view (O5, O6)
19. Stock overview (O8)
20. Checklist template builder (O9)
21. Item tree browser + coverage picker + bulk-operations bar (`11-service-items-and-parts.md`)
22. Document-template library (A9)

**Phase 3**
23. Reports (O10)
24. CustomerFeedback rendering, ETA/`enRoute` UI on Booking (portal-side and field-side respectively — see `08-suite-integration.md`)

**Still correctly out of scope** — carried over from v0.1 and unchanged: ~~customer-facing pages~~ removed (owner 2026-07-05): the customer surface is herbe.portal's service modules, designed portal-side within the portal's design system (`08-suite-integration.md` §4); herbe.service needs no customer-facing screens.

## 5. Deliverable format

- **Tokens**: CSS custom properties / Tailwind v4 `@theme` definitions (portal's CSS-first convention — no `tailwind.config.ts`), with the office/field density modes and light/dark/high-contrast schemes.
- **Components**: specs compatible with shadcn/ui + Radix composition (states, sizes, tokens used), in the same handover-doc structure the other apps received — plus Figma/claude.ai-design sources.
- **Patterns**: short written rules (§3) with one reference screen each.
- **Priority order**: §2 P0 items and screens 1–2 first — they gate the Phase 0 walking skeleton. Within P1, the O4 worksheet-review component set (§2) is the largest single item and should be scoped early since it gates the approve→invoice workflow end to end.

## 6. Inputs we still need from the design side

1. `burti-id-brandbook-1909.pdf` (the portal's tokens cite it as their source) and the design-system handover doc(s) given to herbe.portal and herbe.calendar — we've now read both *implementations* from source, but not the docs behind them.
2. Access to the claude.ai/design project (`fa6160ab-a783-4cce-b0b1-fb2b88c0b84c`) or an export of it — e.g. "Send to Claude Code" from the Design side, or export the files and commit them to the `herbe-design-system` repo. Still the single open item as of 2026-07-06 (`06-roadmap.md`).
3. Brand assets and any existing field-app explorations, if they exist.
