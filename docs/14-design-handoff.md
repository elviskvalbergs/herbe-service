# herbe.service — Design-System Handoff: What's Missing to Build This App

Status: draft v0.1 (2026-07-03). Audience: whoever does the herbe design-system work (the claude.ai/design project, `fa6160ab-a783-4cce-b0b1-fb2b88c0b84c`, still pending import — `06-roadmap.md` open items). This is the brief: what the current design system does **not** cover and herbe.service cannot ship without.

## Starting point (verified from the sibling apps' source, 2026-07-04)

- There is **no shared component library** in the suite. "Design system" today = a handover document each app re-implements: herbe.portal with shadcn/ui + Radix + Tailwind v4, herbe.calendar with hand-rolled CSS custom properties (`app/design.css`).
- The two token implementations, read from source:
  - **herbe.portal** `app/globals.css`: Tailwind v4 `@theme` block titled "BURTI — design tokens, sourced from `burti-id-brandbook-1909.pdf` (Sept 2022)". Self-hosted **Poppins** as `--font-sans`; named brand palette `--color-burti-*` (black `#231F20`, white, rowanberry `#CD4C38`, high-sky `#00AEE7`, forest `#134A40`, mud `#212722`, …). Per-deployment theming: `--brand-*` aliases (e.g. `--brand-accent`, `--brand-danger`) overridden via `<style>` injection at the page root (`lib/theming`); rule in source: "Do not inline hex values in components."
  - **herbe.calendar** `app/design.css`: a **semantic token layer** on top of the Burti palette — `--app-bg/-alt/-soft/-hover/-elev`, `--app-line`, `--app-fg/-muted/-subtle/-faint`, `--app-accent`, `--app-cool/-warn/-danger/-success`, shadows, selection — with **dark as the default theme** and a `[data-theme="light"]` override.
- herbe.service builds on **shadcn/ui + Radix + Tailwind** (portal's approach — decision in `03-architecture.md`) and should adopt the calendar's *idea* of a semantic layer over the brand palette: components consume semantic tokens, tenants override brand aliases.
- The existing system is designed for **office web apps**: desktop-first data views, forms, dialogs, settings. That covers herbe.service's back-office surfaces (dispatch, approval, admin) reasonably well.
- What it has never had to cover is a **field tool**: offline, one-handed, gloves, sunlight, time pressure. That's the gap this document specifies.

Design constraints that override everything, including tenant branding (`README.md` principle 1, `03-architecture.md` theming): glove-usable target sizes, sunlight-readable contrast, one-hand reach, zero network dependence on any technician screen.

## 1. Token-level gaps

| Gap | What's needed |
|---|---|
| **Field-mode sizing scale** | Touch targets ≥ 48 px (primary actions 56–64 px), enlarged type scale for arm's-length reading, spacing that tolerates imprecise taps. Defined as a token mode (e.g. `density: field` vs `density: office`), not a separate system — same semantics, bigger values. |
| **Sunlight / high-contrast mode** | A high-contrast variant of the palette (critical text/controls ≥ 7:1) switchable by the technician (or auto via ambient light where available). Dark mode too — vans at 06:00 in a Nordic winter. |
| **Sync-state colors + iconography** | Canonical tokens for `local / pending / synced / conflict` (`02-data-model.md` sync metadata). These appear on every record chip and list row in the field UI; they must be one vocabulary app-wide, colorblind-safe, and never color-only (icon + color). |
| **Severity tokens** | `ok / warning / critical` used by checklist results with pass/fail bounds and by document display rules (`12-documents-templates.md` — "critical KPI prints as a red warning box"). One definition serving UI *and* generated PDFs. |
| **Status colors for the two state machines** | ServiceOrder (8 states) and Worksheet (9 states) statuses (`02-data-model.md`) need a stable color/shape language shared by list badges, board chips, and the portal timeline. |
| **Tenant theme-token vocabulary** | Unify what exists: portal's `--brand-*` aliases over the `--color-burti-*` palette + calendar's semantic `--app-*` layer (see Starting point) into one published vocabulary herbe.service implements (`13-suite-change-requests.md` SUITE-3) — plus the **precedence rule**: accessibility tokens beat brand tokens on field surfaces. |
| **Print/PDF tokens** | Header/footer, table, and severity styling for generated documents (`12-documents-templates.md`): the built-in worksheet report renders from theme tokens with no DOCX template. Today no print styling exists in the system at all. |

## 2. Component-level gaps

Priority: **P0** = walking skeleton (Phase 0), **P1** = MVP (Phase 1), **P2** = Phase 2.

### Offline & sync (nothing like this exists in the suite)

- **P0 — Global sync indicator**: online/offline/syncing/error, always visible, non-blocking; tap → sync detail.
- **P0 — Record sync badge**: the four sync states on any list row/card.
- **P1 — Outbox & conflict inbox**: list items for pending ops and bounced transitions (`03-architecture.md` conflicts), with per-item retry/resolve affordances.
- **P1 — "Download my work" (briefcase)**: scope summary (N orders, M photos, X MB), progress, partial-failure state, stale-data banner ("last synced 2 days ago").

### Technician field surfaces

- **P0 — Job card + my-jobs list**: booking/worksheet card with status, time window, customer, site, one-tap call/navigate; the single most-used component in the product.
- **P1 — Day/week technician calendar** (own bookings; renders Bookings, `02-data-model.md`).
- **P1 — Worksheet execution screen family**: big-target quantity stepper, part row with stock-location badge, start/stop **timer control** (work/travel/waiting), pause-with-reason picker, status-transition button with blocking-requirements list (field policies: "missing: km, remedy code").
- **P1 — Checklist runner**: the five field types (bool, number with min/max + pass/fail rendering, text, photo-required, selection), section progress, required-on-complete errors (`02-data-model.md` ChecklistTemplate).
- **P1 — Signature capture**: full-screen canvas, name field, legal text slot, content-lock confirmation.
- **P1 — Camera/media flow**: capture with before/after tagging, thumbnail strip, upload-state per photo (offline-queued).
- **P1 — Distance entry**: direct km or odometer before/after with computed result, billable toggle (`02-data-model.md` DistanceEntry).
- **P2 — Scan overlay**: barcode/QR viewfinder with success/failure states (parts + service item labels).
- **P2 — Alternatives suggestion row**: out-of-stock part → in-stock substitutes ranked van → warehouse → preference (`11-service-items-and-parts.md`).

### Item hierarchy (Phase 2, `11-service-items-and-parts.md`)

- **P2 — Tree browser** with rollup badges + **flat filtered list** sharing one filter state; path breadcrumb ("Store 14 / Fire safety / …").
- **P2 — Coverage picker**: "all / n of m / exceptions" entry on group rows — no FSM product has a good one; this needs real design work, both entry (technician, gloves) and display (manager, report).
- **P2 — Bulk-operations bar**: filter → multi-select → action (move, assign contract, print labels, create group order); spreadsheet import dry-run diff view.

### Dispatch & back office

- **P1 — Approval screen**: worksheet review with diff-from-plan emphasis, approve/reject-with-comment.
- **P1 — Sync health screen**: per-register status cards, dead-letter queue rows with human-readable reason + retry (`04-erp-sync.md` — a Phase 1 deliverable).
- **P2 — Dispatch board**: time × technician grid, drag-and-drop booking chips, **crew group chip** (moves as one, detaches one member), unassigned pool, map view with job pins + coarse technician positions.

### Auth & device (Phase 0–1, `05-users-auth.md`)

- **P0 — PIN pad login**: large-target unlock screen, failure/rate-limit/wipe-warning states.
- **P1 — Device enrolment**: QR/link pairing flow, device registry admin list (last sync, remote wipe).

## 3. Pattern-level gaps (design rules, not components)

1. **Offline states matrix.** Every technician screen must define: fresh / cached-stale / conflict / empty-because-never-synced. The design system needs the canonical pattern (banner? badge? timestamp?) once, so screens don't invent it.
2. **Transition-gated validation.** Errors surface at status transitions, not per keystroke (`02-data-model.md` field policies): the pattern for "you can't complete yet, here's the list" needs one canonical treatment.
3. **One-hand reach layout.** Primary actions in thumb zone; destructive actions out of it; the rule set for phone-first field screens.
4. **Gloves + sunlight acceptance criteria.** Written pass/fail criteria a design can be tested against (target size, contrast, state discernibility outdoors) — goes into CI/design review as the `06-roadmap.md` cross-cutting item.
5. **Localization headroom.** ET/EN/LV/LT/FI/NO from Phase 1: components must survive +40% string length (Finnish/German-length words in badges and buttons).

## 4. Screen inventory needing design (Phase 0–1 order)

1. PIN login + device enrolment (P0)
2. My jobs (list + day view) (P0 — skeleton scope: read-only list)
3. Job detail (order info, site access notes, history tab) (P1)
4. Worksheet execution (parts / time / km / checklist / photos / signature tabs or flow) (P1)
5. Conflict inbox + outbox (P1)
6. Manager approval queue + worksheet review (P1)
7. Sync health (admin) (P1)
8. Briefcase / download-my-work (P1)
9. Item card + service history timeline (P1)
10. Dispatch board + map (P2), tree browser + coverage (P2), scan flows (P2)
11. ~~Customer-facing pages~~ — removed (owner 2026-07-05): the customer surface is herbe.portal's service modules, designed portal-side within the portal's design system (`08-suite-integration.md` §4); herbe.service needs no customer-facing screens

## 5. Deliverable format

- **Tokens**: CSS custom properties / Tailwind v4 `@theme` definitions (portal's CSS-first convention — no `tailwind.config.ts`), with the office/field density modes and light/dark/high-contrast schemes.
- **Components**: specs compatible with shadcn/ui + Radix composition (states, sizes, tokens used), in the same handover-doc structure the other apps received — plus Figma/claude.ai-design sources.
- **Patterns**: short written rules (§3) with one reference screen each.
- **Priority order**: §2 P0 items and screens 1–2 first — they gate the Phase 0 walking skeleton.

## 6. Inputs we still need from the design side

1. `burti-id-brandbook-1909.pdf` (the portal's tokens cite it as their source) and the design-system handover doc(s) given to herbe.portal and herbe.calendar — we've now read both *implementations* from source, but not the docs behind them.
2. Access to the claude.ai/design project (`fa6160ab-a783-4cce-b0b1-fb2b88c0b84c`) or an export of it — e.g. "Send to Claude Code" from the Design side, or export the files and commit them to the `herbe-design-system` repo.
3. Brand assets and any existing field-app explorations, if they exist.
