// lib/domain/history-projector.ts
//
// The HistoryEvent projector (docs/02-data-model.md "HistoryEvent (service
// history)"): pure logic, no I/O. "Production rules": every event carries a
// deterministic key (source record id + event type + revision) so
// re-running the projector for the same worksheet revision is idempotent.
// Key scheme: `${worksheetId}:work_done:${revision}` for the primary item's
// event, `${worksheetId}:covered:${revision}:${descendantId}` for each
// group-coverage projection onto a covered descendant.
import type { Coverage } from '@/lib/domain/coverage'
import { resolveCoveredIds } from '@/lib/domain/coverage'
import type { HistoryEvent } from '@/lib/domain/types'

export interface ProjectWorksheetApprovedInput {
  worksheetId: string
  orderId: string
  revision: number
  at: string
  primaryItemId: string
  /** Present when the worksheet targeted a system/lot group node — projects
   * a covered_by_group_service event onto each covered descendant. */
  groupCoverage?: { coverage: Coverage; memberIds: string[] }
  summary: string
}

export function projectWorksheetApproved(input: ProjectWorksheetApprovedInput): HistoryEvent[] {
  const { worksheetId, orderId, revision, at, primaryItemId, groupCoverage, summary } = input

  const events: HistoryEvent[] = [
    {
      key: `${worksheetId}:work_done:${revision}`,
      serviceItemId: primaryItemId,
      at,
      kind: 'work_done',
      summary,
      orderId,
      worksheetId,
    },
  ]

  if (groupCoverage) {
    const coveredIds = resolveCoveredIds(groupCoverage.coverage, groupCoverage.memberIds)
    const of = groupCoverage.memberIds.length
    for (const descendantId of coveredIds) {
      events.push({
        key: `${worksheetId}:covered:${revision}:${descendantId}`,
        serviceItemId: descendantId,
        at,
        kind: 'covered_by_group_service',
        summary,
        orderId,
        worksheetId,
        coverage: { covered: coveredIds.length, of },
      })
    }
  }

  return events
}

/** Idempotent-merge helper: keeps the first event seen for each key. The
 * projector is deterministic, so re-running it for the same input produces
 * events with identical keys — this collapses those duplicates, mirroring
 * what the store's onConflictDoNothing does at the DB layer. */
export function dedupeByKey(events: HistoryEvent[]): HistoryEvent[] {
  const seen = new Map<string, HistoryEvent>()
  for (const event of events) {
    if (!seen.has(event.key)) seen.set(event.key, event)
  }
  return [...seen.values()]
}
