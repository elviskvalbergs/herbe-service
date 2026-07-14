// lib/domain/types.ts
//
// Shared vocabulary for the ERP-independent domain core (docs/02-data-model.md,
// docs/11-service-items-and-parts.md). Every Phase 1 domain module imports
// from here rather than redefining these unions locally.

export type NodeKind = 'system' | 'unit' | 'lot';

// 'Accepted' is set-only in this slice: deriveOrderStatus only derives New/Planned/In
// progress, so 'Accepted' is reachable only via the thin setOrderStatus until a later
// slice wires its trigger.
export type OrderStatus =
  | 'New' | 'Accepted' | 'Planned' | 'In progress'
  | 'Work done' | 'Confirmed' | 'Invoiced' | 'Closed' | 'Cancelled';

export type WorksheetStatus =
  | 'Draft' | 'Assigned' | 'Accepted' | 'In progress' | 'Paused'
  | 'Done' | 'Approved' | 'Synced' | 'Rejected';

export type ChargeType = 'invoiceable' | 'warranty' | 'contract' | 'goodwill';

/** Purpose key for an entity's ERP reference (erpRef is a set, not a scalar). */
export type ErpRefPurpose = 'primary' | 'worksheetShadow' | 'orderShadow' | 'workSegment';

export type HistoryEventKind =
  | 'work_done' | 'part_replaced' | 'measurement' | 'status_change'
  | 'covered_by_group_service' | 'erp_history';

export interface HistoryEvent {
  /** Deterministic idempotency key: `${sourceId}:${kind}:${revision}`. */
  key: string;
  serviceItemId: string;
  at: string; // ISO
  kind: HistoryEventKind;
  summary: string;
  orderId?: string;
  worksheetId?: string;
  coverage?: { covered: number; of: number };
}
