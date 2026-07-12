// lib/offline/sync-client.ts
//
// Pulls a tenant-scoped delta from GET /api/sync/customers and upserts it
// into the local Dexie cache. Task 22: also applies scope-exit purges —
// when the server response includes exitedIds (lib/sync/scope-membership.ts
// pullScopedDelta), those ids are locally deleted, mirroring the server's
// "record left your scope" signal as a client-side purge.
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

  if (body.exitedIds?.length) {
    await db.customers.bulkDelete(body.exitedIds)
  }

  return { cursor: body.cursor }
}
