# herbe.service — Recurring & Contract Service: the app overlay (design)

Status: v1.0 (2026-07-15). Feeds Phase 2 P2-WS1/WS2 (`22-phase-2-implementation-plan.md`). Owner steer 2026-07-15: *"SVCVc was lacking a lot of functionality in real life — think what would really be beneficial as an overlay."* This doc is that thinking: what the ERP service level gives us, where it falls short, and the app-owned overlay that closes the gap — reusing the suite's existing repeat engine rather than inventing one.

---

## 1. The ERP baseline (SVCVc) — and its confirmed semantics

`COVc` (contract) is read inbound; each covered row carries a service level `SVCVc` with exactly four scheduling fields. Owner-confirmed semantics (2026-07-15):

| SVCVc field | Meaning (confirmed) |
|---|---|
| `DaysFromStart` | days after the contract start to the **first** service |
| `DaysBetween` | the **minimum days between** services — a *spacer*, not a strict grid |
| `NrOfTimes` | number of services; **≤ 0 = open-ended** |
| `Weekends` | `false` → a date landing on Sat/Sun shifts to the **following Monday** |

Leap-year drift of a plain day count is **acceptable** (owner: "I don't think leap year matters"). That is the whole ERP model: **one crude fixed cadence per service level**, read-only (`COVc`/`SVCVc` never sync back — `22` §2).

## 2. What SVCVc can't express (the real-world gap)

Everything a field-service operation actually needs beyond "every N days":

- **Calendar anchoring** — "monthly on the 15th", "first Monday of each quarter", "every January". Day counts drift off the calendar.
- **After-completion scheduling** — next service = *last completion* + interval (the "minimum spacer" reading of `DaysBetween`). Fixed-from-start can't do it.
- **Multiple cadences per object** — a machine needs a monthly filter check *and* a yearly overhaul; SVCVc is one cadence per level.
- **Seasonal / irregular** — HVAC before summer *and* before winter (two uneven dates a year).
- **Lead time / generate-ahead** — raise the order N days before due so it can be planned and parts ordered.
- **Holiday & blackout calendars** — skip public holidays and customer-closed windows, not just weekends.
- **Grouping** — one order covering every due item at a site vs. one per item (trip efficiency).
- **Coverage rotation** — inspect *n of m* each cycle, rotating which units (ties to coverage records, `11`).
- **Pause / suspend** — contract on hold without losing the schedule.
- **Catch-up policy** — a missed cycle: generate late, skip, or collapse.
- **Assignment hints, checklist/work-template per visit, charge context** (covered vs billable).
- **Usage/meter-based** ("every 500 operating hours") — Phase 3, but the model shouldn't preclude it.

## 3. The key move: reuse the suite repeat engine, don't reinvent

herbe.calendar already solved most of §2. `lib/repeatRules.ts` is a **source-agnostic, fully-tested, pure** repeat engine (verified 2026-07-15):

- **Two modes** — `regularly` (fixed calendar) and **`after_completion`** (next = completion + interval). `after_completion` *is* recurring-service-after-last-service — exactly the owner's "minimum spacer".
- **Rich patterns** — daily; weekly incl. multi-weekday; monthly absolute *and* nth-weekday; yearly absolute *and* relative; interval count; end conditions (`never` / `on_date` / `after_n`); `paused`; timezone.
- **Correct calendar math** — recomputes the clamped day each cycle, so Jan 31 → Feb 28 → **Mar 31** and Feb 29 recovers on the next leap year (the drift SVCVc can't avoid, solved for free).
- **Generation** — `nextOccurrence` / `materializeWindow` + a cron materializer with a generate-ahead horizon, bounded concurrency, stop-on-first-failure, and completion feedback that bumps the anchor.

The core (`RepeatRule` type + generators) has **zero DB/calendar coupling** — it's the piece to **copy-first** (suite convention, `22` §6). Calendar-specific occurrence cloning (`cloneErpActivity` etc.) is *not* copied; herbe.service writes service records instead.

## 4. The overlay model (proposed)

**`ServiceScheduleRule`** — app-owned, anchored to a contract row / service-item node / service level. Start from the calendar `repeat_rules` shape (`template_source='service'`, `kind='task'` semantics — the just-in-time horizon fits work orders), then add the service-specific fields the calendar engine doesn't carry:

| Overlay field | Purpose |
|---|---|
| `leadDays` | generate the order this many days **before** due (plan + parts) |
| `groupBy` | `per_item` \| `per_site` \| `per_contract` — batch due items into one order |
| `blackoutCalendarId` | holiday / customer-closed windows to skip (beyond weekends) |
| `coverageRef` + rotation | which *n of m* units this cycle covers, rotating each time (`11`) |
| `catchUp` | `generate_late` \| `skip` \| `collapse` for a missed cycle |
| `assignmentHint` | preferred technician / crew / skill |
| `workTemplateId` / `checklistId` | what to do each visit (`22` P2-WS11) |
| `chargeContext` | contract-covered vs billable |

Everything else (mode, interval/unit, weekdays, weekOfMonth, monthOfYear, end conditions, pause, tz) comes straight from the reused engine.

**SVCVc → ServiceScheduleRule mapping** (inbound seed, one-time + re-sync; never pushed back):

| SVCVc | → ServiceScheduleRule |
|---|---|
| `DaysFromStart` | first-anchor offset from contract start |
| `DaysBetween` | `interval` (unit `day`); in `after_completion` mode it is the minimum gap after completion |
| `NrOfTimes` | `end_kind='after_n'` with `max_occurrences`; `≤0` → `end_kind='never'` |
| `Weekends=false` | weekend-shift-to-Monday flag on generation |

The seeded rule is then **editable beyond SVCVc** (add calendar anchoring, lead time, grouping, blackout, after-completion) — that richness is the overlay, and it stays app-side (consistent with `COVc` read-only).

`lib/domain/recurrence.ts` (already built, P2-WS2) is the **SVCVc primitive / reference projector**; the production scheduler delegates to the copied repeat engine. Keep it for the SVCVc-field semantics + as a lightweight cross-check.

## 5. Generation with the overlay (P2-WS2)

1. Cron materializer (copy calendar's) scans active, non-paused rules; materializes due dates within `[now, horizon + leadDays]`, honoring end conditions, the blackout calendar, and the weekend rule.
2. For each due date → create ServiceOrder + Booking (+ `ActVc`) via the P1 writers. **App-side generation, ERP sees it identically** (owner 2026-07-14, `22` P2-WS2); echo-suppressed; cancel → void-in-place.
3. `after_completion`: on order/worksheet completion, bump the rule anchor → next service scheduled from the completion date.
4. Idempotent via `materialized_count` / pending-date diffing — re-runs never duplicate a cycle.

## 6. What to prioritize (opinionated)

1. **Reuse `repeatRules` (both modes) + SVCVc seed mapping** — covers ~80% of §2 immediately, suite-consistent.
2. **Lead-time / generate-ahead + grouping** — the biggest operational wins (planning, parts, fewer trips).
3. **Holiday / blackout calendar** — real for compliance and field routing.
4. **Coverage rotation (n-of-m sampling)** — ties recurring generation to contract coverage.
5. **Catch-up policy + pause/suspend.**

Defer to Phase 3: usage/meter-based triggers; assignment auto-suggest (rides the Phase-3 scheduling-assist, `06`).

## 7. Open questions for the owner

1. **Holiday/blackout source** — per-country public-holiday set, per-customer blackout windows, or both?
2. **Grouping default** — per-site or per-item out of the box?
3. **Default mode per contract type** — `after_completion` (condition-driven maintenance) vs `regularly` (compliance/calendar-driven inspections)?
4. **`repeatRules` reuse mechanism** — copy-first into herbe.service, or extract a shared `@herbe/repeat` package (only if the calendar team wants to co-own it; default copy-first per `22` §6)?
