import { describe, it, expect } from 'vitest';
import { canTransitionWorksheet, assertWorksheetTransition, isTerminalWorksheet, DomainTransitionError } from '@/lib/domain/worksheet-status';

describe('worksheet status machine', () => {
  it('allows the happy path Draft→Assigned→Accepted→In progress→Done→Approved→Synced', () => {
    const path = ['Draft','Assigned','Accepted','In progress','Done','Approved','Synced'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransitionWorksheet(path[i], path[i + 1])).toBe(true);
  });
  it('allows In progress↔Paused and Paused→Done', () => {
    expect(canTransitionWorksheet('In progress', 'Paused')).toBe(true);
    expect(canTransitionWorksheet('Paused', 'In progress')).toBe(true);
    expect(canTransitionWorksheet('Paused', 'Done')).toBe(true);
  });
  it('allows Rejected from In progress/Paused/Done and re-entry to In progress', () => {
    expect(canTransitionWorksheet('In progress', 'Rejected')).toBe(true);
    expect(canTransitionWorksheet('Paused', 'Rejected')).toBe(true);
    expect(canTransitionWorksheet('Done', 'Rejected')).toBe(true);
    expect(canTransitionWorksheet('Rejected', 'In progress')).toBe(true);
  });
  it('rejects illegal jumps (Draft→Approved, Synced→anything)', () => {
    expect(canTransitionWorksheet('Draft', 'Approved')).toBe(false);
    expect(canTransitionWorksheet('Synced', 'Draft')).toBe(false);
  });
  it('assertWorksheetTransition throws DomainTransitionError on an illegal move', () => {
    expect(() => assertWorksheetTransition('Draft', 'Synced')).toThrow(DomainTransitionError);
  });
  it('assertWorksheetTransition does not throw on a legal move', () => {
    expect(() => assertWorksheetTransition('Draft', 'Assigned')).not.toThrow();
  });
  it('isTerminalWorksheet distinguishes Rejected (re-entrant) from Synced (terminal)', () => {
    expect(isTerminalWorksheet('Rejected')).toBe(false);
    expect(isTerminalWorksheet('Synced')).toBe(true);
  });
});
