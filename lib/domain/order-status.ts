// lib/domain/order-status.ts
//
// ServiceOrder status machine — pure, ERP-independent. Encodes the transition
// rules in docs/02-data-model.md:64-72: two states are human judgment
// (Work done — technician; Confirmed — manager), the rest derive or come
// from ERP sync. Precedence, highest first:
//   Closed (ERP: SVOVc.DoneMark) > Invoiced (ERP: linked IVVc) > Cancelled
//   > manual (Confirmed/Work done) > derived (In progress > Planned > New).
// This is the single server-side recompute — every worksheet/booking
// transition re-runs it. Rollback (adding a fresh worksheet to a
// Confirmed/Work-done order) is the caller's job: clear `manualState` before
// calling, and the derived tier takes over.

import type { OrderStatus, WorksheetStatus } from './types';

/** Draft/Assigned/Accepted: the only worksheet states that precede real work
 * starting, per the worksheet flow order in types.ts. Shared by canCancel and
 * worksheetsToCancelOnOrderCancel so the cancellation boundary can't drift
 * between the check and the cascade. */
const PRE_WORK_WORKSHEET_STATUSES: readonly WorksheetStatus[] = ['Draft', 'Assigned', 'Accepted'];

export function deriveOrderStatus(input: {
  manualState: 'Work done' | 'Confirmed' | null;
  erpState: 'Invoiced' | 'Closed' | null;
  cancelled: boolean;
  bookingCount: number;
  worksheets: WorksheetStatus[];
}): OrderStatus {
  if (input.erpState === 'Closed') return 'Closed';
  if (input.erpState === 'Invoiced') return 'Invoiced';
  if (input.cancelled) return 'Cancelled';
  if (input.manualState === 'Confirmed') return 'Confirmed';
  if (input.manualState === 'Work done') return 'Work done';

  const hasActiveWorksheet = input.worksheets.some((s) => s === 'In progress' || s === 'Paused');
  if (hasActiveWorksheet) return 'In progress';
  if (input.bookingCount > 0) return 'Planned';
  return 'New';
}

export function canSetManual(
  target: 'Work done' | 'Confirmed',
  worksheets: WorksheetStatus[],
): { ok: boolean; reason?: string } {
  if (target === 'Work done') return { ok: true };

  // Confirmed: manager review is done — requires every worksheet Approved,
  // and at least one worksheet to review in the first place.
  if (worksheets.length === 0) return { ok: false, reason: 'no worksheets to confirm' };
  if (!worksheets.every((s) => s === 'Approved')) {
    return { ok: false, reason: 'not all worksheets are Approved' };
  }
  return { ok: true };
}

export function canCancel(worksheets: WorksheetStatus[]): boolean {
  return worksheets.every((s) => PRE_WORK_WORKSHEET_STATUSES.includes(s));
}

export function worksheetsToCancelOnOrderCancel(
  worksheets: { id: string; status: WorksheetStatus }[],
): string[] {
  return worksheets
    .filter((w) => PRE_WORK_WORKSHEET_STATUSES.includes(w.status))
    .map((w) => w.id);
}
