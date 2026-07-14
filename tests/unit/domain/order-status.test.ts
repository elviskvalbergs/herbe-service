import { describe, it, expect } from 'vitest';
import { deriveOrderStatus, canSetManual, canCancel, worksheetsToCancelOnOrderCancel } from '@/lib/domain/order-status';
import type { OrderStatus, WorksheetStatus } from '@/lib/domain/types';

type DeriveInput = Parameters<typeof deriveOrderStatus>[0];

const base: DeriveInput = { manualState: null, erpState: null, cancelled: false, bookingCount: 0, worksheets: [] };

describe('deriveOrderStatus — precedence: Closed > Invoiced > Cancelled > manual > derived', () => {
  it.each<[string, Partial<DeriveInput>, OrderStatus]>([
    [
      'Closed wins even with Invoiced-adjacent, cancelled, manual and active-worksheet state all present',
      { erpState: 'Closed', cancelled: true, manualState: 'Confirmed', worksheets: ['In progress'] },
      'Closed',
    ],
    [
      'Invoiced wins over cancelled, manual and active-worksheet state (but not Closed)',
      { erpState: 'Invoiced', cancelled: true, manualState: 'Work done', worksheets: ['In progress'] },
      'Invoiced',
    ],
    [
      'Cancelled wins over manual Confirmed',
      { cancelled: true, manualState: 'Confirmed', worksheets: ['Approved'] },
      'Cancelled',
    ],
    [
      'Cancelled wins over derived In progress',
      { cancelled: true, worksheets: ['In progress'] },
      'Cancelled',
    ],
    [
      'manual Confirmed wins over derived In progress',
      { manualState: 'Confirmed', worksheets: ['In progress'] },
      'Confirmed',
    ],
    [
      'manual Work done wins over derived Planned',
      { manualState: 'Work done', bookingCount: 1 },
      'Work done',
    ],
    [
      'derived In progress wins over derived Planned when a worksheet is In progress',
      { worksheets: ['In progress'], bookingCount: 1 },
      'In progress',
    ],
    [
      'derived In progress triggers on Paused too',
      { worksheets: ['Paused'], bookingCount: 1 },
      'In progress',
    ],
    [
      'derived Planned when a booking exists and no worksheet is active',
      { bookingCount: 1 },
      'Planned',
    ],
    [
      'derived Planned still holds with inactive (Done) worksheets present',
      { bookingCount: 1, worksheets: ['Done'] },
      'Planned',
    ],
    [
      'derived New when nothing has happened',
      {},
      'New',
    ],
    [
      'derived New when worksheets exist but none active and no booking',
      { worksheets: ['Draft', 'Synced'] },
      'New',
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(deriveOrderStatus({ ...base, ...overrides })).toBe(expected);
  });

  it('manual Confirmed is trusted as-is by the recompute (the guard lives in canSetManual, applied before the caller sets manualState)', () => {
    expect(deriveOrderStatus({ ...base, manualState: 'Confirmed', worksheets: ['Approved'] })).toBe('Confirmed');
  });

  it('rollback: caller clears manualState on a fresh worksheet, and the recompute derives In progress instead of staying Confirmed/Work done', () => {
    expect(deriveOrderStatus({ ...base, manualState: null, worksheets: ['In progress'] })).toBe('In progress');
  });
});

describe('canSetManual', () => {
  it('Work done is allowed regardless of worksheet states (technician decision)', () => {
    expect(canSetManual('Work done', ['In progress']).ok).toBe(true);
    expect(canSetManual('Work done', []).ok).toBe(true);
    expect(canSetManual('Work done', ['Rejected', 'Draft']).ok).toBe(true);
  });

  it('Confirmed requires ALL worksheets Approved', () => {
    expect(canSetManual('Confirmed', ['Approved', 'Approved']).ok).toBe(true);
    expect(canSetManual('Confirmed', ['Approved', 'Done']).ok).toBe(false);
  });

  it('Confirmed requires at least one worksheet — an empty list is not vacuously ok', () => {
    const result = canSetManual('Confirmed', []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('Confirmed rejection carries a reason', () => {
    const result = canSetManual('Confirmed', ['Approved', 'In progress']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe('canCancel — allowed only while no worksheet is beyond Accepted', () => {
  it('Draft/Assigned/Accepted are OK', () => {
    expect(canCancel(['Draft'])).toBe(true);
    expect(canCancel(['Assigned'])).toBe(true);
    expect(canCancel(['Accepted'])).toBe(true);
    expect(canCancel(['Accepted', 'Draft'])).toBe(true);
    expect(canCancel([])).toBe(true);
  });

  it.each<WorksheetStatus>(['In progress', 'Paused', 'Done', 'Approved', 'Synced', 'Rejected'])(
    '%s blocks cancellation',
    (status) => {
      expect(canCancel([status])).toBe(false);
      expect(canCancel(['Draft', status])).toBe(false);
    },
  );
});

describe('worksheetsToCancelOnOrderCancel', () => {
  it('auto-cancels Draft/Assigned/Accepted worksheets and excludes everything past Accepted', () => {
    expect(
      worksheetsToCancelOnOrderCancel([
        { id: 'w1', status: 'Draft' },
        { id: 'w2', status: 'Accepted' },
        { id: 'w3', status: 'In progress' },
      ]),
    ).toEqual(['w1', 'w2']);
  });

  it('includes Assigned and excludes Paused/Done/Approved/Synced/Rejected', () => {
    expect(
      worksheetsToCancelOnOrderCancel([
        { id: 'w1', status: 'Assigned' },
        { id: 'w2', status: 'Paused' },
        { id: 'w3', status: 'Done' },
        { id: 'w4', status: 'Approved' },
        { id: 'w5', status: 'Synced' },
        { id: 'w6', status: 'Rejected' },
      ]),
    ).toEqual(['w1']);
  });

  it('returns an empty list when there is nothing cancellable', () => {
    expect(worksheetsToCancelOnOrderCancel([{ id: 'w1', status: 'Synced' }])).toEqual([]);
  });

  it('returns an empty list for no worksheets', () => {
    expect(worksheetsToCancelOnOrderCancel([])).toEqual([]);
  });
});
