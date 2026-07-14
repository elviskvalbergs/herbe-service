// lib/seed/scenarios/baseline.ts
//
// The full `baseline` pack from `15-testing-strategy.md` §5.1 seeds
// customers/sites/service-items/orders — those tables don't exist yet
// (they land from Task 11 onward). This pack is deliberately constrained to
// what exists today: `tenants` and `erp_companies` (§5.1's "2 companies in
// one tenant" — modelled here as 2 tenants, one erp_company each, so both
// tenant-scoping and company-scoping have real rows to test against).
import { Faker, en } from '@faker-js/faker'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

const faker = new Faker({ locale: [en] })

// Fixed, so the seed is deterministic end-to-end: every column value —
// including `createdAt`, which the schema would otherwise default to
// `now()` — must be identical across runs, not just the faker-derived ones.
const SEED_TIMESTAMP = new Date('2026-01-01T00:00:00.000Z')

const TENANTS = [
  { tenantId: '11111111-0000-0000-0000-000000000001', companyId: '22222222-0000-0000-0000-000000000001' },
  { tenantId: '11111111-0000-0000-0000-000000000002', companyId: '22222222-0000-0000-0000-000000000002' },
] as const

export async function seedBaseline(db: PostgresJsDatabase<typeof schema>) {
  faker.seed(42) // fixed seed → deterministic, byte-identical output every run

  for (const { tenantId, companyId } of TENANTS) {
    await db.insert(schema.tenants).values({
      id: tenantId,
      slug: faker.helpers.slugify(faker.company.name()).toLowerCase(),
      name: faker.company.name(),
      createdAt: SEED_TIMESTAMP,
    })

    await db.insert(schema.erpCompanies).values({
      id: companyId,
      tenantId,
      displayName: faker.company.name(),
      adapterType: 'standard_books',
      adapterConfigJson: {},
      createdAt: SEED_TIMESTAMP,
    })
  }
}
