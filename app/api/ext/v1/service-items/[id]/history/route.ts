// app/api/ext/v1/service-items/[id]/history/route.ts
//
// GET /api/ext/v1/service-items/{id}/history — the history endpoint of the
// `/api/ext/v1` read API. Response is a BARE array (not `{ data }`-wrapped)
// — matches herbe-portal `lib/service/client.ts`'s
// `getServiceItemHistory: (id) => json(..., historyEventSchema.array())`.
//
// Scope-checks the item exactly like the detail route (same 404-not-403
// reasoning, same `resolveScopeCodes()`-with-nothing-to-narrow caveat for
// unrestricted tokens — see the comment in ../route.ts) before reading its
// history, so an out-of-scope id never leaks its history either.
//
// orderNumber is not resolved/joined here (mapHistoryEvent(row, orderNumber?)
// accepts it, but there's no order lookup wired into this route) — that's
// orders-store territory (Task 9), not a gap in this route.
import { db } from '@/lib/db'
import { verifyExtRequest } from '@/lib/api/ext/auth'
import { checkExtRateLimit } from '@/lib/api/ext/rate-limit'
import { resolveCustomerIdsByCodes } from '@/lib/domain/stores/customers'
import { getServiceItemById } from '@/lib/domain/stores/service-items'
import { getHistoryForItem } from '@/lib/domain/stores/history'
import { mapHistoryEvent } from '@/lib/api/ext/mappers'
import { historyEventSchema } from '@/lib/api/ext/dto'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const verified = await verifyExtRequest(db, req)
  if (!verified.ok) {
    return Response.json({ error: verified.code, code: verified.code }, { status: verified.status })
  }

  const rate = await checkExtRateLimit(db, verified.tokenId, 'service-items.history')
  if (!rate.allowed) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } })
  }

  const { id } = await params
  const item = await getServiceItemById(db, verified.tenantId, id)
  const customerIds = await resolveCustomerIdsByCodes(
    db,
    verified.tenantId,
    verified.erpCompanyId,
    verified.resolveScopeCodes(),
  )

  if (!item || !item.customerId || !customerIds.includes(item.customerId)) {
    return Response.json({ error: 'not_found', code: 'not_found' }, { status: 404 })
  }

  const events = await getHistoryForItem(db, verified.tenantId, id)
  return Response.json(historyEventSchema.array().parse(events.map((event) => mapHistoryEvent(event))))
}
