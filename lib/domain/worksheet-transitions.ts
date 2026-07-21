// lib/domain/worksheet-transitions.ts
//
// Task 3 (docs/superpowers/sdd/task-3-brief.md): the non-approval worksheet
// status-change helper the booking/execution UI routes (Tasks 4-6) call.
// Does exactly: load current status -> assertWorksheetTransition(current,
// to) -> setWorksheetStatus(...). No technician/identity_links check, no
// push-group enqueue — that is approveWorksheet's job (lib/sync/push/
// enqueue.ts), which this module does not touch.
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { getWorksheetById, setWorksheetStatus } from '@/lib/domain/stores/worksheets'
import { assertWorksheetTransition, DomainTransitionError } from '@/lib/domain/worksheet-status'
import type { WorksheetStatus } from '@/lib/domain/types'

type Db = PostgresJsDatabase<typeof schema>

export async function transitionWorksheet(
  db: Db,
  tenantId: string,
  worksheetId: string,
  to: WorksheetStatus,
): Promise<void> {
  const worksheet = await getWorksheetById(db, tenantId, worksheetId)
  if (!worksheet) {
    throw new Error(`transitionWorksheet: worksheet ${worksheetId} not found`)
  }

  const current = worksheet.status as WorksheetStatus

  // Done -> Approved is a legal edge in the shared transition graph
  // (worksheet-status.ts), but Approved is reachable ONLY through
  // approveWorksheet: it also gates on the technician's identity_links
  // entry and enqueues the ERP push group, neither of which this generic
  // setter does. Refuse it here so a future caller can't silently bypass
  // that guard by calling the generic transition helper instead.
  if (to === 'Approved') {
    throw new DomainTransitionError(current, to)
  }

  assertWorksheetTransition(current, to)

  await setWorksheetStatus(db, tenantId, worksheetId, to)
}
