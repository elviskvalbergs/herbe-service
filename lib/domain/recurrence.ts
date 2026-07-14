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
// SVCVc cadence fields (verified via halocron list_registers("SVCVc")):
//   DaysFromStart — days after the contract start to the FIRST occurrence
//   DaysBetween   — days between consecutive occurrences
//   NrOfTimes     — number of occurrences to schedule
//   Weekends      — whether an occurrence may fall on a weekend
//
// ASSUMPTIONS (the ERP knowledge base has no indexed generation algorithm, so
// these follow standard HansaWorld semantics — CONFIRM with the owner / a live
// ERP probe before this drives real order creation):
//   1. NrOfTimes <= 0  → open-ended: generate every occurrence inside the
//      horizon window (no finite cap).
//   2. Weekends = false → a nominal date landing on Sat/Sun is pushed FORWARD
//      to the following Monday. Weekends = true → dates are kept as-is.
//   3. DaysBetween is a fixed DAY COUNT, so a "yearly" cadence set as 365 days
//      DRIFTS by a day across each leap year (SVCVc has no calendar-aware
//      "same date each year" option). If calendar-anniversary cadence is
//      wanted, that is an app-overlay extra, not an SVCVc field.
//   4. DaysBetween <= 0 → a single occurrence (guards against an infinite
//      same-day schedule).
// Intervals are measured on the NOMINAL schedule; each occurrence is
// weekend-adjusted independently, so a shift never drifts later occurrences.

/** An ERP service level's recurring cadence (SVCVc). */
export interface ServiceCadence {
  /** SVCVc.DaysFromStart — offset from the contract start to the first occurrence. */
  daysFromStart: number;
  /** SVCVc.DaysBetween — interval in days between occurrences (<= 0 → single occurrence). */
  daysBetween: number;
  /** SVCVc.NrOfTimes — occurrence count (<= 0 → open-ended, horizon-bounded). */
  nrOfTimes: number;
  /** SVCVc.Weekends — true keeps weekend dates; false shifts them to the next Monday. */
  weekends: boolean;
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

/** Push Sat/Sun forward to Monday when weekends are disallowed (assumption 2). */
function adjustWeekend(day: number, weekends: boolean): number {
  if (weekends) return day;
  const dow = new Date(day * MS_PER_DAY).getUTCDay(); // 0 = Sun … 6 = Sat
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

  const firstNominal = toEpochDay(window.start) + daysFromStart;
  const singleOnly = daysBetween <= 0; // assumption 4
  const openEnded = nrOfTimes <= 0; // assumption 1

  const out: string[] = [];
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!openEnded && i >= nrOfTimes) break;
    const nominal = firstNominal + (singleOnly ? 0 : i * daysBetween);
    // A shift only moves a date forward, so once the nominal date passes the
    // horizon end no later occurrence can fall inside it — safe to stop.
    if (nominal > toDay) break;
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
