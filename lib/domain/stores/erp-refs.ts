// lib/domain/stores/erp-refs.ts
//
// Store for the erpRef set (docs/02-data-model.md 154-158, "Global
// Constraints"): erpRef is a set keyed by (entityType, entityId, purpose),
// not a scalar column on the entity tables — e.g. a worksheet maps to both
// a primary WSVc record and a worksheetShadow ActVc. putErpRef upserts on
// the erp_refs_uniq constraint (0012_erp_refs.sql); getErpRefs returns
// every purpose recorded for one entity, scoped to the caller's tenantId
// (erp_refs has a tenant_id column populated on every write — every other
// domain store read filters by tenant, and this one must too).
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { ErpRefRow } from '@/drizzle/schema'
import type { ErpRefPurpose } from '@/lib/domain/types'

type Db = PostgresJsDatabase<typeof schema>

export interface PutErpRefInput {
  tenantId: string
  entityType: string
  entityId: string
  purpose: ErpRefPurpose
  recordRef: string
  erpCompanyId?: string
  register?: string
  lastSequence?: bigint
}

export async function putErpRef(db: Db, input: PutErpRefInput): Promise<ErpRefRow> {
  const [row] = await db
    .insert(schema.erpRefs)
    .values({
      tenantId: input.tenantId,
      erpCompanyId: input.erpCompanyId,
      entityType: input.entityType,
      entityId: input.entityId,
      purpose: input.purpose,
      register: input.register,
      recordRef: input.recordRef,
      lastSequence: input.lastSequence,
    })
    .onConflictDoUpdate({
      target: [schema.erpRefs.entityType, schema.erpRefs.entityId, schema.erpRefs.purpose],
      set: {
        erpCompanyId: input.erpCompanyId,
        register: input.register,
        recordRef: input.recordRef,
        lastSequence: input.lastSequence,
        updatedAt: new Date(),
      },
    })
    .returning()

  return row
}

export async function getErpRefs(
  db: Db,
  tenantId: string,
  entityType: string,
  entityId: string,
): Promise<ErpRefRow[]> {
  return db
    .select()
    .from(schema.erpRefs)
    .where(
      and(
        eq(schema.erpRefs.tenantId, tenantId),
        eq(schema.erpRefs.entityType, entityType),
        eq(schema.erpRefs.entityId, entityId),
      ),
    )
}
