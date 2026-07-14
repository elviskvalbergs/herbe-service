// lib/seed/scenarios/baseline.ts
//
// The full `baseline` pack from `15-testing-strategy.md` §5.1 seeds
// customers/sites/service-items/orders — most of those tables didn't exist
// when this file was first written (they landed from Task 11 onward). Now
// that they do, the domain half (service-item tree + orders/worksheets in
// every status) lives in ./domain.ts and is called once per seeded
// erpCompany below. This file still only owns `tenants` and `erp_companies`
// (§5.1's "2 companies in one tenant" — modelled here as 2 tenants, one
// erp_company each, so both tenant-scoping and company-scoping have real
// rows to test against) plus the one technician `users` row each company's
// worksheets need.
import { Faker, en } from '@faker-js/faker'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { PERSONAS } from '../personas'
import { seedDomain } from './domain'

const faker = new Faker({ locale: [en] })

// Fixed, so the seed is deterministic end-to-end: every column value —
// including `createdAt`, which the schema would otherwise default to
// `now()` — must be identical across runs, not just the faker-derived ones.
const SEED_TIMESTAMP = new Date('2026-01-01T00:00:00.000Z')

// technicianUserId: PERSONAS.tech's own id for the first tenant (so the
// `users` row this seed creates is the one persona-driven login (§5.3) and
// future identity wiring (Task 14) will eventually use); PERSONAS has no
// second-tenant technician (only otherTenantAdmin/noCompanyAccess are
// defined for tenant 2 — see personas.ts), so tenant 2 gets its own fixed
// placeholder id purely so its worksheets have a technician to reference.
const TENANTS = [
  {
    tenantId: '11111111-0000-0000-0000-000000000001',
    companyId: '22222222-0000-0000-0000-000000000001',
    technicianUserId: PERSONAS.tech.id,
  },
  {
    tenantId: '11111111-0000-0000-0000-000000000002',
    companyId: '22222222-0000-0000-0000-000000000002',
    technicianUserId: '33333333-0000-0000-0000-000000000002',
  },
] as const

export async function seedBaseline(db: PostgresJsDatabase<typeof schema>) {
  faker.seed(42) // fixed seed → deterministic, byte-identical output every run

  for (const { tenantId, companyId, technicianUserId } of TENANTS) {
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

    await db.insert(schema.users).values({
      id: technicianUserId,
      tenantId,
      email: PERSONAS.tech.email,
      role: PERSONAS.tech.role,
      createdAt: SEED_TIMESTAMP,
    })

    await seedDomain(db, { tenantId, erpCompanyId: companyId, technicianUserId })
  }
}
