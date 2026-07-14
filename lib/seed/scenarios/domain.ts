// lib/seed/scenarios/domain.ts
//
// Domain data for the `baseline` pack (docs/15-testing-strategy.md §5.1),
// scoped to what exists today (Tasks 1/4/6/7): a service-item tree and
// service orders/worksheets in every status, per seeded erpCompany. Deferred
// from baseline.ts's original comment — that "later work" is this task.
//
// Determinism (matching baseline.ts's fixed faker.seed(42) style): no
// Date.now(), no random UUIDs. Rows created through the domain stores
// (insertServiceItem/insertServiceOrder/insertWorksheet) get a server-random
// primary key — same as every other test in tests/unit/domain/*, which
// always captures the returned `.id` rather than asserting a fixed value;
// none of those store signatures expose an `id` override, so this is the
// one thing seedDomain cannot pin down (and doesn't need to: nothing reads
// these ids across a re-seed except by dynamic lookup). Every field
// seedDomain *does* control directly — labelId, orderNumber, crewGroupId,
// the customer row's own id — is fixed, so re-seeding a fresh DB reproduces
// identical business-key data.
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import {
  insertServiceOrder,
  setErpOwnedState,
  setOrderStatus,
} from '@/lib/domain/stores/service-orders'
import { insertServiceItem } from '@/lib/domain/stores/service-items'
import { insertWorksheet, setWorksheetStatus } from '@/lib/domain/stores/worksheets'

type Db = PostgresJsDatabase<typeof schema>

export interface SeedDomainCtx {
  tenantId: string
  erpCompanyId: string
  technicianUserId: string
}

// Fixed, so signatureLockedAt is identical across runs (no clock read) — the
// exact value isn't asserted by the determinism test (only "is it set"),
// but it still shouldn't come from Date.now().
const SEED_TIMESTAMP = new Date('2026-01-01T00:00:00.000Z')

// Deterministic UUID-shaped id derived from (erpCompanyId, role): same
// input -> same output on every run, so the customer row's PK and a shared
// crewGroupId are stable across a fresh re-seed without needing a store-
// level `id` override. Not a real UUID (no version/variant bits) — Postgres's
// `uuid` column only validates the 8-4-4-4-12 hex shape.
function derivedId(erpCompanyId: string, role: string): string {
  const hex = createHash('sha256').update(`${erpCompanyId}:${role}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// service_items.labelId is globally unique (unique().on(t.labelId)) — this
// scheme is unique per (erpCompanyId, role) without needing a hash.
function seedLabel(erpCompanyId: string, role: string): string {
  return `seed:${role}:${erpCompanyId}`
}

export async function seedDomain(db: Db, ctx: SeedDomainCtx): Promise<void> {
  const { tenantId, erpCompanyId, technicianUserId } = ctx

  // Service orders require a customerId (NOT NULL FK); there's no
  // dedicated customer store yet (customers are otherwise only written by
  // lib/sync/ingest/customers.ts, which expects a real ERP ChangeSet), so
  // this seeds the row directly — same as baseline.ts does for
  // tenants/erpCompanies.
  const customerId = derivedId(erpCompanyId, 'customer')
  await db.insert(schema.customers).values({
    id: customerId,
    tenantId,
    erpCompanyId,
    erpRef: 'SEED-CUST-1',
    name: 'Seed Customer OÜ',
    changeSeq: BigInt(0), // overwritten by bump_change_seq() before the row is written
  })

  // --- service-item tree: 1 system with a unit child and a lot child ---
  const system = await insertServiceItem(db, {
    tenantId,
    erpCompanyId,
    kind: 'system',
    name: 'Seed Boiler System',
    labelId: seedLabel(erpCompanyId, 'system'),
  })
  await insertServiceItem(db, {
    tenantId,
    erpCompanyId,
    kind: 'unit',
    name: 'Seed Circulation Unit',
    labelId: seedLabel(erpCompanyId, 'unit'),
    parentId: system.id,
  })
  await insertServiceItem(db, {
    tenantId,
    erpCompanyId,
    kind: 'lot',
    name: 'Seed Filter Lot',
    labelId: seedLabel(erpCompanyId, 'lot'),
    parentId: system.id,
  })

  // --- orders + worksheets: one order per required OrderStatus ---

  // New: freshly created, no worksheets — this is insertServiceOrder's
  // default (see orders-worksheets-store.test.ts).
  await insertServiceOrder(db, { tenantId, customerId, erpCompanyId, orderNumber: 'SVO-NEW' })

  // Planned: no bookings table exists yet in Phase 1 (deriveOrderStatus's
  // bookingCount > 0 path has nothing to book against), so the only way to
  // reach this in seed data is the same direct write the store's own test
  // already uses for 'Cancelled' — setOrderStatus is a thin setter with no
  // transition validation (lib/domain/stores/service-orders.ts top comment).
  const plannedOrder = await insertServiceOrder(db, { tenantId, customerId, erpCompanyId, orderNumber: 'SVO-PLANNED' })
  await setOrderStatus(db, tenantId, plannedOrder.id, 'Planned')

  // In progress: an active worksheet plus the matching manual order write.
  const inProgressOrder = await insertServiceOrder(db, {
    tenantId,
    customerId,
    erpCompanyId,
    orderNumber: 'SVO-IN-PROGRESS',
  })
  const inProgressWs = await insertWorksheet(db, {
    tenantId,
    erpCompanyId,
    orderId: inProgressOrder.id,
    technicianUserId,
  })
  await setWorksheetStatus(db, tenantId, inProgressWs.id, 'In progress')
  await setOrderStatus(db, tenantId, inProgressOrder.id, 'In progress')

  // Work done: technician-judgment manual state (docs/02-data-model.md:64-72).
  const workDoneOrder = await insertServiceOrder(db, {
    tenantId,
    customerId,
    erpCompanyId,
    orderNumber: 'SVO-WORK-DONE',
  })
  const workDoneWs = await insertWorksheet(db, { tenantId, erpCompanyId, orderId: workDoneOrder.id, technicianUserId })
  await setWorksheetStatus(db, tenantId, workDoneWs.id, 'Done')
  await setOrderStatus(db, tenantId, workDoneOrder.id, 'Work done')

  // Confirmed: manager-judgment manual state. Its worksheet is also the
  // required SIGNED worksheet (signedOnSite/signatureLockedAt aren't
  // exposed by insertWorksheet's input, so they're written directly —
  // same "raw schema access for what the store doesn't expose" pattern
  // baseline.ts already uses for tenants/erpCompanies).
  const confirmedOrder = await insertServiceOrder(db, {
    tenantId,
    customerId,
    erpCompanyId,
    orderNumber: 'SVO-CONFIRMED',
  })
  const confirmedWs = await insertWorksheet(db, {
    tenantId,
    erpCompanyId,
    orderId: confirmedOrder.id,
    technicianUserId,
  })
  await setWorksheetStatus(db, tenantId, confirmedWs.id, 'Approved')
  await db
    .update(schema.worksheets)
    .set({ signedOnSite: true, signatureLockedAt: SEED_TIMESTAMP })
    .where(eq(schema.worksheets.id, confirmedWs.id))
  await setOrderStatus(db, tenantId, confirmedOrder.id, 'Confirmed')

  // Invoiced: ERP-owned state — only reachable via setErpOwnedState
  // (seed/test-only; see its doc comment in service-orders.ts).
  const invoicedOrder = await insertServiceOrder(db, {
    tenantId,
    customerId,
    erpCompanyId,
    orderNumber: 'SVO-INVOICED',
  })
  const invoicedWs = await insertWorksheet(db, { tenantId, erpCompanyId, orderId: invoicedOrder.id, technicianUserId })
  await setWorksheetStatus(db, tenantId, invoicedWs.id, 'Synced')
  await setErpOwnedState(db, invoicedOrder.id, 'Invoiced')

  // Cancelled: direct write, no worksheets (an order with only pre-work
  // worksheets is the only state canCancel() actually allows).
  const cancelledOrder = await insertServiceOrder(db, {
    tenantId,
    customerId,
    erpCompanyId,
    orderNumber: 'SVO-CANCELLED',
  })
  await setOrderStatus(db, tenantId, cancelledOrder.id, 'Cancelled')

  // Crew job + the required Rejected worksheet: one order, two worksheets
  // sharing a crewGroupId (docs/02-data-model.md — WSVc.EMCode is
  // single-technician, so a crew is N worksheets on one order tied together
  // by crewGroupId). The second worksheet has no technicianUserId: the
  // partial unique index on (orderId, technicianUserId) only applies when
  // technicianUserId IS NOT NULL, and seedDomain only has one technician to
  // give out per erpCompany.
  const crewOrder = await insertServiceOrder(db, { tenantId, customerId, erpCompanyId, orderNumber: 'SVO-CREW' })
  const crewGroupId = derivedId(erpCompanyId, 'crew-job')
  const crewWsA = await insertWorksheet(db, {
    tenantId,
    erpCompanyId,
    orderId: crewOrder.id,
    technicianUserId,
    crewGroupId,
  })
  await setWorksheetStatus(db, tenantId, crewWsA.id, 'Assigned')
  const crewWsB = await insertWorksheet(db, {
    tenantId,
    erpCompanyId,
    orderId: crewOrder.id,
    crewGroupId,
  })
  await setWorksheetStatus(db, tenantId, crewWsB.id, 'Rejected')
}
