import { describe, it, expect } from 'vitest';
import { toCustomerOrderStatus } from '@/lib/domain/customer-order-status';
import type { OrderStatus } from '@/lib/domain/types';

describe('toCustomerOrderStatus (9→6 customer-visible projection, docs/08:71)', () => {
  it('New → received', () => {
    expect(toCustomerOrderStatus('New')).toBe('received');
  });
  it('Accepted → received', () => {
    expect(toCustomerOrderStatus('Accepted')).toBe('received');
  });
  it('Planned → scheduled', () => {
    expect(toCustomerOrderStatus('Planned')).toBe('scheduled');
  });
  it('In progress → in_progress', () => {
    expect(toCustomerOrderStatus('In progress')).toBe('in_progress');
  });
  it('Work done → work_done', () => {
    expect(toCustomerOrderStatus('Work done')).toBe('work_done');
  });
  it('Confirmed → work_done', () => {
    expect(toCustomerOrderStatus('Confirmed')).toBe('work_done');
  });
  it('Invoiced → completed', () => {
    expect(toCustomerOrderStatus('Invoiced')).toBe('completed');
  });
  it('Closed → completed', () => {
    expect(toCustomerOrderStatus('Closed')).toBe('completed');
  });
  it('Cancelled → cancelled', () => {
    expect(toCustomerOrderStatus('Cancelled')).toBe('cancelled');
  });

  it('covers every OrderStatus member exhaustively', () => {
    const allStates: OrderStatus[] = [
      'New', 'Accepted', 'Planned', 'In progress',
      'Work done', 'Confirmed', 'Invoiced', 'Closed', 'Cancelled',
    ];
    for (const s of allStates) {
      expect(() => toCustomerOrderStatus(s)).not.toThrow();
      expect(toCustomerOrderStatus(s)).toEqual(expect.any(String));
    }
  });
});
