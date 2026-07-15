// lib/domain/stores/history.ts
//
// Store for the HistoryEvent projection (lib/domain/history-projector.ts).
// upsertHistoryEvents is the DB-side half of the projector's idempotency:
// UNIQUE (tenant_id, key) (0013_history_events.sql) + onConflictDoNothing
// means re-running the projector for a worksheet revision already recorded
// inserts nothing new — no read-before-write race, no duplicate rows.
// getHistoryForItem is tenant-scoped, following the customers/items/
// service-items store idiom (lib/domain/stores/service-items.ts).
import { and, asc, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { HistoryEventRow } from '@/drizzle/schema'
import type { HistoryEvent } from '@/lib/domain/types'

type Db = PostgresJsDatabase<typeof schema>

export async function upsertHistoryEvents(db: Db, tenantId: string, events: HistoryEvent[]): Promise<void> {
  if (events.length === 0) return

  await db
    .insert(schema.historyEvents)
    .values(
      events.map((event) => ({
        tenantId,
        serviceItemId: event.serviceItemId,
        key: event.key,
        at: new Date(event.at),
        kind: event.kind,
        summary: event.summary,
        orderId: event.orderId,
        worksheetId: event.worksheetId,
        coverageCovered: event.coverage?.covered,
        coverageOf: event.coverage?.of,
      })),
    )
    .onConflictDoNothing({ target: [schema.historyEvents.tenantId, schema.historyEvents.key] })
}

export async function getHistoryForItem(db: Db, tenantId: string, serviceItemId: string): Promise<HistoryEventRow[]> {
  return db
    .select()
    .from(schema.historyEvents)
    .where(and(eq(schema.historyEvents.tenantId, tenantId), eq(schema.historyEvents.serviceItemId, serviceItemId)))
    // `at` can be null (see mapHistoryEvent's `at ?? createdAt` fallback) —
    // coalesce to createdAt here so ordering matches what the mapper renders,
    // rather than pushing null-`at` rows to the end regardless of createdAt.
    .orderBy(asc(sql`coalesce(${schema.historyEvents.at}, ${schema.historyEvents.createdAt})`))
}
