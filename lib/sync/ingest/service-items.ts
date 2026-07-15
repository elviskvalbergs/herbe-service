// lib/sync/ingest/service-items.ts
//
// Cache -> domain mapping for the SVOSerVc register (serviced units). Mirrors
// ingestCustomers: upserts are keyed by (erpCompanyId, erpRef) so ingest is
// idempotent, and changeSeq is bumped exclusively by the bump_change_seq()
// trigger (0009_service_items.sql) — the explicit `changeSeq: BigInt(0)` is
// overwritten before the row is written.
//
// SVOSerVc is a no-delta register whose identity key is SerialNr (there is no
// SerNr field), so erpRef = SerialNr. Every row becomes a 'unit' node.
// modelId stays null: item_models is app-master with no ERP key
// (0008_item_models.sql) — ItemCode/ItemName are preserved in `attributes`
// instead. labelId is a deterministic `erp:<company>:<serial>` placeholder,
// set on INSERT only and omitted from the UPDATE set so it never churns,
// pending the real QR-labeling feature (docs/11-service-items-and-parts.md).
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ChangeSet } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'

// Standard Books returns dates as ISO-ish 'YYYY-MM-DD' strings; empty/blank
// means "no date". Best-effort: null on anything unparseable, don't over-parse.
function parseBooksDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const d = new Date(trimmed)
  return Number.isNaN(d.getTime()) ? null : d
}

// Books marks a boolean flag as the string or int 1.
function isBooksTrue(value: unknown): boolean {
  return value === '1' || value === 1
}

export async function ingestServiceItems(
  db: PostgresJsDatabase<typeof schema>,
  erpCompanyId: string,
  changeSet: ChangeSet<Record<string, unknown>>,
): Promise<void> {
  const [company] = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.id, erpCompanyId))
  if (!company) {
    throw new Error(`ingestServiceItems: unknown erpCompanyId ${erpCompanyId}`)
  }

  for (const row of changeSet.upserts) {
    const erpRef = String(row.SerialNr ?? '')
    if (!erpRef) continue // skip rows with no SerialNr — nothing to key on

    // Deferred FK: resolve the owning customer by (erpCompanyId, CustCode).
    // Best-effort — null if the customer hasn't been ingested yet.
    let customerId: string | null = null
    const custCode = row.CustCode ? String(row.CustCode) : ''
    if (custCode) {
      const [customer] = await db
        .select({ id: schema.customers.id })
        .from(schema.customers)
        .where(and(eq(schema.customers.erpCompanyId, erpCompanyId), eq(schema.customers.erpRef, custCode)))
      customerId = customer?.id ?? null
    }

    const secondarySerial =
      (row.SecondarySerialNr ? String(row.SecondarySerialNr) : '') ||
      (row.AlternateDeviceID ? String(row.AlternateDeviceID) : '') ||
      null

    const attributes = {
      itemCode: row.ItemCode,
      itemName: row.ItemName,
      custName: row.CustName,
      warrantyStatus: row.WarrantyStatus,
      coverageStartDate: row.CoverageStartDate,
      coverageEndDate: row.CoverageEndDate,
      contractCoverageStartDate: row.ContractCoverageStartDate,
      contractCoverageEndDate: row.ContractCoverageEndDate,
      contractType: row.ContractType,
      globalWarranty: row.GlobalWarranty,
      limitedWarranty: row.LimitedWarranty,
      contract: row.Contract,
      motherNr: row.MotherNr,
      soldDate: row.SoldDate,
    }

    const mastered = {
      customerId,
      kind: 'unit' as const,
      name: String(row.ItemName || row.SerialNr),
      serialNr: erpRef,
      secondarySerial,
      path: '',
      modelId: null,
      attributes,
      warrantyUntil: parseBooksDate(row.WarrantyUntil),
      warrantyLaborCovered: isBooksTrue(row.LaborCovered),
      warrantyPartsCovered: isBooksTrue(row.PartCovered),
    }

    await db
      .insert(schema.serviceItems)
      .values({
        tenantId: company.tenantId,
        erpCompanyId,
        erpRef,
        // Deterministic placeholder — globally unique (company + serial), set
        // once and never updated. Omitted from the onConflictDoUpdate set.
        labelId: `erp:${erpCompanyId}:${erpRef}`,
        changeSeq: BigInt(0), // overwritten by bump_change_seq() before the row is written
        ...mastered,
      })
      .onConflictDoUpdate({
        target: [schema.serviceItems.erpCompanyId, schema.serviceItems.erpRef],
        set: mastered,
      })
  }

  // Second pass — resolve MotherNr to parentId now that every row exists.
  // Self-join within the same company on serialNr. A dangling MotherNr (parent
  // not present) is tolerated: parentId stays null, no throw.
  for (const row of changeSet.upserts) {
    const erpRef = String(row.SerialNr ?? '')
    if (!erpRef) continue
    const motherNr = row.MotherNr ? String(row.MotherNr) : ''
    if (!motherNr) continue

    const [parent] = await db
      .select({ id: schema.serviceItems.id })
      .from(schema.serviceItems)
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.serialNr, motherNr)))
    if (!parent) continue // dangling MotherNr — leave parentId null

    await db
      .update(schema.serviceItems)
      .set({ parentId: parent.id })
      .where(and(eq(schema.serviceItems.erpCompanyId, erpCompanyId), eq(schema.serviceItems.erpRef, erpRef)))
  }
}
