// lib/sync/push/store.test.ts
//
// DB-backed test for the ERP push-queue store (WS4 outbound slice, docs/
// superpowers/plans/2026-07-16-service-phase1-erp-outbound.md decisions 1-3),
// mirroring the local-Postgres harness idiom from lib/domain/stores/erp-refs.test.ts.
// This is Task 1's own store — saga semantics (idempotency, retries, DLQ
// transitions) belong to the engine (Task 5); these tests only cover what
// this module persists and returns: atomic group+step creation, the
// lane-FIFO / dead-blocks / next_attempt_at-gating rules of
// getRunnableGroups, partial-patch updaters, and the resetDeadStep
// round-trip.
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations, splitSqlStatements } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import {
  claimGroup,
  createPushGroup,
  getRunnableGroups,
  getStepsForGroup,
  markGroup,
  markStep,
  resetDeadStep,
} from './store'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let tenantId: string
let erpCompanyId: string

// Directly sets a group/step's status (and, for steps, other columns) by
// raw update — a shorthand for seeding fixture states (e.g. 'dead',
// 'succeeded') that the store's own public API has no direct setter for
// (markStep/markGroup exist, but tests still need a group in a given state
// as setup, not just as an assertion target).
async function setGroupStatus(groupId: string, status: string) {
  await db.update(schema.erpPushGroups).set({ status }).where(eq(schema.erpPushGroups.id, groupId))
}

async function setGroupCreatedAt(groupId: string, createdAt: Date) {
  await db.update(schema.erpPushGroups).set({ createdAt }).where(eq(schema.erpPushGroups.id, groupId))
}

async function getGroup(groupId: string) {
  const [group] = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.id, groupId))
  return group
}

async function makeGroup(lane: string, entityId = randomUUID()) {
  return createPushGroup(db, {
    tenantId,
    erpCompanyId,
    lane,
    kind: 'order_create',
    steps: [{ seq: 1, entityType: 'serviceOrder', entityId, register: 'SVOVc', op: 'create' }],
  })
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  // Idempotency proof (task self-review): re-execute 0017's own raw SQL
  // statements twice more, straight to Postgres, bypassing the
  // filename-skip in herbe_migrations.applied entirely — same convention as
  // the 0002-0007 blocks in __tests__/db/migrate.test.ts.
  const rawSql = postgres(testDb.url, { max: 1 })
  const content = fs.readFileSync('scripts/migrations/0017_erp_push_queue.sql', 'utf8')
  const statements = splitSqlStatements(content)
  for (let pass = 0; pass < 2; pass++) {
    for (const stmt of statements) {
      await rawSql.unsafe(stmt)
    }
  }
  await rawSql.end({ timeout: 5 })

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('createPushGroup + getStepsForGroup', () => {
  it('inserts the group and its steps atomically; steps come back ordered by seq regardless of insert order', async () => {
    const orderId = randomUUID()
    const worksheetId = randomUUID()

    const { groupId } = await createPushGroup(db, {
      tenantId,
      erpCompanyId,
      lane: `order:${orderId}`,
      kind: 'worksheet_push',
      steps: [
        { seq: 2, entityType: 'worksheet', entityId: worksheetId, register: 'WSVc', op: 'create' },
        { seq: 1, entityType: 'serviceOrder', entityId: orderId, register: 'SVOVc', op: 'create' },
      ],
    })

    expect(groupId).toBeTruthy()

    const group = await getGroup(groupId)
    expect(group.tenantId).toBe(tenantId)
    expect(group.erpCompanyId).toBe(erpCompanyId)
    expect(group.lane).toBe(`order:${orderId}`)
    expect(group.kind).toBe('worksheet_push')
    expect(group.status).toBe('pending')

    const steps = await getStepsForGroup(db, groupId)
    expect(steps.map((s) => s.seq)).toEqual([1, 2])
    expect(steps[0]).toMatchObject({
      entityType: 'serviceOrder',
      entityId: orderId,
      register: 'SVOVc',
      op: 'create',
      status: 'pending',
      attempts: 0,
    })
    expect(steps[1]).toMatchObject({
      entityType: 'worksheet',
      entityId: worksheetId,
      register: 'WSVc',
      op: 'create',
    })
  })

  it('rolls back the group when a step insert fails (duplicate seq violates the group_id+seq unique constraint)', async () => {
    const entityId = randomUUID()
    const lane = `order:${randomUUID()}`

    await expect(
      createPushGroup(db, {
        tenantId,
        erpCompanyId,
        lane,
        kind: 'order_create',
        steps: [
          { seq: 1, entityType: 'serviceOrder', entityId, register: 'SVOVc', op: 'create' },
          { seq: 1, entityType: 'serviceOrder', entityId, register: 'SVOVc', op: 'create' },
        ],
      }),
    ).rejects.toThrow()

    const groupsInLane = await db.select().from(schema.erpPushGroups).where(eq(schema.erpPushGroups.lane, lane))
    expect(groupsInLane).toHaveLength(0)
  })
})

describe('getRunnableGroups', () => {
  it('returns only the OLDEST group per lane (FIFO): a second, newer group in the same lane is excluded', async () => {
    const lane = `order:${randomUUID()}`
    const older = await makeGroup(lane)
    await setGroupCreatedAt(older.groupId, new Date(Date.now() - 60_000))
    const newer = await makeGroup(lane)
    await setGroupCreatedAt(newer.groupId, new Date())

    const runnable = await getRunnableGroups(db, erpCompanyId, new Date())
    const forLane = runnable.filter((r) => r.group.lane === lane)

    expect(forLane).toHaveLength(1)
    expect(forLane[0].group.id).toBe(older.groupId)
    expect(forLane[0].steps).toHaveLength(1)
    expect(forLane[0].steps[0].seq).toBe(1)
  })

  it('a dead group blocks its lane entirely, even though a newer pending group exists behind it', async () => {
    const lane = `order:${randomUUID()}`
    const dead = await makeGroup(lane)
    await setGroupCreatedAt(dead.groupId, new Date(Date.now() - 60_000))
    await setGroupStatus(dead.groupId, 'dead')
    const pending = await makeGroup(lane)
    await setGroupCreatedAt(pending.groupId, new Date())

    const runnable = await getRunnableGroups(db, erpCompanyId, new Date())
    const forLane = runnable.filter((r) => r.group.lane === lane)

    expect(forLane).toHaveLength(0)
  })

  it('a succeeded group does not block its lane: the next non-succeeded group is returned instead', async () => {
    const lane = `order:${randomUUID()}`
    const succeeded = await makeGroup(lane)
    await setGroupCreatedAt(succeeded.groupId, new Date(Date.now() - 60_000))
    await setGroupStatus(succeeded.groupId, 'succeeded')
    const pending = await makeGroup(lane)
    await setGroupCreatedAt(pending.groupId, new Date())

    const runnable = await getRunnableGroups(db, erpCompanyId, new Date())
    const forLane = runnable.filter((r) => r.group.lane === lane)

    expect(forLane).toHaveLength(1)
    expect(forLane[0].group.id).toBe(pending.groupId)
  })

  it('gates a group out when one of its steps has next_attempt_at in the future', async () => {
    const lane = `order:${randomUUID()}`
    const { groupId } = await makeGroup(lane)
    await setGroupStatus(groupId, 'failed')
    const [step] = await getStepsForGroup(db, groupId)
    const future = new Date(Date.now() + 60_000)
    await markStep(db, step.id, { status: 'failed', nextAttemptAt: future })

    const before = await getRunnableGroups(db, erpCompanyId, new Date())
    expect(before.some((r) => r.group.id === groupId)).toBe(false)

    const after = await getRunnableGroups(db, erpCompanyId, new Date(future.getTime() + 1))
    expect(after.some((r) => r.group.id === groupId)).toBe(true)
  })

  it('includes a group whose next_attempt_at is exactly now (only strictly-future gates it out)', async () => {
    const lane = `order:${randomUUID()}`
    const { groupId } = await makeGroup(lane)
    const [step] = await getStepsForGroup(db, groupId)
    const now = new Date()
    await markStep(db, step.id, { nextAttemptAt: now })

    const runnable = await getRunnableGroups(db, erpCompanyId, now)
    expect(runnable.some((r) => r.group.id === groupId)).toBe(true)
  })

  it('does not return groups belonging to a different erpCompanyId', async () => {
    const [otherCompany] = await db
      .insert(schema.erpCompanies)
      .values({ tenantId, displayName: 'Other Co', adapterType: 'standard_books', adapterConfigJson: {} })
      .returning()

    const lane = `order:${randomUUID()}`
    await createPushGroup(db, {
      tenantId,
      erpCompanyId: otherCompany.id,
      lane,
      kind: 'order_create',
      steps: [{ seq: 1, entityType: 'serviceOrder', entityId: randomUUID(), register: 'SVOVc', op: 'create' }],
    })

    const runnable = await getRunnableGroups(db, erpCompanyId, new Date())
    expect(runnable.some((r) => r.group.lane === lane)).toBe(false)
  })
})

describe('claimGroup', () => {
  it('claims a pending group (sets it running); an immediate second claim on the same group returns false', async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    const now = new Date('2026-01-01T00:00:00Z')

    const first = await claimGroup(db, groupId, now)
    expect(first).toBe(true)
    expect((await getGroup(groupId)).status).toBe('running')

    const second = await claimGroup(db, groupId, new Date(now.getTime() + 1))
    expect(second).toBe(false)
  })

  it('claims a failed group', async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    await setGroupStatus(groupId, 'failed')

    const claimed = await claimGroup(db, groupId, new Date('2026-01-01T00:00:00Z'))
    expect(claimed).toBe(true)
    expect((await getGroup(groupId)).status).toBe('running')
  })

  it('refuses a fresh running group (updated_at within the 10-minute reclaim window)', async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    await setGroupStatus(groupId, 'running')
    await db
      .update(schema.erpPushGroups)
      .set({ updatedAt: new Date('2026-01-01T00:09:00Z') })
      .where(eq(schema.erpPushGroups.id, groupId))

    const claimed = await claimGroup(db, groupId, new Date('2026-01-01T00:10:00Z')) // only 1 minute stale
    expect(claimed).toBe(false)
    expect((await getGroup(groupId)).status).toBe('running')
  })

  it("reclaims a running group whose updated_at is more than 10 minutes older than `now` (crash recovery)", async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    await setGroupStatus(groupId, 'running')
    await db
      .update(schema.erpPushGroups)
      .set({ updatedAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(schema.erpPushGroups.id, groupId))

    const claimed = await claimGroup(db, groupId, new Date('2026-01-01T00:10:01Z')) // 10:01 stale
    expect(claimed).toBe(true)
    expect((await getGroup(groupId)).status).toBe('running')
  })
})

describe('markStep', () => {
  it('applies only the fields present in the patch, leaving others untouched', async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    const [step] = await getStepsForGroup(db, groupId)

    await markStep(db, step.id, { status: 'running' })
    let [updated] = await getStepsForGroup(db, groupId)
    expect(updated.status).toBe('running')
    expect(updated.attempts).toBe(0)
    expect(updated.erpRef).toBeNull()

    await markStep(db, step.id, { attempts: 3, erpRef: 'SVO-123', errorMessage: 'transient 500' })
    ;[updated] = await getStepsForGroup(db, groupId)
    expect(updated.status).toBe('running') // untouched by the second patch
    expect(updated.attempts).toBe(3)
    expect(updated.erpRef).toBe('SVO-123')
    expect(updated.errorMessage).toBe('transient 500')
  })

  it('can explicitly clear nextAttemptAt/erpRef/errorMessage back to null', async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    const [step] = await getStepsForGroup(db, groupId)
    await markStep(db, step.id, { erpRef: 'SVO-999', errorMessage: 'boom', nextAttemptAt: new Date() })

    await markStep(db, step.id, { erpRef: null, errorMessage: null, nextAttemptAt: null })

    const [cleared] = await getStepsForGroup(db, groupId)
    expect(cleared.erpRef).toBeNull()
    expect(cleared.errorMessage).toBeNull()
    expect(cleared.nextAttemptAt).toBeNull()
  })
})

describe('markGroup', () => {
  it('sets the group status', async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    await markGroup(db, groupId, 'succeeded')
    const group = await getGroup(groupId)
    expect(group.status).toBe('succeeded')
  })
})

describe('resetDeadStep', () => {
  it('resets a dead step (attempts=0, nextAttemptAt/errorMessage cleared, status pending) AND its group back to pending', async () => {
    const { groupId } = await makeGroup(`order:${randomUUID()}`)
    const [step] = await getStepsForGroup(db, groupId)
    await markStep(db, step.id, {
      status: 'dead',
      attempts: 5,
      nextAttemptAt: new Date(Date.now() + 3_600_000),
      errorMessage: 'number-series onboarding required',
    })
    await markGroup(db, groupId, 'dead')

    await resetDeadStep(db, step.id)

    const [resetStep] = await getStepsForGroup(db, groupId)
    expect(resetStep.status).toBe('pending')
    expect(resetStep.attempts).toBe(0)
    expect(resetStep.nextAttemptAt).toBeNull()
    expect(resetStep.errorMessage).toBeNull()

    const group = await getGroup(groupId)
    expect(group.status).toBe('pending')
  })

  it('is a no-op for a stepId that does not exist (no group update attempted)', async () => {
    await expect(resetDeadStep(db, randomUUID())).resolves.toBeUndefined()
  })

  it('round-trips through getRunnableGroups: a dead group blocks its lane, resetDeadStep un-blocks it', async () => {
    const lane = `order:${randomUUID()}`
    const { groupId } = await makeGroup(lane)
    const [step] = await getStepsForGroup(db, groupId)
    await markStep(db, step.id, { status: 'dead', attempts: 5 })
    await markGroup(db, groupId, 'dead')

    const blocked = await getRunnableGroups(db, erpCompanyId, new Date())
    expect(blocked.some((r) => r.group.lane === lane)).toBe(false)

    await resetDeadStep(db, step.id)

    const unblocked = await getRunnableGroups(db, erpCompanyId, new Date())
    const forLane = unblocked.filter((r) => r.group.lane === lane)
    expect(forLane).toHaveLength(1)
    expect(forLane[0].group.id).toBe(groupId)
  })
})
