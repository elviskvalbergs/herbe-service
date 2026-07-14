// tests/unit/domain/history-projector.test.ts
//
// Pure logic — no DB, no I/O. Runs locally (unlike the store idempotency
// test in tests/unit/domain/history-store.test.ts, which needs Postgres).
import { describe, it, expect } from 'vitest';
import { projectWorksheetApproved, dedupeByKey } from '@/lib/domain/history-projector';

describe('projectWorksheetApproved', () => {
  it('emits one work_done event on the primary item with a deterministic key', () => {
    const ev = projectWorksheetApproved({ worksheetId: 'w1', orderId: 'o1', revision: 0, at: '2026-07-01T00:00:00Z', primaryItemId: 'i1', summary: 'Serviced' });
    expect(ev).toHaveLength(1);
    expect(ev[0].key).toBe('w1:work_done:0');
    expect(ev[0].kind).toBe('work_done');
    expect(ev[0].serviceItemId).toBe('i1');
  });
  it('projects a covered_by_group_service event onto each covered descendant', () => {
    const ev = projectWorksheetApproved({
      worksheetId: 'w2', orderId: 'o1', revision: 0, at: '2026-07-01T00:00:00Z', primaryItemId: 'grp',
      groupCoverage: { coverage: { mode: 'n_of_m', n: 2 }, memberIds: ['a', 'b', 'c'] }, summary: 'Zone service',
    });
    // one primary event + two covered descendants
    const covered = ev.filter((e) => e.kind === 'covered_by_group_service').map((e) => e.serviceItemId).sort();
    expect(covered).toEqual(['a', 'b']);
    expect(ev.find((e) => e.kind === 'covered_by_group_service')?.coverage).toEqual({ covered: 2, of: 3 });
  });
  it('re-running with the same input yields identical keys (idempotent)', () => {
    const input = { worksheetId: 'w1', orderId: 'o1', revision: 0, at: '2026-07-01T00:00:00Z', primaryItemId: 'i1', summary: 'x' };
    const a = projectWorksheetApproved(input);
    const b = projectWorksheetApproved(input);
    expect(dedupeByKey([...a, ...b]).length).toBe(a.length);
  });
});
