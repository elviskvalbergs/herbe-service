// lib/domain/recurrence.ts
//
// Phase 2 (P2-WS2) recurring-service generation — the pure cadence → due-date
// core. Given an ERP service level (SVCVc) and a horizon window, project the
// scheduled service dates. Owner decision 2026-07-14: generation is app-side
// logic; a later slice turns each due date into a ServiceOrder + Booking and
// pushes the ActVc so the ERP sees it identically (docs/22 §4 P2-WS2). This
// module is that decision's pure, side-effect-free heart — no I/O, no clock;
// every date is an input, so it is fully deterministic and TDD-able.
//
// This models ONE SVCVc matrix row. A full Service Agreement is a *sequence* of
// rows (each its own Act.Type / Persons / No.of Times / Days Between), which the
// overlay composes as several of these — see docs/23-recurring-service-overlay.md.
//
// SVCVc fields (per the Service Agreements register, owner-confirmed 2026-07-15):
//   DaysFromStart — "Initial Days": extra offset on the FIRST interval; may be
//                   NEGATIVE. First occurrence = Start + Initial Days + Days Between
//                   (e.g. 7 + 60 = 67 days after Start; -30 + 60 = 30 days after).
//   DaysBetween   — minimum days between services (a spacer); 0 in a later row means
//                   "same date as the prior row" (sequence-level; a lone row uses #4)
//   NrOfTimes     — occurrences of this row per cycle. NOTE: in a full agreement the
//                   ERP loops the row-sequence until the Contract End Date, so
//                   NrOfTimes is per-cycle; this primitive treats it as a plain cap
//                   and leaves the cross-row cycle-repeat to the overlay (docs/23).
//   Weekends      — 3-way: Ignore / Before (→ Friday) / After (→ Monday)
//
// SEMANTICS (owner-confirmed 2026-07-15):
//   1. NrOfTimes <= 0  → open-ended: generate every occurrence inside the
//      horizon window (no finite cap).
//   2. Weekends is 3-way: 'ignore' keeps the date; 'before' moves Sat/Sun back
//      to Friday; 'after' moves them forward to Monday. The next DaysBetween is
//      counted from the ORIGINAL (nominal) date, not the shifted one.
//   3. DaysBetween is the MINIMUM number of days between services, as a plain
//      day count. Leap-year drift of a day-count cadence is acceptable (owner:
//      "leap year doesn't matter"); calendar-anchored schedules ("same date
//      each year", "first Monday") are an app-overlay concern, not an SVCVc
//      field — see docs/23-recurring-service-overlay.md.
//   4. DaysBetween <= 0 → a single occurrence (guards against an infinite
//      same-day schedule).
// Intervals are measured on the NOMINAL schedule; each occurrence is
// weekend-adjusted independently, so a shift never drifts later occurrences.
//
// This module is the SVCVc *primitive* — the ERP-cadence → date projector.
// Production recurring-service scheduling adopts the suite repeat engine
// (herbe.calendar lib/repeatRules.ts, copy-first), which adds after-completion
// mode, calendar anchoring and correct month/year clamping on top of this
// baseline (docs/23 §3-4). SVCVc seeds an app-owned ServiceScheduleRule.

/** SVCVc.Weekends — how a date landing on a weekend is moved (ERP: Ignore/Before/After). */
export type WeekendMode = 'ignore' | 'before' | 'after';

/** An ERP service level's recurring cadence — one SVCVc matrix row (see module header). */
export interface ServiceCadence {
  /** SVCVc.DaysFromStart (Initial Days) — offset to the first occurrence; may be NEGATIVE. */
  daysFromStart: number;
  /** SVCVc.DaysBetween — minimum days between services, a spacer (<= 0 → single occurrence). */
  daysBetween: number;
  /** SVCVc.NrOfTimes — occurrence count (<= 0 → open-ended, horizon-bounded). */
  nrOfTimes: number;
  /** SVCVc.Weekends — 'ignore' keeps the date; 'before' → Friday; 'after' → Monday. */
  weekends: WeekendMode;
}

/** The contract start plus the horizon [from, to] to generate within (all `YYYY-MM-DD`). */
export interface DueDateWindow {
  /** Contract/agreement start date, `YYYY-MM-DD`. */
  start: string;
  /** Horizon start, inclusive, `YYYY-MM-DD`. */
  from: string;
  /** Horizon end, inclusive, `YYYY-MM-DD`. */
  to: string;
}

const MS_PER_DAY = 86_400_000;
// Backstop for open-ended cadences with pathological inputs (never hit in practice).
const MAX_ITERATIONS = 100_000;

function toEpochDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function fromEpochDay(day: number): string {
  const dt = new Date(day * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Move a weekend date per the SVCVc Weekends mode (semantics 2). */
function adjustWeekend(day: number, mode: WeekendMode): number {
  if (mode === 'ignore') return day;
  const dow = new Date(day * MS_PER_DAY).getUTCDay(); // 0 = Sun … 6 = Sat
  if (mode === 'before') {
    if (dow === 6) return day - 1; // Sat → Fri
    if (dow === 0) return day - 2; // Sun → Fri
    return day;
  }
  // 'after'
  if (dow === 6) return day + 2; // Sat → Mon
  if (dow === 0) return day + 1; // Sun → Mon
  return day;
}

/**
 * Project the scheduled service dates for a cadence within the horizon window.
 * Deterministic and pure — dates in, dates out, no clock. Returns `YYYY-MM-DD`
 * strings in ascending occurrence order (see module header for the rules).
 */
export function projectDueDates(cadence: ServiceCadence, window: DueDateWindow): string[] {
  const { daysFromStart, daysBetween, nrOfTimes, weekends } = cadence;
  const fromDay = toEpochDay(window.from);
  const toDay = toEpochDay(window.to);
  if (fromDay > toDay) return [];

  // ERP formula: occurrence[i] = Start + Initial Days + (i+1)·Days Between, so the
  // FIRST activity is one full interval out (Start + Initial Days + Days Between),
  // not at Start + Initial Days. (HansaManuals + owner example: 7 + 60 = 67 days.)
  const base = toEpochDay(window.start) + daysFromStart;
  const singleOnly = daysBetween <= 0; // assumption 4
  const openEnded = nrOfTimes <= 0; // assumption 1

  const out: string[] = [];
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!openEnded && i >= nrOfTimes) break;
    const nominal = base + (singleOnly ? 0 : (i + 1) * daysBetween);
    // A 'before' shift can pull a date up to 2 days back, so a nominal date just
    // past the horizon end can still land inside it — widen the cutoff by 2.
    if (nominal > toDay + 2) break;
    const adjusted = adjustWeekend(nominal, weekends);
    if (adjusted >= fromDay && adjusted <= toDay) out.push(fromEpochDay(adjusted));
    if (singleOnly) break;
  }
  return out;
}

/**
 * Idempotent generation: the projected due dates minus those already generated.
 * A recurring-generation run replays this and creates only the pending dates,
 * so re-running the same window never produces a duplicate cycle.
 */
export function pendingDueDates(
  cadence: ServiceCadence,
  window: DueDateWindow,
  alreadyGenerated: string[],
): string[] {
  const done = new Set(alreadyGenerated);
  return projectDueDates(cadence, window).filter((d) => !done.has(d));
}
