// app/api/ext/v1/service-items/[id]/route.ts
//
// GET /api/ext/v1/service-items/{id} — the detail endpoint of the
// `/api/ext/v1` read API (frozen response shape: herbe-portal
// `lib/service/dto.ts`'s `serviceItemDetailSchema`, consumed by
// `lib/service/client.ts`'s `getServiceItem`). Point lookups scope-check the
// resolved item against the token's customer scope and return a bare 404 —
// not 403 — when it's out of scope, so an out-of-scope id never confirms its
// own existence (docs/08-suite-integration.md:86).
//
// This route takes no `customerCodes` query param (the portal client's
// `getServiceItem(id)` doesn't send one — see lib/service/client.ts), so the
// "resolved scope" here is `resolveScopeCodes()` with nothing to narrow by:
// the token's own scope, unfiltered. One consequence worth flagging: for an
// *unrestricted* token (empty customer_codes on the ext_tokens row),
// `resolveScopeCodes()` resolves to `[]` (lib/api/ext/auth.ts) exactly as it
// does for the list route's missing-customerCodes case, so every detail
// lookup 404s regardless of the item's actual customer. In practice each
// token is minted per company connection and is expected to carry a
// customerCodes scope (docs/08-suite-integration.md:86); an unrestricted
// token doing point lookups is not a supported case in this slice — see the
// Task 8 report for the full tradeoff.
import { db } from '@/lib/db'
import { verifyExtRequest } from '@/lib/api/ext/auth'
import { checkExtRateLimit } from '@/lib/api/ext/rate-limit'
import { resolveCustomerIdsByCodes } from '@/lib/domain/stores/customers'
import { getServiceItemById, getItemModelsByIds } from '@/lib/domain/stores/service-items'
import { mapServiceItemDetail } from '@/lib/api/ext/mappers'
import { serviceItemDetailSchema } from '@/lib/api/ext/dto'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const verified = await verifyExtRequest(db, req)
  if (!verified.ok) {
    return Response.json({ error: verified.code, code: verified.code }, { status: verified.status })
  }

  const rate = await checkExtRateLimit(db, verified.tokenId, 'service-items.detail')
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

  const [model] = item.modelId ? await getItemModelsByIds(db, verified.tenantId, [item.modelId]) : []
  return Response.json(serviceItemDetailSchema.parse(mapServiceItemDetail(item, model ?? null)))
}
