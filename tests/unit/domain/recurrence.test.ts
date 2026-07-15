import { describe, it, expect } from 'vitest';
import {
  projectDueDates,
  pendingDueDates,
  type ServiceCadence,
  type DueDateWindow,
} from '@/lib/domain/recurrence';

// A horizon wide enough to capture everything unless a test narrows it.
const WIDE = { from: '2000-01-01', to: '2099-12-31' } satisfies Pick<DueDateWindow, 'from' | 'to'>;

// Default = a 3× "yearly" (365-day) cadence, weekends allowed.
const yearly = (over: Partial<ServiceCadence> = {}): ServiceCadence => ({
  daysFromStart: 0,
  daysBetween: 365,
  nrOfTimes: 3,
  weekends: true,
  ...over,
});

describe('projectDueDates — cadence projection', () => {
  it('first occurrence is start + daysFromStart', () => {
    expect(
      projectDueDates({ ...yearly(), daysFromStart: 30, nrOfTimes: 1 }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-31']);
  });

  it('projects NrOfTimes occurrences DaysBetween apart', () => {
    // 2026 and 2027 are non-leap, so 365-day steps land on Jan 1 each year here.
    expect(projectDueDates(yearly(), { start: '2026-01-01', ...WIDE })).toEqual([
      '2026-01-01',
      '2027-01-01',
      '2028-01-01',
    ]);
  });

  it('DaysBetween is a plain day count, so a 365-day cadence drifts across a leap year (accepted)', () => {
    // Occurrence 4 is 3×365 days after 2026-01-01; 2028 is a leap year → lands on 2028-12-31, not 2029-01-01.
    // SVCVc offers only day counts; this drift is acceptable (owner 2026-07-15). Calendar-anchored
    // ("same date each year") scheduling is the app overlay's job (docs/23), not this primitive's.
    expect(
      projectDueDates(yearly({ nrOfTimes: 0 }), { start: '2026-01-01', from: '2026-01-01', to: '2029-06-01' }),
    ).toEqual(['2026-01-01', '2027-01-01', '2028-01-01', '2028-12-31']);
  });

  it('honors the horizon window (inclusive), dropping out-of-range occurrences', () => {
    expect(
      projectDueDates(yearly(), { start: '2026-01-01', from: '2027-01-01', to: '2027-12-31' }),
    ).toEqual(['2027-01-01']);
  });

  it('caps at NrOfTimes even with an unbounded horizon', () => {
    expect(projectDueDates(yearly({ nrOfTimes: 2 }), { start: '2026-01-01', ...WIDE })).toEqual([
      '2026-01-01',
      '2027-01-01',
    ]);
  });

  it('treats NrOfTimes <= 0 as open-ended, bounded only by the horizon', () => {
    // ASSUMPTION (flagged for owner): NrOfTimes = 0 means "no finite cap".
    expect(
      projectDueDates(
        { daysFromStart: 0, daysBetween: 30, nrOfTimes: 0, weekends: true },
        { start: '2026-01-01', from: '2026-01-01', to: '2026-03-15' },
      ),
    ).toEqual(['2026-01-01', '2026-01-31', '2026-03-02']);
  });

  it('shifts weekend dates to the following Monday when weekends are disallowed', () => {
    // 2026-01-03 = Sat, 2026-01-04 = Sun → both → Mon 2026-01-05
    const cad: ServiceCadence = { daysFromStart: 0, daysBetween: 30, nrOfTimes: 1, weekends: false };
    expect(projectDueDates(cad, { start: '2026-01-03', ...WIDE })).toEqual(['2026-01-05']);
    expect(projectDueDates(cad, { start: '2026-01-04', ...WIDE })).toEqual(['2026-01-05']);
  });

  it('keeps weekend dates as-is when weekends are allowed', () => {
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 30, nrOfTimes: 1, weekends: true }, { start: '2026-01-03', ...WIDE }),
    ).toEqual(['2026-01-03']); // Saturday stays
  });

  it('measures DaysBetween on nominal dates; weekend shifts do not drift the schedule', () => {
    // Every 7 days from Sat 2026-01-03: nominal Sat 03,10,17 → each shifted to Mon 05,12,19 (still 7 apart).
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 7, nrOfTimes: 3, weekends: false }, { start: '2026-01-03', ...WIDE }),
    ).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
  });

  it('collapses to a single occurrence when DaysBetween <= 0 (guards against an infinite schedule)', () => {
    expect(
      projectDueDates({ daysFromStart: 10, daysBetween: 0, nrOfTimes: 5, weekends: true }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-11']);
  });

  it('returns nothing when the horizon window is empty (from > to)', () => {
    expect(projectDueDates(yearly(), { start: '2026-01-01', from: '2030-01-01', to: '2029-01-01' })).toEqual([]);
  });

  it('includes an occurrence that lands exactly on the from and to boundary', () => {
    expect(projectDueDates(yearly(), { start: '2026-01-01', from: '2027-01-01', to: '2027-01-01' })).toEqual([
      '2027-01-01',
    ]);
  });
});

describe('pendingDueDates — idempotent generation', () => {
  it('excludes occurrences already generated', () => {
    expect(
      pendingDueDates(yearly(), { start: '2026-01-01', ...WIDE }, ['2026-01-01', '2027-01-01']),
    ).toEqual(['2028-01-01']);
  });

  it('returns all projected dates when none generated yet', () => {
    expect(pendingDueDates(yearly(), { start: '2026-01-01', ...WIDE }, [])).toEqual([
      '2026-01-01',
      '2027-01-01',
      '2028-01-01',
    ]);
  });

  it('is a no-op (empty) once every occurrence has been generated', () => {
    expect(
      pendingDueDates(yearly(), { start: '2026-01-01', ...WIDE }, ['2026-01-01', '2027-01-01', '2028-01-01']),
    ).toEqual([]);
  });
});
