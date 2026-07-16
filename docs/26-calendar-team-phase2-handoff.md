# herbe.calendar — Phase 2 change requests, handoff for the calendar dev team

Status: v1.0 (2026-07-16). A ready-to-execute handoff for the **herbe.calendar** team covering the calendar-side changes **herbe.service** needs in Phase 2. The canonical, individually-decidable request list is `13-suite-change-requests.md`; this doc expands the Phase-2 calendar asks into actionable specs — grounded in the **current** calendar codebase — with acceptance criteria, a fallback, and an effort read for each.

**Kicked off now because these carry cross-team lead time.** They gate the *full* recurring-service experience, so starting them in parallel with herbe.service WS1/WS2 removes them from the critical path later.

**Honest blocker status:** none of these **hard-blocks herbe.service from starting** WS1 or the WS2 projection layer — each has a fallback already built into the plans (`docs/superpowers/plans/2026-07-16-phase2-ws2-projection-layer.md`): holidays fall back to a tenant-default calendar (B4), reassignment falls back to the herbe.service dispatch board / a deep link. What they unblock is the *good* version: real per-person holiday blackouts and in-app drag-to-reassign. Treat them as "start early to avoid a late scramble," not "WS2 is stuck without them."

**Codebase facts below are from a 2026-07-15 review of calendar `preview`** — confirm against your latest before implementing; file paths may have shifted.

---

## Priority & what each unblocks

| Ask | Priority | Unblocks (herbe.service) | Calendar effort | Fallback in place |
|-----|----------|--------------------------|-----------------|-------------------|
| **CAL-10** — per-person holiday read | **P1 (do first)** | WS2 B4 → real per-person holiday blackouts in the schedule projection | **Small** (data + resolution already exist) | tenant-default holiday calendar |
| **CAL-9** — embeddable team/dispatch view | **P1** | WS2 reassignment UX (sick/reallocated technician) | **Large** (new feature) | dispatch board / deep link |
| **CAL-4** — Smart-Booking asset field + reschedule links | P2 | WS7 Smart-Booking intake (self-scheduling) | Small (field-type add) | plain-text serial + QR prefill |
| **CAL-6/7/8** — service-activity recognition, context+deep-link, guarded editing | P2 | Manager OK-discovery Kanban legibility (P1/P2) | Small each | tier-0 renders plainly; conflict-bounce |

Recommended order for the calendar team: **CAL-10 → CAL-4 → CAL-6 → CAL-7 → CAL-8 → CAL-9** (small wins first; CAL-9 is the big one, start its design in parallel).

---

## CAL-10 — Per-person national-holiday scoped read  *(P1 — start here)*

**What herbe.service needs.** A scoped, token-authenticated read that answers: *for these person codes, in this date range, which dates are national holidays?* (or: *what holiday country is each person on*, so herbe.service can expand the dates itself).

**Why.** The recurring-service scheduler projects due dates 12+ months out and shifts/skips any occurrence that lands on a technician's public holiday (beyond the SVCVc weekend rule). herbe.service does **not** want to maintain its own holiday tables — you already import them per person.

**Current calendar state (2026-07-15).** The data and resolution already exist:
- `db/migrations/17_add_holidays.sql` — `cached_holidays` (country, year) + `person_codes.holiday_country` (per-person override) + an account default.
- `lib/holidays.ts` — import from openholidaysapi.org.
- `app/api/holidays/route.ts:21-36` — already maps person codes → countries → holiday sets and returns a `personCountries` map.

So this is **exposing an existing capability behind a scoped token**, not building holiday logic.

**Proposed shape.** A token-authenticated endpoint (natural home: alongside the CAL-5 availability API, or a small dedicated route) — e.g. `GET /api/ext/holidays?personCodes=A,B&from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ [personCode]: { country: string, dates: string[] } }`. Scope the token to one service company's person codes; reject/omit anything outside scope.

**Acceptance criteria.**
- Given a set of person codes and a date range, the response lists, per person, that person's national-holiday dates in range (or the country so herbe.service can expand).
- Person codes outside the token's scope are not returned (no cross-company leak).
- Uses the existing `cached_holidays` / `person_codes.holiday_country` resolution — no new holiday source.

**Fallback if declined/deferred.** herbe.service uses a per-tenant default holiday calendar (WS2 B4) — more setup, drift risk — or honours weekends only.

---

## CAL-9 — Embeddable, scoped team/dispatch calendar view for reassignment  *(P1 — big, start design now)*

**What herbe.service needs.** An **embeddable** team/dispatch view — scoped to one service company's technicians and its service bookings — that herbe.service hosts inside its own app, with **drag-to-reassign** a booking from one technician to another. Owner (2026-07-15): *"add to the calendar required changes whatever you need"* — this is a committed ask; the **embedding mechanism is the calendar team's choice** (iframe / scoped route / shared component).

**Why.** The hardest part of running recurring service at scale is reassignment when a technician is sick or reallocated, while keeping a team view. herbe.service already generates the work as `ActVc`/bookings, so rather than rebuild a team calendar (which would violate the suite's "no second calendar / no second Kanban" rule — `06-roadmap.md:42`, `08-suite-integration.md` §3), it wants to **embed yours**.

**Current calendar state (2026-07-15).** No dispatch/embed view with editing exists yet. The closest substrate:
- `Favorite` holds `personCodes: string[]` (`types/index.ts:159-165`); shared via `ShareLink` with busy/titles/full visibility (`types/index.ts:167-189`), rendered at `app/share/[token]` (`components/ShareCalendarShell.tsx`) — but **read-only + optional booking, no drag/reassign, no iframe embed mode**.
- `lib/pipeline` exists (Kanban filters on `(ActType, ActState)` — `types/pipeline.ts`).
So CAL-9 is genuinely **new feature work**, not a config toggle — plan it accordingly.

**Proposed shape.** A scoped, embeddable view (token- or session-scoped to a service company's person codes + service bookings) showing those technicians across a day/week, where a dispatcher drags a booking between technicians and the change persists to the underlying activity/booking. Reflected back into herbe.service via tier-0 `ActVc` sync.

**Acceptance criteria.**
- herbe.service can embed a view (iframe/route/component — your call) scoped to a given set of person codes and their service bookings; nothing outside that scope renders.
- A dispatcher can drag a service booking from technician A to technician B; the reassignment persists and is visible on the next sync.
- Respects the CAL-8 lock rule (a locked/in-progress booking is not freely re-planned).

**Fallback if declined/deferred.** herbe.service reassigns from its **own** dispatch board (P1 WS10) or deep-links out to herbe.calendar's existing views — losing the embedded, single-window team UX but keeping the capability.

---

## CAL-4 — Smart-Booking service-intake fields + reschedule/cancel links  *(P2 — for WS7 intake)*

**What.** (1) An **asset-reference** custom-field type on booking templates, pre-fillable via a URL param (QR sticker → booking page with the serial set). (2) A working **cancel/reschedule link** in the booking-confirmation email for service-intake bookings.

**Current calendar state (2026-07-15).** Booking templates already carry `custom_fields` JSONB (`db/migrations/13_create_booking_tables.sql`), but only `type: 'text' | 'email'` (`types/index.ts:199-203`). The confirmation email already has a cancel/reschedule link, though today it's a single cancel-token URL = cancel-and-rebook (`lib/bookingEmail.ts`, `lib/bookingExecutor.ts:86-89`), not a slot-preserving reschedule. Booking templates already target an ERP `ActType` (`lib/bookingExecutor.ts:174-180`) — so "a template targeting the service-intake activity type" rides existing machinery. **So CAL-4 is a field-type addition, not a new custom-fields feature.**

**Proposed shape.** Add `type: 'asset_ref'` (validated at booking, pre-fillable via URL param); the value flows onto the created `ActVc` so herbe.service's intake rule reads it.

**Acceptance criteria.** A template can declare an asset-reference field; a booking-page URL param pre-fills it; the value lands on the created activity; the confirmation email carries a cancel/reschedule link.

**Fallback.** Plain-text serial field + QR-prefilled links; conversion works without booking-time validation.

---

## CAL-6 / CAL-7 / CAL-8 — Service-activity legibility & guarded editing  *(P2 — small each)*

These make herbe.service's activities (and the worksheet/order status-shadow activities) legible and safe in calendar; they support the manager's OK-discovery flow. Full text: `13-suite-change-requests.md` §CAL-6/7/8. `ActivityDrawer.tsx`, `ActivityBlock.tsx`, `ActivityForm.tsx` and the `(ActType, ActState)` Kanban all exist to build on.

- **CAL-6 — recognition:** per-account config of which `ActType`s are "service"; recognized activities (incl. status-shadow cards) get a service badge/colour. *Acceptance:* a configured service `ActType` renders visually distinct in day/week/Kanban. *Fallback:* renders as an ordinary activity.
- **CAL-7 — context + deep link:** for recognized service activities, `ActivityDrawer`/`ActivityBlock` show order number, site, worksheet status (from the `ActVc` fields herbe.service writes) + an **"Open in herbe.service"** button. *Acceptance:* opening a service card shows the context and a working deep link. *Fallback:* the context lives in the activity's text fields; users follow a pasted URL.
- **CAL-8 — guarded editing:** recognized service activities that are `OKFlag`-locked or whose linked worksheet is `In progress`+ become read-only; free re-planning stays while `planned/confirmed`. *Acceptance:* a locked service activity can't be re-planned in calendar; an unlocked one can. *Fallback:* calendar edits freely and herbe.service's tier-0 conflict rule bounces illegal moves to the dispatcher inbox.

---

## Coordination

- **Repo/branch:** calendar work lands on `herbe-calendar` `preview` (your normal flow); herbe.service consumes it once it reaches your production/preview and the token/endpoint shape is shared back.
- **Contract to share back to herbe.service:** for CAL-10 and CAL-9, the exact endpoint path + auth/scoping shape + response JSON. herbe.service will code against it (WS2 B4 for CAL-10; the reassignment surface for CAL-9). Until shared, herbe.service builds against its fallback and swaps in when your shape lands.
- **Questions / spec source:** `13-suite-change-requests.md` (canonical CR list), `08-suite-integration.md` (§3 service-activity design, §4 the reduced integration), `23-recurring-service-overlay.md` §4.4 (why the embedded view, not a rebuild).

### If you drive this with Claude Code (optional)

```
You are implementing ONE calendar-side change request for the herbe suite.

Repo: /Users/elviskvalbergs/AI/herbe-calendar   (work on `preview`)
Request: <CAL-ID>          # e.g. CAL-10, CAL-9

1. Read the spec: /Users/elviskvalbergs/AI/herbe-service/docs/26-calendar-team-phase2-handoff.md (the <CAL-ID> section)
   + its cross-refs (13-suite-change-requests.md, 08-suite-integration.md).
2. Confirm the "Current calendar state" facts against the live code (paths may have shifted since 2026-07-15).
3. Brainstorm the endpoint/component shape (superpowers:brainstorming), then implement TDD against the acceptance criteria.
4. The deliverable includes the CONTRACT to hand back to herbe.service: exact path + auth/scoping + response JSON shape.
5. Never commit to main; work on preview per the calendar team's flow.
```
