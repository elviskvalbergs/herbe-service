// lib/domain/stores/customers.ts
//
// Task 2 of the herbe.service /api/ext/v1 read-API slice
// (docs/superpowers/sdd/task-2-brief.md): the ext read API scopes a
// request by ERP customer code (ext_tokens.customer_codes), not by the
// internal customers.id uuid the rest of the domain uses. This is the join
// point — callers resolve codes to ids once per request, tenant- and
// erp-company-scoped so a code that happens to collide across ERP
// companies never resolves to the wrong tenant's customer, then pass the
// id list into scanServiceItemsForCustomer / scanServiceOrdersForCustomer
// (service-items.ts / service-orders.ts).
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { CustomerRow } from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

// WS4 outbound slice (docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
// decision 5): the push saga (lib/sync/push/gather.ts) resolves a service
// order's customerId to its erpRef (CustCode) to build the SVOVc create
// payload. Same tenant/deletedAt scoping idiom as the other domain stores.
export async function getCustomerById(db: Db, tenantId: string, id: string): Promise<CustomerRow | null> {
  const [row] = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.id, id), eq(schema.customers.tenantId, tenantId), isNull(schema.customers.deletedAt)))

  return row ?? null
}

export async function resolveCustomerIdsByCodes(
  db: Db,
  tenantId: string,
  erpCompanyId: string,
  codes: string[],
): Promise<string[]> {
  if (codes.length === 0) return []

  const rows = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(
      and(
        eq(schema.customers.tenantId, tenantId),
        eq(schema.customers.erpCompanyId, erpCompanyId),
        inArray(schema.customers.erpRef, codes),
        isNull(schema.customers.deletedAt),
      ),
    )

  return rows.map((r) => r.id)
}
