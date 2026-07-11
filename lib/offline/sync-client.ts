// lib/offline/sync-client.ts
//
// Pulls a tenant-scoped delta from GET /api/sync/customers and upserts it
// into the local Dexie cache. Phase-0 is upsert-only — no scope-exit purge
// handling (Task 22 adds that later).
import type { OfflineDb } from './db'

export async function pullDelta(
  db: OfflineDb,
  opts: { tenantId: string; sinceCursor: string },
): Promise<{ cursor: string }> {
  const res = await fetch(`/api/sync/customers?tenantId=${opts.tenantId}&after=${opts.sinceCursor}`)
  const body = await res.json()

  if (body.data.length) {
    await db.customers.bulkPut(body.data)
  }

  return { cursor: body.cursor }
}
