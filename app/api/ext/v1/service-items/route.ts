// app/api/ext/v1/service-items/route.ts
//
// GET /api/ext/v1/service-items — the list endpoint of herbe.service's
// `/api/ext/v1` read API (docs/08-suite-integration.md §4: "List endpoints
// take customerCodes= + after=<changeSeq>"; §4a: `labelId=` QR resolution).
// Response shape is the portal's frozen contract (herbe-portal
// `lib/service/dto.ts`'s `serviceItemListSchema` / `lib/service/client.ts`'s
// `listServiceItems`) — `{ data, nextCursor? }`, mirroring the `{data,
// cursor}` pagination idiom of app/api/sync/customers/route.ts but swapping
// session auth for `verifyExtRequest` (bearer token) and tenant-only scoping
// for tenant + customer-code scoping.
//
// customerCodes scoping (docs/08-suite-integration.md:86, "narrow, never
// widen"): `resolveScopeCodes` intersects the request's `customerCodes` with
// the token's own scope. One documented edge case: an *unrestricted* token
// (empty customer_codes on the ext_tokens row) with NO `customerCodes` query
// param resolves to `[]` (lib/api/ext/auth.ts), which `resolveCustomerIdsByCodes`
// turns into `[]`, so this list returns nothing rather than "all customers of
// the company". That's intentional — the portal always sends `customerCodes`
// on this endpoint, and silently falling through to an unscoped dump on a
// missing param would be the wrong failure mode for a customer-scoped feed.
import { db } from '@/lib/db'
import { verifyExtRequest } from '@/lib/api/ext/auth'
import { checkExtRateLimit } from '@/lib/api/ext/rate-limit'
import { resolveCustomerIdsByCodes } from '@/lib/domain/stores/customers'
import {
  scanServiceItemsForCustomer,
  getServiceItemByLabelId,
  getItemModelsByIds,
} from '@/lib/domain/stores/service-items'
import { mapServiceItemSummary } from '@/lib/api/ext/mappers'
import { serviceItemListSchema } from '@/lib/api/ext/dto'

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

  const rate = await checkExtRateLimit(db, verified.tokenId, 'service-items')
  if (!rate.allowed) {
    return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } })
  }

  const url = new URL(req.url)
  const customerCodesParam = url.searchParams.get('customerCodes')
  const requestedCodes = customerCodesParam
    ? customerCodesParam.split(',').map((c) => c.trim()).filter(Boolean)
    : undefined
  const labelId = url.searchParams.get('labelId')
  const afterParam = url.searchParams.get('after')
  const after = afterParam ? BigInt(afterParam) : undefined
  const limit = parseLimit(url.searchParams.get('limit'))

  const codes = verified.resolveScopeCodes(requestedCodes)
  const customerIds = await resolveCustomerIdsByCodes(db, verified.tenantId, verified.erpCompanyId, codes)

  if (labelId) {
    const item = await getServiceItemByLabelId(db, verified.tenantId, labelId)
    // Scope-check: the item must belong to one of the caller's in-scope
    // customers. An item with no customerId at all (e.g. a system-level
    // node) never matches — it isn't visible through this customer-scoped
    // endpoint regardless of token scope.
    if (!item || !item.customerId || !customerIds.includes(item.customerId)) {
      return Response.json(serviceItemListSchema.parse({ data: [] }))
    }
    const [model] = item.modelId ? await getItemModelsByIds(db, verified.tenantId, [item.modelId]) : []
    return Response.json(serviceItemListSchema.parse({ data: [mapServiceItemSummary(item, model ?? null)] }))
  }

  const items = await scanServiceItemsForCustomer(db, { tenantId: verified.tenantId, customerIds, after, limit })

  const modelIds = [...new Set(items.map((i) => i.modelId).filter((id): id is string => id != null))]
  const models = await getItemModelsByIds(db, verified.tenantId, modelIds)
  const modelById = new Map(models.map((m) => [m.id, m]))
  const data = items.map((item) => mapServiceItemSummary(item, item.modelId ? modelById.get(item.modelId) ?? null : null))

  // nextCursor omitted (not just left undefined) when the page came back
  // short — that's the signal there's nothing more to page through.
  const body =
    items.length === limit
      ? { data, nextCursor: String(items[items.length - 1].changeSeq) }
      : { data }

  return Response.json(serviceItemListSchema.parse(body))
}
