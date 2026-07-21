// __tests__/db/users-role-check.test.ts
//
// FIX-12 (migration 0024): users.role is constrained to the five roles in the
// Role union (lib/auth/roles.ts). Before this, a bad write could store an
// arbitrary string that hasCapability couldn't map. This is the DB-layer gate;
// the application guard (hasCapability returning false) is defense in depth.
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('users.role CHECK constraint', () => {
  it('accepts each of the five valid roles', async () => {
    const [tenant] = await db.insert(schema.tenants).values({ slug: 'role-ok', name: 'Role OK' }).returning()
    for (const role of ['technician', 'team_lead', 'dispatcher', 'back_office', 'admin']) {
      const [user] = await db
        .insert(schema.users)
        .values({ tenantId: tenant.id, email: `${role}@role.test`, role })
        .returning()
      expect(user.role).toBe(role)
    }
  })

  it('rejects an out-of-set role string at the DB layer', async () => {
    const [tenant] = await db.insert(schema.tenants).values({ slug: 'role-bad', name: 'Role Bad' }).returning()
    await expect(
      db.insert(schema.users).values({ tenantId: tenant.id, email: 'bad@role.test', role: 'superuser' }).returning(),
    ).rejects.toThrow()
  })
})
