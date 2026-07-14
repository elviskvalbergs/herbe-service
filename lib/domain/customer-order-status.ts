// lib/domain/customer-order-status.ts
//
// Customer-visible 9→6 order-status projection. The internal 9-state order
// machine (lib/domain/types.ts OrderStatus, docs/02-data-model.md:62) is
// never exposed verbatim to the customer; this collapses it to the 6-state
// set frozen by docs/08-suite-integration.md:71 (matches the portal's
// customerOrderStatus enum, herbe-portal lib/service/dto.ts).

import type { OrderStatus } from './types';

export type CustomerOrderStatus =
  | 'received' | 'scheduled' | 'in_progress' | 'work_done' | 'completed' | 'cancelled';

const MAP: Record<OrderStatus, CustomerOrderStatus> = {
  'New': 'received',
  'Accepted': 'received',
  'Planned': 'scheduled',
  'In progress': 'in_progress',
  'Work done': 'work_done',
  'Confirmed': 'work_done',
  'Invoiced': 'completed',
  'Closed': 'completed',
  'Cancelled': 'cancelled',
};

export function toCustomerOrderStatus(s: OrderStatus): CustomerOrderStatus {
  return MAP[s];
}
