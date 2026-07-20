// app/api/ext/v1/orders/[id]/route.ts
//
// GET /api/ext/v1/orders/{id} — the detail endpoint of the `/api/ext/v1` read
// API (frozen response shape: herbe-portal `lib/service/dto.ts`'s
// `orderDetailSchema`, consumed by `lib/service/client.ts`'s `getOrder`).
// Same scope-check-then-404 idiom as
// app/api/ext/v1/service-items/[id]/route.ts (Task 8): an out-of-scope id
// never confirms its own existence (docs/08-suite-integration.md:86). Takes
// no `customerCodes` query param, same as that file — see its header for why
// `resolveScopeCodes()` is called with nothing to narrow by here.
//
// timeline/invoices/booking/feedback/confirmation are always absent or []
// (mapOrderDetail, lib/api/ext/mappers.ts) — no domain source exists yet for
// any of them in this Phase 1 schema; see that mapper's comment.
import { db } from '@/lib/db'
import { verifyExtRequest } from '@/lib/api/ext/auth'
import { checkExtRateLimit } from '@/lib/api/ext/rate-limit'
import { resolveCustomerIdsByCodes } from '@/lib/domain/stores/customers'
import { getServiceOrderById, getServiceOrderRowsForOrders } from '@/lib/domain/stores/service-orders'
import { getWorksheetsForOrder, getWorksheetRowsForWorksheets } from '@/lib/domain/stores/worksheets'
import { getServiceItemsByIds } from '@/lib/domain/stores/service-items'
import { toCustomerOrderStatus } from '@/lib/domain/customer-order-status'
import type { OrderStatus } from '@/lib/domain/types'
import { mapOrderDetail, mapWorksheetSummary, resolveOrderServiceItems } from '@/lib/api/ext/mappers'
import { orderHasRenderedReport } from '@/lib/documents/store'
import { orderDetailSchema } from '@/lib/api/ext/dto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const verified = await verifyExtRequest(db, req)
  if (!verified.ok) {
    return Response.json({ error: verified.code, code: verified.code }, { status: verified.status })
  }

  const rate = await checkExtRateLimit(db, verified.tokenId, 'orders.detail')
  if (!rate.allowed) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } })
  }

  const { id } = await params
  // A malformed id would throw binding against the uuid column (500) —
  // treat it the same as "not found" rather than surfacing that, which also
  // preserves the no-enumeration-oracle behavior below.
  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'not_found', code: 'not_found' }, { status: 404 })
  }

  const order = await getServiceOrderById(db, verified.tenantId, id)
  const customerIds = await resolveCustomerIdsByCodes(
    db,
    verified.tenantId,
    verified.erpCompanyId,
    verified.resolveScopeCodes(),
  )

  if (!order || !customerIds.includes(order.customerId)) {
    return Response.json({ error: 'not_found', code: 'not_found' }, { status: 404 })
  }

  const worksheets = await getWorksheetsForOrder(db, verified.tenantId, id)
  const worksheetRows = await getWorksheetRowsForWorksheets(db, worksheets.map((w) => w.id))
  const rowsByWorksheet = new Map<string, typeof worksheetRows>()
  for (const row of worksheetRows) {
    const list = rowsByWorksheet.get(row.worksheetId)
    if (list) list.push(row)
    else rowsByWorksheet.set(row.worksheetId, [row])
  }
  // reportPdf is order-level (WS12): resolve once and share across worksheets.
  const reportPdf = await orderHasRenderedReport(db, { tenantId: verified.tenantId, orderId: id })
  const worksheetSummaries = worksheets.map((ws) => mapWorksheetSummary(ws, rowsByWorksheet.get(ws.id) ?? [], reportPdf))

  const orderRows = await getServiceOrderRowsForOrders(db, [id])
  const itemIds = [...new Set(orderRows.map((r) => r.serviceItemId).filter((v): v is string => v != null))]
  const items = await getServiceItemsByIds(db, verified.tenantId, itemIds)
  const itemById = new Map(items.map((i) => [i.id, i]))
  const serviceItems = resolveOrderServiceItems(orderRows, itemById)

  const customerStatus = toCustomerOrderStatus(order.status as OrderStatus)
  return Response.json(
    orderDetailSchema.parse(mapOrderDetail(order, { customerStatus, serviceItems, worksheets: worksheetSummaries })),
  )
}
