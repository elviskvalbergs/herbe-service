// lib/domain/worksheet-status-labels.ts
//
// Task 5 (WS9-F4 minimal execution screen): maps every WorksheetStatus to
// its message key in the 'worksheet_execution' i18n namespace (locales/*.json).
// Shared by app/(field)/jobs/page.tsx (list) and app/(field)/jobs/[id]/page.tsx
// (detail) — pulled out to its own module rather than one page importing the
// other's export, or duplicating the map twice.
//
// This is display-key data, not transition logic — lib/domain/worksheet-status.ts
// stays pure/ERP-independent with no i18n concern; this module is the UI-facing
// companion to it. Exhaustive (Record over the full WorksheetStatus union) so a
// status added to the union without a translation key is a compile error, not a
// blank label at runtime.
import type { WorksheetStatus } from '@/lib/domain/types'

export const STATUS_LABEL_KEYS: Record<WorksheetStatus, string> = {
  Draft: 'status_draft',
  Assigned: 'status_assigned',
  Accepted: 'status_accepted',
  'In progress': 'status_in_progress',
  Paused: 'status_paused',
  Done: 'status_done',
  Approved: 'status_approved',
  Synced: 'status_synced',
  Rejected: 'status_rejected',
}
