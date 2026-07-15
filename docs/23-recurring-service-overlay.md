# herbe.service — Recurring & Contract Service: the app overlay (design)

Status: v1.3 (2026-07-15). Feeds Phase 2 P2-WS1/WS2 (`22-phase-2-implementation-plan.md`). Owner steer 2026-07-15: *"SVCVc lacked a lot in real life — think what would be beneficial as an overlay; the main challenge is bulk reporting and managing the schedule when there are many service items."* This doc is that thinking: what the ERP service level actually is, where it falls short, the clashes to avoid, and the app-owned overlay — whose headline value is **managing and reporting the schedule at scale**, built on the suite's existing repeat engine.

v1.2 folded in the source manuals (HansaManuals Service Agreements + Excellent help): the correct **first-occurrence formula** (Start + Initial Days + Days Between), the ERP's cross-cycle looping, the `Last Activity` duplicate guard, and the separate **periodic-invoicing** dimension of Contracts.

v1.3 reframes §4 around the owner's actual pain (2026-07-15): **visibility is coupled to premature materialization** — today you must create activities months ahead to see the plan, then delete-and-recreate on every change. The fix is **projection-first** scheduling (see the plan from rules, materialize only the near term) with reassignment delegated to an embedded herbe.calendar view. Default mode is **`regularly`** (calendar-driven); grouping consolidates at ServiceOrder creation with bookings kept 1:1 per item.

---

## 1. The ERP baseline (SVCVc = "Service Agreements")

SVCVc is the **Service Agreements** register in the Contracts module — a *multi-row template*, not a single cadence. Owner-confirmed semantics (2026-07-15):

**Header**
- `Code` / `Comment` — template id + name.
- `DaysFromStart` ("Initial Days") — an **extra offset on the first interval**, applied only to the first activity of a cycle; **may be negative**. First activity = **Start + Initial Days + Days Between** (e.g. `7 + 60` = 67 days after start; `-30 + 60` = 30 days after).
- `Weekends` — **3-way**: *Ignore* (allow), *Before* (move to **Friday**), *After* (move to **Monday**). The next `Days Between` is counted from the **original** (weekend) date, not the shifted one.

**Matrix rows (Flip A)** — the sequence:
- `Act.Type`, `Persons` (+ `Cc`) — what activity to create and who's responsible/copied.
- `Comment` → copied to the activity text.
- `No.of Times` — how many times to repeat this row before moving to the next (blank = 1).
- `Days Between` — interval for this row; **`0` = same date as the prior row** (a co-scheduled companion, e.g. a check that rides the last visit).
- `Task Type` — routes to **Calendar** vs **Task Manager**; `Symbol` — iconography.

Linked on a Contract row (Flip F) with a start date; running the **Service Agreement maintenance** generates the Activities into the Persons' Calendar/Task Manager. Example: row 1 = `60 days ×3, CV, FF`; row 2 = `0 days ×1, ET, IP` → three CV visits 60 days apart for FF, plus one ET for IP on the 3rd visit's date; **the whole row-sequence then loops** until the run window / Contract End Date runs out (so `No.of Times` is a *per-cycle* count, not a lifetime cap). The maintenance generates between `max(period start, row Start Date, Last Activity)` and `min(period end, End Date)`, and auto-updates a **`Last Activity`** field per contract row to prevent duplicates on re-run — the ERP parallel of our materialized-state idempotency (§7).

For us `COVc`/`SVCVc` are **read-only inbound** (`22` §2) — a seed, never pushed back.

## 2. Clashes to avoid

- **Generation ownership — resolved (owner 2026-07-15): customers use herbe.service *instead of* the ERP's Service Agreement maintenance, not both.** So there is no dual-generation to guard against: herbe.service owns recurring generation app-side and writes the `ActVc` (`22` P2-WS2), and the ERP-side agreement maintenance simply isn't run for these tenants. (Running both *would* double-create — but that's ruled out by the owner's decision, so no exclusive-ownership enforcement is needed.)
- **Periodic invoicing is a *separate* recurring dimension — leave it to the ERP.** A Contract (`COVc`) drives two recurring things: recurring **service activities** (SVCVc — our overlay) *and* recurring **invoices** (period/term, factor, "Invoice, Days", "Create contract invoices"). The invoicing side is recurring *money*, which the ERP owns (product principle 3). herbe.service's engine schedules *service work* only — it never generates invoices. A generated visit carries a `chargeContext` (contract-covered vs billable), but the periodic invoice itself is created ERP-side.
- **`Weekends` is 3-way**, not boolean — modeled as `WeekendMode = 'ignore' | 'before' | 'after'` (engine fixed, `lib/domain/recurrence.ts`).
- **First occurrence is one full interval out** (`Start + Initial Days + Days Between`), not `Start + Initial Days` — a subtle off-by-one that would mis-time the very first service (engine fixed).
- **`Days Between = 0` = co-scheduled companion**, not "no repeat". A lone primitive row treats `≤0` as a single occurrence; the *sequence* meaning (same date as prior row) is composed at the overlay level.
- **`No.of Times` is a per-cycle count, not a lifetime cap** — the ERP loops the row-sequence until the End Date. The primitive treats it as a plain cap; the cross-row looping is overlay-level (§6).
- **A Service Agreement is a multi-row sequence**, so it maps to **several** `ServiceScheduleRule`s grouped under one agreement — not one rule (§6).
- **`Persons`/`Cc`/`Task Type`** — SVCVc assigns ERP Persons and routes Calendar vs Task Manager; map via identity links to our technician assignment and the booking (calendar) vs task (task-manager) split, don't drop them.

## 3. What SVCVc can't express (the real-world gap)

Beyond "every N days per row":

- **Calendar anchoring** — "monthly on the 15th", "first Monday of each quarter", "every January". Day counts drift off the calendar.
- **After-completion scheduling** — next service = *last completion* + interval (the "minimum spacer" reading of `Days Between`). Fixed-from-start can't do it.
- **Multiple independent cadences per object** — a machine needs a monthly filter check *and* a yearly overhaul (SVCVc's rows chain within one cycle; independent overlapping cadences are awkward).
- **Seasonal / irregular** — HVAC before summer *and* before winter (two uneven dates a year).
- **Lead time / generate-ahead** — raise the order N days before due so it can be planned and parts ordered.
- **Holiday & blackout calendars** — skip public holidays and customer-closed windows, not just weekends.
- **Grouping** — one order covering every due item at a site vs. one per item.
- **Coverage rotation** — inspect *n of m* each cycle, rotating which units (`11`).
- **Pause / suspend, catch-up policy, assignment hints, checklist/work-template per visit, charge context.**
- **Usage/meter-based** ("every 500 hours") — Phase 3, but don't preclude it.

## 4. The main challenge: managing & reporting the schedule at scale

Per the owner, the pain today isn't the cadence math — it's that **visibility is coupled to premature materialization**. To *see* what's due you must generate the ERP activities months ahead; then when anything changes (and many things do), you must **delete those activities and recreate them** — that's the real pain. On top of it, service orders still get **generated by hand** ("someone makes tomorrow's orders from the activities that exist"), and reassigning when a technician is sick or reallocated is hard while keeping a team view.

The overlay's answer, ordered by the pain it removes:

1. **Projection-first visibility — see the schedule without materializing it.** The forward schedule ("what's due, when, for which item") is **computed from the rules** (`lib/domain/recurrence.ts` / the repeat engine), 12+ months out, with **no activities or orders created**. A change means editing a **rule or a single occurrence** — nothing to delete-and-recreate. This is the core fix: decouple *knowing the plan* from *committing the work*.
2. **Automatic near-term materialization — kill the manual order step.** At lead time (per rule), a due occurrence becomes a ServiceOrder + Booking automatically (or one-click bulk for "tomorrow"), instead of someone building orders by hand. Only the near horizon is committed; the far horizon stays projection.
3. **Change at rule / occurrence granularity.** Pause/suspend a contract, shift or skip a single occurrence, or reassign — on one item or a filtered batch of many. The projection updates; there's no pile of stale activities to clean up.
4. **Reassignment via herbe.calendar, not a bespoke UI.** Generated work already flows to `ActVc`/bookings, so team-view reassignment (sick, reallocated) happens in **herbe.calendar's team/dispatch view** — likely surfaced as an **embedded calendar view inside the service app** (owner's suggestion). Delegate the team view; don't rebuild it (the "no second Kanban" rule, `22` §2). *(Needs a herbe.calendar conversation — candidate CAL-\* ask, `13`.)*
5. **The management surface + reporting on top.** A filterable matrix of service items × time (next/last, due/**overdue**, coverage %, service level, assigned tech; filter by customer/site/contract/level/tech/model), the coverage/overdue/workload **rollups** (`11`), and reporting (upcoming workload, compliance/coverage, per-tech load, projected vs. actual — ties to `22` P2-WS10).

**Design implication — two layers of state:** a *projected* layer (rules → dates, cheap to recompute, changes freely) and a thin *materialized* layer (near-term committed orders/bookings). The matrix, rollups, and bulk edits read the **projection**; only the near horizon is materialized. That split is precisely what removes the "generate 6 months ahead, then delete-and-recreate on every change" pain.

## 5. Reuse the suite repeat engine, don't reinvent

herbe.calendar already solved the per-rule scheduling. `lib/repeatRules.ts` is a **source-agnostic, fully-tested, pure** repeat engine (verified 2026-07-15):

- **Two modes** — `regularly` (fixed calendar) and **`after_completion`** (next = completion + interval) — the latter *is* recurring-service-after-last-service, exactly the owner's "minimum spacer".
- **Rich patterns** — daily; weekly incl. multi-weekday; monthly absolute *and* nth-weekday; yearly absolute *and* relative; interval count; end conditions (`never`/`on_date`/`after_n`); `paused`; timezone.
- **Correct calendar math** — Jan 31 → Feb 28 → **Mar 31**, Feb 29 recovers on the next leap year (the drift SVCVc can't avoid, solved for free — and richer than SVCVc's day-count-only model, which the owner is fine deprecating for anchored schedules).
- **Generation** — `nextOccurrence` / `materializeWindow` + a cron materializer (generate-ahead horizon, bounded concurrency, stop-on-first-failure, completion feedback that bumps the anchor).

The core has **zero DB/calendar coupling** — **copy-first** (`22` §6). Calendar-specific occurrence cloning is not copied; herbe.service writes service records instead.

## 6. The overlay model (proposed)

A **Service Agreement** (from `COVc`+`SVCVc`, or authored in-app) = a **group of `ServiceScheduleRule`s** (one per SVCVc matrix row / per cadence). Each rule starts from the calendar `repeat_rules` shape (`template_source='service'`, task-like horizon), plus service-specific fields:

| Overlay field | Purpose |
|---|---|
| `leadDays` | generate the order this many days **before** due (plan + parts) |
| `groupBy` | `per_item` \| `per_site` \| `per_contract` — consolidation applied **at ServiceOrder creation**, not at booking level (owner 2026-07-15): each occurrence stays a 1:1 activity/booking per service item (the ERP has dedicated item fields on the activity), and co-due items are merged into one order at generation |
| `blackoutCalendarId` | holiday / customer-closed windows to skip (beyond weekends) |
| `coverageRef` + rotation | which *n of m* units this cycle covers, rotating each time (`11`) |
| `catchUp` | `generate_late` \| `skip` \| `collapse` for a missed cycle |
| `assignmentHint` | preferred technician / crew / skill (from SVCVc `Persons`) |
| `workTemplateId` / `checklistId` | what to do each visit (`22` P2-WS11) |
| `chargeContext` | contract-covered vs billable |

Mode, interval/unit, weekdays, anchoring, end conditions, pause, tz come from the reused engine.

**SVCVc → rules mapping** (inbound seed; re-sync; never pushed back): each matrix row → one rule (`Act.Type`→booking/task type, `Persons`→assignment, `Days Between`→interval or, when `0`, co-anchored to the prior row); header `DaysFromStart`→the first-interval offset (first occurrence = Start + Initial Days + Days Between; negative allowed); `Weekends`→`WeekendMode`. `No.of Times` seeds an `after_n` cap *per cycle* — with the sequence-loop-until-End-Date modeled at the group level, not the rule. Seeded rules are then **editable beyond SVCVc** (anchoring, lead time, grouping, blackout, after-completion) — the overlay, kept app-side (consistent with `COVc` read-only).

`lib/domain/recurrence.ts` (P2-WS2, 19 tests green) is the **SVCVc primitive** — one matrix row's date projection with the correct first-occurrence formula, 3-way weekends, and negative Initial Days — used to seed/cross-check; the production scheduler delegates to the copied engine.

## 7. Generation with the overlay (P2-WS2)

1. Cron materializer (copy calendar's) scans active, non-paused rules; materializes due dates within `[now, horizon + leadDays]`, honoring end conditions, the blackout calendar, and the weekend mode; **records them as queryable state** (feeds §4).
2. Each due occurrence → a **1:1 activity/booking per service item** (the ERP activity has dedicated item fields), written to `ActVc` via the P1 writers. **Consolidation into a ServiceOrder happens here, at generation** (per `groupBy`) — co-due items at a site merge into one order while their bookings stay per-item. **App-side generation, ERP sees it identically** (owner 2026-07-14); echo-suppressed; cancel → void-in-place. (Customers run herbe.service, not the ERP agreement maintenance, so there's no dual-generation — §2.)
3. `after_completion`: on completion, bump the anchor → next service scheduled from the completion date.
4. Idempotent via `materialized_count` / pending-date diffing — re-runs never duplicate a cycle.

## 8. What to prioritize (opinionated)

1. **Projection-first schedule surface (§4)** — the owner's stated main challenge. See 12+ months from the rules with no materialization; change = edit a rule/occurrence. This *is* the headline value.
2. **Automatic near-term materialization** (§4.2) — kill the manual "generate tomorrow's orders" step.
3. **Reuse `repeatRules` — default `regularly` (calendar-driven)**, since most service is fixed-cadence (quarterly/yearly/monthly, owner 2026-07-15); `after_completion` is the secondary mode. Plus the SVCVc seed mapping.
4. **Reassignment via an embedded herbe.calendar team view** (§4.4) + lead-time/generate-ahead + order-level consolidation.
5. **Holiday/blackout calendar; coverage rotation (n-of-m); catch-up + pause/suspend.**

Defer to Phase 3: usage/meter-based triggers; assignment auto-suggest (rides Phase-3 scheduling-assist, `06`).

## 9. Open questions for the owner

1. **Holiday/blackout source** — per-country public-holiday set, per-customer blackout windows, or both?
2. **`repeatRules` reuse mechanism** — copy-first, or extract a shared `@herbe/repeat` package (default copy-first per `22` §6)?
3. **Embedded calendar view** — is a herbe.calendar team view embedded in the service app the intended reassignment surface (§4.4)? If so it needs a calendar-team conversation (candidate CAL-* ask, `13`).

*Resolved 2026-07-15:* generation is app-side, customers don't run the ERP agreement maintenance (§2); default mode is **`regularly`** (calendar-driven — most service is quarterly/yearly/monthly); grouping consolidates **at ServiceOrder creation**, bookings stay 1:1 per item (§6); herbe.service never invoices (§2).
