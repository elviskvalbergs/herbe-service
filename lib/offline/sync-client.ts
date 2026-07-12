// lib/offline/sync-client.ts
//
// Pulls a tenant-scoped delta from GET /api/sync/customers and upserts it
// into the local Dexie cache. Phase-0 is upsert-only — no scope-exit purge
// handling (Task 22 adds that later).
//
// Task 16b: tenantId is no longer sent by the client — the server derives it
// from the authenticated session (a client-supplied tenantId was the IDOR
// two reviews flagged).
import type { OfflineDb } from './db'

export async function pullDelta(
  db: OfflineDb,
  opts: { sinceCursor: string },
): Promise<{ cursor: string }> {
  const res = await fetch(`/api/sync/customers?after=${opts.sinceCursor}`)
  const body = await res.json()

  if (body.data.length) {
    await db.customers.bulkPut(body.data)
  }

  return { cursor: body.cursor }
}
