// lib/sync/scope-membership.test.ts
//
// Uses the local-Postgres test harness (lib/test-support/db.ts), not
// Testcontainers — see docs/superpowers/plans/2026-07-08-phase-0-foundations.md
// "Test Database Harness" section, which supersedes Testcontainers everywhere.
//
// Proves the scoped-replication mechanism (03-architecture.md) against a
// synthetic entityType ('note') — Phase 0 has no assignment-scoped entities
// yet (orders/worksheets ship Phase 1); see ADR 0005.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { enterScope, exitScope, pullScopedDelta } from './scope-membership'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let userId: string

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't6', name: 'T6' }).returning()
  const [user] = await db
    .insert(schema.users)
    .values({ tenantId: tenant.id, email: 'tech.anna2@herbe-service.test' })
    .returning()
  userId = user.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('scoped replication — entry backfill and exit purge', () => {
  it('a newly-scoped entity appears as a full upsert in the very next pull', async () => {
    await enterScope(db, { userId, entityType: 'note', entityId: 'note-1' })

    const delta = await pullScopedDelta(db, { userId, sinceMembershipSeq: '0' })

    expect(delta.upserts).toContainEqual(expect.objectContaining({ entityType: 'note', entityId: 'note-1' }))
    expect(delta.exitedIds).toEqual([])
  })

  it('exiting scope emits a purge signal the client applies as a local delete, not a data-level tombstone', async () => {
    const before = await pullScopedDelta(db, { userId, sinceMembershipSeq: '0' })

    await exitScope(db, { userId, entityType: 'note', entityId: 'note-1' })

    const after = await pullScopedDelta(db, { userId, sinceMembershipSeq: before.cursor })

    expect(after.exitedIds).toEqual(['note-1'])
    expect(after.upserts).toEqual([]) // the record itself isn't re-sent — only the exit signal
  })

  it('entering scope for a second entity does not re-emit the already-exited first entity', async () => {
    await enterScope(db, { userId, entityType: 'note', entityId: 'note-2' })

    const before = await pullScopedDelta(db, { userId, sinceMembershipSeq: '0' })
    const noteIds = before.upserts.map((u) => (u as { entityId: string }).entityId)

    expect(noteIds).toContain('note-2')
    expect(noteIds).not.toContain('note-1')
    expect(before.exitedIds).toContain('note-1')
  })

  it('returns the unchanged cursor and empty upserts/exitedIds when nothing changed since the given cursor', async () => {
    const caughtUp = await pullScopedDelta(db, { userId, sinceMembershipSeq: '0' })

    const nothingNew = await pullScopedDelta(db, { userId, sinceMembershipSeq: caughtUp.cursor })

    expect(nothingNew.upserts).toEqual([])
    expect(nothingNew.exitedIds).toEqual([])
    expect(nothingNew.cursor).toBe(caughtUp.cursor)
  })

  it('stamps outScopeSeq with a real, distinct nextval — not the same literal for every exit', async () => {
    await enterScope(db, { userId, entityType: 'note', entityId: 'note-3' })
    await enterScope(db, { userId, entityType: 'note', entityId: 'note-4' })

    await exitScope(db, { userId, entityType: 'note', entityId: 'note-3' })
    await exitScope(db, { userId, entityType: 'note', entityId: 'note-4' })

    const [row3] = await db
      .select()
      .from(schema.scopeMembership)
      .where(
        and(
          eq(schema.scopeMembership.userId, userId),
          eq(schema.scopeMembership.entityType, 'note'),
          eq(schema.scopeMembership.entityId, 'note-3'),
        ),
      )
    const [row4] = await db
      .select()
      .from(schema.scopeMembership)
      .where(
        and(
          eq(schema.scopeMembership.userId, userId),
          eq(schema.scopeMembership.entityType, 'note'),
          eq(schema.scopeMembership.entityId, 'note-4'),
        ),
      )

    expect(row3.outScopeSeq).not.toBeNull()
    expect(row4.outScopeSeq).not.toBeNull()
    expect(row3.outScopeSeq).not.toBe(BigInt(0))
    expect(row4.outScopeSeq).not.toBe(BigInt(0))
    expect(row3.outScopeSeq).not.toBe(row4.outScopeSeq) // distinct, monotonic values — not both the old literal 0
  })

  it('re-entering scope after an exit clears outScopeSeq and backfills the entity again', async () => {
    await enterScope(db, { userId, entityType: 'note', entityId: 'note-5' })
    await exitScope(db, { userId, entityType: 'note', entityId: 'note-5' })

    const beforeReentry = await pullScopedDelta(db, { userId, sinceMembershipSeq: '0' })

    await enterScope(db, { userId, entityType: 'note', entityId: 'note-5' })

    const [row] = await db
      .select()
      .from(schema.scopeMembership)
      .where(
        and(
          eq(schema.scopeMembership.userId, userId),
          eq(schema.scopeMembership.entityType, 'note'),
          eq(schema.scopeMembership.entityId, 'note-5'),
        ),
      )

    expect(row.outScopeSeq).toBeNull()
    expect(row.membershipSeq).toBeGreaterThan(BigInt(beforeReentry.cursor))

    const afterReentry = await pullScopedDelta(db, { userId, sinceMembershipSeq: beforeReentry.cursor })

    expect(afterReentry.upserts).toContainEqual(expect.objectContaining({ entityType: 'note', entityId: 'note-5' }))
    expect(afterReentry.exitedIds).not.toContain('note-5')
  })
})
