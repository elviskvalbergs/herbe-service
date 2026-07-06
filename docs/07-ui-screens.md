# herbe.service — UI: Screens, Roles, Workflows

Status: v0.3 (2026-07-06, owner round 4: booking-less jobs in F1/F2/F7, prepared-ahead worksheets + manual confirm in O2/O3, charge types + re-sign decision in O4). Previous: v0.2 (2026-07-05, round 3: O4 media gate + correction entry, O11 unlinked-activity list). Originally added by the spec review — the v0.1 spec had no UI coverage. Wireframes per screen are a Phase 0/1 design task; this doc fixes the inventory, navigation, and flow contracts so design and development can start.

## Two shells, one app

| Shell | Audience | Form factor | Chrome |
|---|---|---|---|
| **Field shell** | Technician, team lead | Mobile PWA, offline-first | Bottom tab bar: **Today · Jobs · Scan(P2) · Inbox · More**. Persistent sync-status chip (synced / pending-ops count / offline) in the header. |
| **Office shell** | Dispatcher/manager, back office, admin | Desktop-first responsive | Left sidebar (portal `AdminShell` pattern: collapsible, mobile drawer). Sections: Dispatch(P2) · Orders · Worksheets · Customers · Service items · Stock(P2) · Reports(P3) · Settings/Admin. |

Both shells are one Next.js app; the landing shell is chosen by role, and users with both hats (team lead) can switch. Every field-shell screen works offline against the local DB; office-shell screens are online-first (dispatcher works in the office) but degrade gracefully.

**Company switcher**: a deployment can hold several ERP company connections, each a separate data scope (`02-data-model.md`). Office shell: company selector in the sidebar header (portal's `/c/[companyId]` scoping pattern); every list/search is scoped to the active company. Field shell: technicians with access to one company never see a switcher; multi-company users switch under **More**. The "download my work" briefcase covers all companies the user has bookings in.

Suite look & feel: design-system tokens (`--herbe-*`), portal non-negotiables apply verbatim — square indicators/dots, `--herbe-bone` input fill lifting to `--herbe-paper` on focus, forest-green primary CTA, red only for brand + destructive, no circular avatars. Wordmark: inline-SVG logo component (`HerbePortalLogo` approach), never `<img>` on the design-system SVGs.

## Screen inventory — field shell (technician; team lead adds a team toggle)

| # | Screen | Phase | Content & primary actions | Offline |
|---|---|---|---|---|
| F1 | **Today** (landing) | 1 | Ordered list of today's work — bookings **and booking-less worksheets** (walk-up mode, `02-data-model.md` work-entry modes) in one list: time, customer, site, order summary, status chips; overdue/unfinished carried over from yesterday. Actions: open job, call contact, navigate. Pull-to-refresh = delta sync. | full |
| F2 | **My jobs** | 1 | Day/week calendar + list of own bookings and unplanned worksheets — future and current work in one view (simple; not the dispatch board). Filter: open/done. | full |
| F3 | **Job / booking detail** | 1 | Order info, site + access instructions (assigned tech only), service items with history shortcut, contact quick actions, linked worksheet(s). Actions: accept, start work (creates/opens worksheet), report blocked (pause reason). | full |
| F4 | **Worksheet execution** | 1 | Tabbed: **Work** (description, fault/cause/remedy) · **Parts** (rows: item search/scan(P2), qty, stock location, `addedBy`) · **Time & km** (start/stop timer + manual entries, work/travel with to-site/return direction; per-member; **return-travel timer stays available after `Done`** — complete on site, tap "drive back", nothing else; DistanceEntry per field policy) · **Checklist** (template-driven form, pass/fail bounds) · **Photos** (camera, before/after tag). Crew jobs (P2): members contribute rows/time/media, attributed; status stepper belongs to the **lead**. Footer: status stepper `In progress → Done`. | full |
| F5 | **Signature capture** | 1 | Lead-only. Summary the customer sees (customer-visible rows, no prices if role-gated), name field, canvas signature, geo+timestamp captured. Locks content (revision rule in `02-data-model.md`). | full |
| F6 | **Service item card** | 1 | Serial, model, site, warranty/contract badges, meter values, documents, **full service history** (HistoryEvent timeline incl. ERP-era). Entry points: job detail, QR scan (P2), search. | full |
| F7 | **Customer / site card** | 1 | Addresses with navigate, contacts with call, open orders, service items at site, notes. Create-in-field (tenant-configurable): new customer/site/service item with duplicate check on sync. **Start ad-hoc job**: create order + worksheet on the spot, no booking (walk-up mode). | full |
| F8 | **Van stock** | 2 | Own location's levels, search across locations, request transfer, min-stock flags. | full (cached levels, marked with last-sync time) |
| F9 | **Scanner** | 2 | QR/barcode: service item label → F6; part barcode → adds row to open worksheet (F4). | full |
| F10 | **Inbox** | 1 | Conflict tasks (bounced transitions, sync rejections), assignment notifications, manager rejection comments. Badge count in tab bar. | full (queued) |
| F11 | **More / profile** | 1 | "Download my work" briefcase (scope: next N days; progress + size), device info, language, offline PIN/biometric lock, sign out. | full |

## Screen inventory — office shell

| # | Screen | Phase | Role | Content & primary actions |
|---|---|---|---|---|
| O1 | **Orders list** | 1 | manager, back office | Filterable register list (portal `register-list` pattern): status, priority, customer, dates. Create order. |
| O2 | **Order detail** | 1 | manager | Header + rows (service items, symptoms), status timeline (derived in-flight states; `Work done` set by the technician, **Confirm** is the manager's action here once all worksheets are approved — `02-data-model.md`), default charge type, worksheets, bookings. Actions: accept, **create booking** (Phase 1 planning happens here: pick technician + time slot), **create worksheet ahead of the visit** (prepared-ahead mode: preload documents/checklists/expected parts), confirm, cancel. |
| O3 | **Worksheet approval queue** | 1 | manager | Worksheets in `Done`, oldest first — plus the **orders in `Work done`** ("job done" review queue); approve/reject per item or bulk. |
| O4 | **Worksheet review** | 1 | manager | Full worksheet read-out: rows with prices (ERP-computed at approval; `windowactions` preview when the tenant has WebExcellentAPI) and **charge types** (invoiceable/warranty/contract/goodwill — manager reviews/overrides per row), time, checklist results, photos (with **media upload state — Approve blocks on missing referenced media**, audited waive override; `02-data-model.md`), signature, billing-adjustment entry on signed content. Actions: **Approve** (triggers ERP push) / **Reject with comment** (returns to tech, F10). ERP-bounce tasks reopen here with the ERP's reason; corrected signed revisions show a **diff with a re-sign decision** (ask re-sign / proceed on existing signature, audited — `02-data-model.md`); post-sync mistakes start a **correction worksheet** from here. |
| O5 | **Dispatch board** | 2 | dispatcher | Day/week × technician rows (**time × capacity only — the pipeline/Kanban view is delegated to herbe.calendar**, `08-suite-integration.md` §3); drag-and-drop bookings; **crew scheduling** (crew bookings move as a group, detach a member); unassigned-work pool incl. **unlinked inbound activities** (attach to order / create order / dismiss, `04-erp-sync.md`); conflicts flagged inline; self-assignment pool toggle. Realtime-ish via delta polling. |
| O6 | **Map view** | 2 | dispatcher | Day's jobs + coarse technician positions. |
| O7 | **Customers / sites / service items registers** | 1 | back office | List + detail (portal `RegisterDetailLayout` pattern); edit app-owned fields; merge duplicates from field creation. |
| O8 | **Stock overview** | 2 | back office | Levels per location, transfers, consumption log (ERP-synced). |
| O9 | **Checklist template builder** | 2 | manager | Sections, field types, required rules, bounds; versioning; assignment by item/work type. Phase 1 ships seeded fixed templates managed as data, no builder UI. |
| O10 | **Reports** | 3 | manager, back office | Utilization, first-time-fix, MTTR, revenue/technician (ERP-priced). |
| O11 | **Sync health & administration** | 1 | admin, manager (read) | Per connection × register: status, cursor, last incremental/full sync, row counts, error classes (portal cache-status panel pattern). Actions: force full sync, run reconciliation now, pause/resume connection. **DLQ browser**: payload view, edit-and-retry, discard-with-reason. **Conflict queue**: side-by-side versions, pick/merge. **Unlinked inbound activities** (Phase 1 home): mapped-type activities without an order — attach to order / create order / dismiss; moves to the O5 unassigned pool in Phase 2. **Per-record sync inspector** linked from every record detail. All interventions audited. (`04-erp-sync.md` "Error handling & sync administration") |

## Screen inventory — admin

All Phase 1 unless noted; follows the portal's `/admin` console structure.

| # | Screen | Content |
|---|---|---|
| A1 | Tenant settings | Company profile, number series (standalone), price visibility policy, field-creation permissions, locale defaults. |
| A2 | Users & roles | Invite, role assignment, deactivate (triggers remote wipe), **device enrolment links/QR** (technician PIN pairing, `05-users-auth.md`), ERP identity links (person-code mapping table with match-by-email helper). **Seat counter**: licensed vs active users; activation beyond the licensed count is blocked with an upgrade prompt. |
| A3 | Device registry | Per-user devices, last sync, remote sign-out + wipe. |
| A4 | ERP connection | Adapter choice, credentials, capability probe result (incl. WebExcellentAPI), register/field map versions, **activity-purpose map** (per-purpose ActVc type/symbol: booking, intake, time-entry mirror, document vessel, history import — `04-erp-sync.md`), invoice back-link field, timezone, poll cadences, maintenance window; **transformations editor (declarative maps + JS hooks) and settings import/export** (P2, `04-erp-sync.md`); **`/api/ext` service API tokens** (mint/revoke per company connection, P2). |
| A5 | Email/notification templates | Portal's template editor reused: per-key defaults + overrides, variables panel, locale tabs. |
| A6 | Modules | Feature toggles per tenant (stock, checklists, portal exposure…), portal `MODULES` pattern. |
| A7 | Audit log | Who/when/what/device for every state change. |
| A8 | Migrations/ops | Build-time + admin-run migration runner (portal pattern), health endpoint status, **HistoryEvent projector rebuild** per company. |
| A9 | Document templates (P2) | DOCX template library per document type: upload, field-catalog browser, test render + validation report, selection rules, number series, computed-field definitions (`12-documents-templates.md`). |

In-app docs: `/docs` wiki (markdown, `admin`/`users` audiences) from day one, `DocLink` `?`-icons at the entry points listed above (F11, O2, O4, A4, A5).

## Core workflows (screen-to-screen contracts)

1. **Order intake → plan (P1)**: O1 create / ERP-synced order arrives → O2 accept → O2 create booking (tech + slot) → tech's F1/F2 updates on next delta; push notification (P2).
2. **Execute (P1)**: F1 open job → F3 accept/start → F4 parts/time/checklist/photos → F5 customer signature → status `Done` → appears in O3.
3. **Approve → invoice (P1)**: O3 → O4 review → Approve → ERP push (worksheet + stock consumption) → ERP creates invoice → `IVVc` read-back sets order `Invoiced`; visible in O2 timeline and F6 history. Reject → comment → F10 inbox → revision flow (re-sign if customer-visible content changes).
4. **ERP bounce (P1)**: push fails validation → worksheet back to `Done`, task in O3/O4 with ERP reason + DLQ entry in O11.
5. **Re-plan (P2)**: O5 drag booking → crew bookings move as a group (or detach one member); if worksheet `Draft/Assigned`, lead/members follow; from `Accepted` onward reassignment is confirmed by the manager and recorded on the worksheet. Tech gets notification + F10 entry.
6. **Blocked on site (P1)**: F4 pause (reason parts/access) → O2/O5 flags order; resume or re-plan.
7. **Field creation (P1)**: F7 create customer/site/service item → outbox → server duplicate check vs ERP natural keys → clean: push to ERP; suspect: back-office merge task in O7.
8. **Conflict (P1)**: illegal transition or same-field edit → conflict task in F10 (tech) or O11 (manager) with both versions; never silent.

## UX standards (field)

- Tap targets ≥ 48 px, one-hand reach for primary actions (bottom sheet patterns), high-contrast sunlight-readable palette within design-system constraints.
- **Never a network spinner on cached data**: skeletons on first paint, content from local DB, background refresh. Explicit staleness labels ("as of 14:32") on stock levels and prices.
- Optimistic UI for all worksheet mutations; the sync chip is the single global truth for pending state; per-record `conflict` badges link to F10.
- Offline banner is informational, not blocking; actions that genuinely need connectivity (ERP price preview) hide or show their fallback per capability gating, portal-style — absent, not disabled.
- iOS: no input font-size under 16 px (calendar's zoom-prevention rule); PWA install prompts per platform.
- All user-visible strings through i18n from the first commit (next-intl; portal locale set).
