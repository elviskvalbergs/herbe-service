import { describe, it, expect } from 'vitest';
import {
  projectDueDates,
  pendingDueDates,
  type ServiceCadence,
  type DueDateWindow,
} from '@/lib/domain/recurrence';

// A horizon wide enough to capture everything unless a test narrows it.
const WIDE = { from: '2000-01-01', to: '2099-12-31' } satisfies Pick<DueDateWindow, 'from' | 'to'>;

// Default = a 30-day cadence ×3, weekends ignored. First occurrence = start + 30.
const svc = (over: Partial<ServiceCadence> = {}): ServiceCadence => ({
  daysFromStart: 0,
  daysBetween: 30,
  nrOfTimes: 3,
  weekends: 'ignore',
  ...over,
});

describe('projectDueDates — first occurrence (ERP: Start + Initial Days + Days Between)', () => {
  it('first occurrence is one full interval out, not at Start + Initial Days', () => {
    expect(projectDueDates(svc({ nrOfTimes: 1 }), { start: '2026-01-01', ...WIDE })).toEqual(['2026-01-31']);
  });

  it('Initial Days is an extra offset on that first interval (7 + 60 = 67 days)', () => {
    expect(
      projectDueDates({ daysFromStart: 7, daysBetween: 60, nrOfTimes: 1, weekends: 'ignore' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-03-09']); // 2026-01-01 + 67
  });

  it('negative Initial Days pulls the first occurrence earlier (-30 + 60 = 30 days)', () => {
    expect(
      projectDueDates({ daysFromStart: -30, daysBetween: 60, nrOfTimes: 1, weekends: 'ignore' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-31']); // 2026-01-01 + 30
  });
});

describe('projectDueDates — cadence projection', () => {
  it('projects NrOfTimes occurrences DaysBetween apart', () => {
    expect(projectDueDates(svc(), { start: '2026-01-01', ...WIDE })).toEqual([
      '2026-01-31',
      '2026-03-02',
      '2026-04-01',
    ]);
  });

  it('caps at NrOfTimes even with an unbounded horizon', () => {
    expect(projectDueDates(svc({ nrOfTimes: 2 }), { start: '2026-01-01', ...WIDE })).toEqual([
      '2026-01-31',
      '2026-03-02',
    ]);
  });

  it('treats NrOfTimes <= 0 as open-ended, bounded only by the horizon', () => {
    expect(
      projectDueDates(svc({ nrOfTimes: 0 }), { start: '2026-01-01', from: '2026-01-01', to: '2026-03-15' }),
    ).toEqual(['2026-01-31', '2026-03-02']); // the +90 occurrence (2026-04-01) is past 'to'
  });

  it('DaysBetween is a plain day count, so a 365-day cadence drifts across a leap year (accepted)', () => {
    // +365=2027-01-01, +730=2028-01-01, +1095=2028-12-31 (2028 leap → drift; accepted, owner 2026-07-15).
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 365, nrOfTimes: 3, weekends: 'ignore' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2027-01-01', '2028-01-01', '2028-12-31']);
  });

  it('honors the horizon window (inclusive), dropping out-of-range occurrences', () => {
    expect(projectDueDates(svc(), { start: '2026-01-01', from: '2026-03-01', to: '2026-03-31' })).toEqual([
      '2026-03-02',
    ]); // 2026-01-31 before 'from', 2026-04-01 after 'to'
  });

  it('includes an occurrence that lands exactly on the from and to boundary', () => {
    expect(projectDueDates(svc(), { start: '2026-01-01', from: '2026-01-31', to: '2026-01-31' })).toEqual([
      '2026-01-31',
    ]);
  });

  it('returns nothing when the horizon window is empty (from > to)', () => {
    expect(projectDueDates(svc(), { start: '2026-01-01', from: '2030-01-01', to: '2029-01-01' })).toEqual([]);
  });

  it('collapses to a single occurrence when DaysBetween <= 0 (at Start + Initial Days)', () => {
    expect(
      projectDueDates({ daysFromStart: 10, daysBetween: 0, nrOfTimes: 5, weekends: 'ignore' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-11']);
  });
});

describe('projectDueDates — weekend handling (3-way)', () => {
  it("'after' shifts Sat/Sun forward to the following Monday", () => {
    // base 2026-01-01 (Thu): +2 = Sat 2026-01-03 → Mon; +3 = Sun 2026-01-04 → Mon.
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 2, nrOfTimes: 1, weekends: 'after' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-05']);
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 3, nrOfTimes: 1, weekends: 'after' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-05']);
  });

  it("'before' shifts Sat/Sun back to the preceding Friday", () => {
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 2, nrOfTimes: 1, weekends: 'before' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-02']);
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 3, nrOfTimes: 1, weekends: 'before' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-02']);
  });

  it("'ignore' keeps weekend dates as-is", () => {
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 2, nrOfTimes: 1, weekends: 'ignore' }, { start: '2026-01-01', ...WIDE }),
    ).toEqual(['2026-01-03']); // Saturday stays
  });

  it('measures DaysBetween on nominal dates; weekend shifts do not drift the schedule', () => {
    // base Sat 2026-01-03: +7/+14/+21 = Sat 10/17/24 → 'after' → Mon 12/19/26 (still 7 apart).
    expect(
      projectDueDates({ daysFromStart: 0, daysBetween: 7, nrOfTimes: 3, weekends: 'after' }, { start: '2026-01-03', ...WIDE }),
    ).toEqual(['2026-01-12', '2026-01-19', '2026-01-26']);
  });

  it("'before' pulls a nominal date from past 'to' back into the horizon", () => {
    // base 2026-01-01: +9 = Sat 2026-01-10, PAST to = Fri 2026-01-09; 'before' → Fri 2026-01-09 = to.
    // Exercises the +2 loop-cutoff widening so the occurrence isn't dropped.
    expect(
      projectDueDates(
        { daysFromStart: 0, daysBetween: 9, nrOfTimes: 1, weekends: 'before' },
        { start: '2026-01-01', from: '2026-01-01', to: '2026-01-09' },
      ),
    ).toEqual(['2026-01-09']);
  });
});

describe('pendingDueDates — idempotent generation', () => {
  it('excludes occurrences already generated', () => {
    expect(
      pendingDueDates(svc(), { start: '2026-01-01', ...WIDE }, ['2026-01-31', '2026-03-02']),
    ).toEqual(['2026-04-01']);
  });

  it('returns all projected dates when none generated yet', () => {
    expect(pendingDueDates(svc(), { start: '2026-01-01', ...WIDE }, [])).toEqual([
      '2026-01-31',
      '2026-03-02',
      '2026-04-01',
    ]);
  });

  it('is a no-op (empty) once every occurrence has been generated', () => {
    expect(
      pendingDueDates(svc(), { start: '2026-01-01', ...WIDE }, ['2026-01-31', '2026-03-02', '2026-04-01']),
    ).toEqual([]);
  });
});
