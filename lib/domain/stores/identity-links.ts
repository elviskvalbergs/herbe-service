// lib/domain/stores/identity-links.ts
//
// Read-only lookup for the technician->ERP person-code link. WS2 owns
// identity_links (migration 0018) and its writes (lib/auth/identity-link.ts
// matchUsersByEmail); WS4 only reads it — this is the reference pattern
// docs/24 §2 establishes for technician EMCode resolution (replacing the
// earlier erp_refs entityType 'user' convention). Scoped by tenantId like
// every other domain store read (see lib/domain/stores/erp-refs.ts), even
// though the table's own unique constraint is (user_id, provider,
// erp_company_id) without tenant_id.
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

// externalId is UserVc.Code (the EMCode) for provider = 'erp'.
export async function getErpIdentityLink(
  db: Db,
  tenantId: string,
  userId: string,
  erpCompanyId: string,
): Promise<{ externalId: string } | null> {
  const [row] = await db
    .select({ externalId: schema.identityLinks.externalId })
    .from(schema.identityLinks)
    .where(
      and(
        eq(schema.identityLinks.tenantId, tenantId),
        eq(schema.identityLinks.userId, userId),
        eq(schema.identityLinks.provider, 'erp'),
        eq(schema.identityLinks.erpCompanyId, erpCompanyId),
      ),
    )
    .limit(1)

  return row ?? null
}
