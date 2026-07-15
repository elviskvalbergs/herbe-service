// app/api/ext/v1/orders/route.ts
//
// GET /api/ext/v1/orders — the list endpoint of herbe.service's `/api/ext/v1`
// read API (docs/08-suite-integration.md §4: "List endpoints take
// customerCodes= + after=<changeSeq>"). Response shape is the portal's
// frozen contract (herbe-portal `lib/service/dto.ts`'s `orderListSchema` /
// `lib/service/client.ts`'s `listOrders`) — `{ data, nextCursor? }`, the same
// pagination idiom as app/api/ext/v1/service-items/route.ts (Task 8).
//
// Status projection: the internal 9-state OrderStatus column
// (lib/domain/types.ts) is never exposed verbatim — every returned order's
// `status` is the customer-visible 6-state projection
// (lib/domain/customer-order-status.ts's toCustomerOrderStatus). The
// order.status column already holds the derived internal state — it's
// written by setOrderStatus/setErpOwnedState at the point a transition
// happens (lib/domain/order-status.ts's deriveOrderStatus is the *write-side*
// recompute that feeds those setters, not something a read route re-runs) —
// so this route casts and projects the stored value directly.
//
// `?status=` filtering is CUSTOMER-status, not internal-status: several
// internal states collapse to one customer state (e.g. both 'Work done' and
// 'Confirmed' project to 'work_done'), so an exact-match filter against the
// internal column would silently miss rows that should match. This route
// always fetches the page unfiltered at the store layer and applies
// `?status=` as a post-projection filter on the *mapped* result instead —
// see the filter below. Because of this, `nextCursor` is derived from the
// raw scanned page (whether the underlying scan came back full), not from
// how many rows survived the filter: there can be more matching orders on
// the next page even if this page's filtered `data` is empty.
//
// customerCodes scoping (docs/08-suite-integration.md:86, "narrow, never
// widen"): identical rule to service-items/route.ts — see that file's header
// for the unrestricted-token/missing-customerCodes edge case, which applies
// here unchanged.
import { db } from '@/lib/db'
import { verifyExtRequest } from '@/lib/api/ext/auth'
import { checkExtRateLimit } from '@/lib/api/ext/rate-limit'
import { resolveCustomerIdsByCodes } from '@/lib/domain/stores/customers'
import { scanServiceOrdersForCustomer, getServiceOrderRowsForOrders } from '@/lib/domain/stores/service-orders'
import { getServiceItemsByIds } from '@/lib/domain/stores/service-items'
import { toCustomerOrderStatus } from '@/lib/domain/customer-order-status'
import type { OrderStatus } from '@/lib/domain/types'
import { mapOrderSummary } from '@/lib/api/ext/mappers'
import { orderListSchema } from '@/lib/api/ext/dto'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

function parseLimit(raw: string | null): number {
  const parsed = raw ? parseInt(raw, 10) : DEFAULT_LIMIT
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT
  return Math.min(value, MAX_LIMIT)
}

export async function GET(req: Request) {
  const verified = await verifyExtRequest(db, req)
  if (!verified.ok) {
    return Response.json({ error: verified.code, code: verified.code }, { status: verified.status })
  }

  const rate = await checkExtRateLimit(db, verified.tokenId, 'orders')
  if (!rate.allowed) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } })
  }

  const url = new URL(req.url)
  const customerCodesParam = url.searchParams.get('customerCodes')
  const requestedCodes = customerCodesParam
    ? customerCodesParam.split(',').map((c) => c.trim()).filter(Boolean)
    : undefined
  const statusParam = url.searchParams.get('status')
  const afterParam = url.searchParams.get('after')
  if (afterParam !== null && !/^\d+$/.test(afterParam)) {
    return Response.json({ error: 'invalid_cursor', code: 'invalid_cursor' }, { status: 400 })
  }
  const after = afterParam ? BigInt(afterParam) : undefined
  const limit = parseLimit(url.searchParams.get('limit'))

  const codes = verified.resolveScopeCodes(requestedCodes)
  const customerIds = await resolveCustomerIdsByCodes(db, verified.tenantId, verified.erpCompanyId, codes)

  // Deliberately no internal `status` passed to the store: see the header
  // comment on why this filters post-projection instead.
  const orders = await scanServiceOrdersForCustomer(db, { tenantId: verified.tenantId, customerIds, after, limit })

  // Batch-resolve every order's rows -> service items in two queries total
  // (not one round-trip per order), same idiom as service-items/route.ts's
  // modelIds batch.
  const orderRows = await getServiceOrderRowsForOrders(db, orders.map((o) => o.id))
  const itemIds = [...new Set(orderRows.map((r) => r.serviceItemId).filter((id): id is string => id != null))]
  const items = await getServiceItemsByIds(db, verified.tenantId, itemIds)
  const itemById = new Map(items.map((i) => [i.id, i]))
  const rowsByOrder = new Map<string, typeof orderRows>()
  for (const row of orderRows) {
    const list = rowsByOrder.get(row.orderId)
    if (list) list.push(row)
    else rowsByOrder.set(row.orderId, [row])
  }

  let data = orders.map((order) => {
    const customerStatus = toCustomerOrderStatus(order.status as OrderStatus)
    const serviceItems = (rowsByOrder.get(order.id) ?? [])
      .map((row) => (row.serviceItemId ? itemById.get(row.serviceItemId) : undefined))
      .filter((item): item is NonNullable<typeof item> => item != null)
      .map((item) => ({ id: item.id, name: item.name, ...(item.serialNr ? { serial: item.serialNr } : {}) }))
    return mapOrderSummary(order, { customerStatus, serviceItems })
  })

  if (statusParam) {
    data = data.filter((o) => o.status === statusParam)
  }

  // nextCursor omitted (not just left undefined) when the raw page came back
  // short — same "that's the signal there's nothing more to page through"
  // idiom as service-items/route.ts, unaffected by the status filter above.
  const body =
    orders.length === limit
      ? { data, nextCursor: String(orders[orders.length - 1].changeSeq) }
      : { data }

  return Response.json(orderListSchema.parse(body))
}
