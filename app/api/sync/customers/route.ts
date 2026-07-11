// app/api/sync/customers/route.ts
//
// Task 16: the domain delta feed the PWA shell's sync client
// (lib/offline/sync-client.ts) pulls from. Session-gated the same way Task
// 14 gated POST /api/sync/outbox — this exposes a tenant's customer data to
// a device, so an unauthenticated request must 401 before any query runs.
//
// Delta is by change_seq (Task 11's monotonic column, bumped by the
// bump_change_seq() trigger): rows with changeSeq > "after", scoped to
// tenantId. changeSeq is a Postgres bigint (mode: 'bigint' in the drizzle
// schema) and JSON.stringify cannot serialize a raw bigint, so rows are
// mapped down to the client's CustomerRecord shape (lib/offline/db.ts) with
// changeSeq coerced to a string.
import { gt, and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { auth } from '@/lib/auth'

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user) {
    return new Response('Unauthorized', { status: 401 })
  }

  const url = new URL(request.url)
  const after = BigInt(url.searchParams.get('after') ?? '0')
  const tenantId = url.searchParams.get('tenantId')!

  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, tenantId), gt(schema.customers.changeSeq, after)))
    .orderBy(schema.customers.changeSeq)

  const cursor = rows.length ? String(rows[rows.length - 1].changeSeq) : String(after)

  const data = rows.map((row) => ({
    id: row.id,
    erpRef: row.erpRef,
    name: row.name,
    changeSeq: String(row.changeSeq),
  }))

  return Response.json({ data, cursor })
}
