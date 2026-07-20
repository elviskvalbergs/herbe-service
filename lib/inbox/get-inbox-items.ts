// lib/inbox/get-inbox-items.ts
//
// doc07 F10 "Inbox" — conflict tasks (bounced transitions, sync rejections).
// Task 8's only real source today is outbox_ops rows the ERP push rejected
// (status = 'failed', app/api/sync/outbox/route.ts). outbox_ops has a
// tenantId column but no userId (confirmed in drizzle/schema.ts) — so this
// is a tenant-scoped inbox, not truly a per-user one, despite the name.
// Known limitation (matches the brief): a real per-user inbox needs
// outbox_ops (or whatever queues the write) to carry attribution, which it
// doesn't yet. `tenantId` is passed in rather than resolved here so the
// caller (the page) stays the one place session data is read, same as
// lib/offline/briefcase-summary.ts's getBriefcaseSummary.
//
// Structured as collect-from-sources -> merge -> sort so a second source
// (e.g. rejected-worksheet tasks, once WS8/WS9 build that persistence) can
// be appended to the `sources` array below without touching the merge/sort
// logic — not a plugin registry, just enough seams for a second array.
import { and, desc, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

export interface InboxItem {
  id: string
  entity: string
  op: string
  errorMessage: string | null
  createdAt: Date
}

async function getFailedOutboxItems(db: Db, tenantId: string): Promise<InboxItem[]> {
  return db
    .select({
      id: schema.outboxOps.id,
      entity: schema.outboxOps.entity,
      op: schema.outboxOps.op,
      errorMessage: schema.outboxOps.errorMessage,
      createdAt: schema.outboxOps.createdAt,
    })
    .from(schema.outboxOps)
    .where(and(eq(schema.outboxOps.tenantId, tenantId), eq(schema.outboxOps.status, 'failed')))
    .orderBy(desc(schema.outboxOps.createdAt))
}

export async function getInboxItemsForUser(db: Db, tenantId: string): Promise<InboxItem[]> {
  const sources = await Promise.all([getFailedOutboxItems(db, tenantId)])
  return sources.flat().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}
