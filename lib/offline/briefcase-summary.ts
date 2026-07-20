// lib/offline/briefcase-summary.ts
//
// WS1 Task 7 (doc07 F11 "More" — the "download my work" briefcase). Computes
// today's real scope buckets against Postgres — the two things this repo
// already tracks per-user/per-tenant:
//   - scope_membership: rows currently in scope for the signed-in user
//     (outScopeSeq IS NULL — not yet purged, Task 22 03-architecture.md
//     "Scoped replication").
//   - outbox_ops: the TENANT's pending (not yet applied/failed) queued
//     writes (Task 13). Note this table has no userId column — it is
//     tenant-scoped, not per-user, so this bucket reads as "your tenant's
//     pending syncs", not "yours alone".
//
// Deliberately NOT included: a Dexie (client-side IndexedDB) cached-customers
// bucket. lib/offline/db.ts's OfflineDb lives only in the browser — a server
// data-loader has no way to read it. Wiring that in would need a separate
// 'use client' sub-component merging its own count into this loader's
// buckets client-side; deferred as a follow-on wiring detail (see task-7
// report) rather than forced in here.
import { and, eq, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { BriefcaseBucket } from '@/components/briefcase-summary'

type Db = PostgresJsDatabase<typeof schema>

export async function getBriefcaseSummary(
  db: Db,
  opts: { userId: string; tenantId: string },
): Promise<BriefcaseBucket[]> {
  const scopeRows = await db
    .select({ id: schema.scopeMembership.id })
    .from(schema.scopeMembership)
    .where(and(eq(schema.scopeMembership.userId, opts.userId), isNull(schema.scopeMembership.outScopeSeq)))

  const pendingRows = await db
    .select({ id: schema.outboxOps.id })
    .from(schema.outboxOps)
    .where(and(eq(schema.outboxOps.tenantId, opts.tenantId), eq(schema.outboxOps.status, 'pending')))

  return [
    { label: 'Assigned to you', count: scopeRows.length },
    { label: 'Pending sync', count: pendingRows.length },
  ]
}
