// lib/documents/render/store.test.ts
//
// WS12 Task 6 — render-job queue store (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decision 4): coalescing
// enqueue, FOR UPDATE SKIP LOCKED claim, WS4-style backoff (2^attempts
// minutes, dead after 8), DLQ re-entry. The concurrent-claim test runs each
// claim on a SEPARATE postgres() client (the number-series.test.ts
// technique) so SKIP LOCKED is exercised by two real backend sessions.
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import {
  claimDueJobs,
  enqueueRenderJob,
  markJobDone,
  markJobFailed,
  RENDER_MAX_ATTEMPTS,
  resetDeadRenderJob,
} from './store'

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let sql2: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let db2: ReturnType<typeof drizzle<typeof schema>>

let tenantId: string
let erpCompanyId: string
let customerId: string

const NOW = new Date('2026-07-20T10:00:00Z')
const MINUTE = 60_000

async function newOrder(): Promise<string> {
  const [order] = await db
    .insert(schema.serviceOrders)
    .values({ tenantId, customerId, changeSeq: BigInt(0) })
    .returning()
  return order.id
}

async function enqueueForNewOrder() {
  return enqueueRenderJob(db, {
    tenantId,
    docType: 'order_report',
    orderId: await newOrder(),
    trigger: 'manual',
  })
}

async function jobById(id: string) {
  const [row] = await db
    .select()
    .from(schema.documentRenderJobs)
    .where(eq(schema.documentRenderJobs.id, id))
  return row
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  sql = postgres(testDb.url)
  sql2 = postgres(testDb.url)
  db = drizzle(sql, { schema })
  db2 = drizzle(sql2, { schema })

  const [tenant] = await db.insert(schema.tenants).values({ slug: 't1', name: 'T1' }).returning()
  tenantId = tenant.id
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId, displayName: 'C1', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  erpCompanyId = company.id
  const [customer] = await db
    .insert(schema.customers)
    .values({ tenantId, erpCompanyId, erpRef: 'CUST-1', name: 'Acme', changeSeq: BigInt(0) })
    .returning()
  customerId = customer.id
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await sql2?.end({ timeout: 5 })
  await testDb?.cleanup()
})

describe('enqueueRenderJob', () => {
  it('inserts a queued, immediately due job with defaults', async () => {
    const orderId = await newOrder()
    const job = await enqueueRenderJob(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      trigger: 'approval',
    })

    expect(job.status).toBe('queued')
    expect(job.attempts).toBe(0)
    expect(job.trigger).toBe('approval')
    expect(job.docType).toBe('order_report')
    expect(job.orderId).toBe(orderId)
    expect(job.erpCompanyId).toBeNull()
    expect(job.lastError).toBeNull()
    expect(job.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('stores erpCompanyId when provided', async () => {
    const job = await enqueueRenderJob(db, {
      tenantId,
      erpCompanyId,
      docType: 'order_report',
      orderId: await newOrder(),
      trigger: 'manual',
    })
    expect(job.erpCompanyId).toBe(erpCompanyId)
  })

  it('coalesces: a second enqueue for the same (tenant, docType, order) returns the existing queued job', async () => {
    const orderId = await newOrder()
    const first = await enqueueRenderJob(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      trigger: 'approval',
    })
    const second = await enqueueRenderJob(db, {
      tenantId,
      docType: 'order_report',
      orderId,
      trigger: 'manual',
    })

    expect(second.id).toBe(first.id)
    expect(second.trigger).toBe('approval') // the existing job's trigger wins

    const rows = await db
      .select()
      .from(schema.documentRenderJobs)
      .where(
        and(
          eq(schema.documentRenderJobs.tenantId, tenantId),
          eq(schema.documentRenderJobs.docType, 'order_report'),
          eq(schema.documentRenderJobs.orderId, orderId),
        ),
      )
    expect(rows).toHaveLength(1)
  })

  it('does not coalesce across docType', async () => {
    const orderId = await newOrder()
    const report = await enqueueRenderJob(db, { tenantId, docType: 'order_report', orderId, trigger: 'manual' })
    const confirmation = await enqueueRenderJob(db, {
      tenantId,
      docType: 'order_confirmation',
      orderId,
      trigger: 'manual',
    })
    expect(confirmation.id).not.toBe(report.id)
  })

  it('a done job does not absorb a new enqueue — a fresh job is created', async () => {
    const orderId = await newOrder()
    const first = await enqueueRenderJob(db, { tenantId, docType: 'order_report', orderId, trigger: 'manual' })
    await markJobDone(db, first.id)

    const second = await enqueueRenderJob(db, { tenantId, docType: 'order_report', orderId, trigger: 'manual' })
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('queued')
  })
})

// A fresh enqueue's next_attempt_at is the DB server's now(), which lands a
// few ms AFTER a client `new Date()` taken right afterwards (statement
// latency). Claims below that mean "everything currently due" therefore use
// a now slightly in the future — real cron ticks run minutes after enqueue.
function claimNow(): Date {
  return new Date(Date.now() + 1000)
}

describe('claimDueJobs', () => {
  it('claims a due queued job, flips it to running with updated_at = now', async () => {
    const job = await enqueueForNewOrder()

    const claimed = await claimDueJobs(db, { now: claimNow(), limit: 100 })
    const mine = claimed.find((j) => j.id === job.id)
    expect(mine).toBeDefined()
    expect(mine!.status).toBe('running')

    const row = await jobById(job.id)
    expect(row.status).toBe('running')
  })

  it('respects the limit, oldest created_at first', async () => {
    const a = await enqueueForNewOrder()
    const b = await enqueueForNewOrder()
    const c = await enqueueForNewOrder()
    // Deterministic ordering: push these three BEFORE anything earlier
    // suites may have left queued (created_at defaults to now()).
    await db.update(schema.documentRenderJobs).set({ createdAt: new Date('2026-01-01T08:00:00Z') }).where(eq(schema.documentRenderJobs.id, a.id))
    await db.update(schema.documentRenderJobs).set({ createdAt: new Date('2026-01-01T08:01:00Z') }).where(eq(schema.documentRenderJobs.id, b.id))
    await db.update(schema.documentRenderJobs).set({ createdAt: new Date('2026-01-01T08:02:00Z') }).where(eq(schema.documentRenderJobs.id, c.id))

    const claimed = await claimDueJobs(db, { now: claimNow(), limit: 2 })
    expect(claimed.map((j) => j.id).sort()).toEqual([a.id, b.id].sort())
    expect((await jobById(c.id)).status).toBe('queued')
  })

  it('skips running, done, dead, and not-yet-due jobs', async () => {
    const running = await enqueueForNewOrder()
    const done = await enqueueForNewOrder()
    const dead = await enqueueForNewOrder()
    const future = await enqueueForNewOrder()
    await db.update(schema.documentRenderJobs).set({ status: 'running' }).where(eq(schema.documentRenderJobs.id, running.id))
    await db.update(schema.documentRenderJobs).set({ status: 'done' }).where(eq(schema.documentRenderJobs.id, done.id))
    await db.update(schema.documentRenderJobs).set({ status: 'dead' }).where(eq(schema.documentRenderJobs.id, dead.id))
    await db
      .update(schema.documentRenderJobs)
      .set({ nextAttemptAt: new Date(NOW.getTime() + 60 * MINUTE) })
      .where(eq(schema.documentRenderJobs.id, future.id))

    const claimed = await claimDueJobs(db, { now: NOW, limit: 100 })
    const claimedIds = new Set(claimed.map((j) => j.id))
    expect(claimedIds.has(running.id)).toBe(false)
    expect(claimedIds.has(done.id)).toBe(false)
    expect(claimedIds.has(dead.id)).toBe(false)
    expect(claimedIds.has(future.id)).toBe(false)
  })

  it('CONCURRENCY: two claims on separate connections take disjoint sets (SKIP LOCKED)', async () => {
    // Drain anything earlier suites left queued, then seed exactly four.
    await claimDueJobs(db, { now: claimNow(), limit: 1000 })
    const jobs = await Promise.all([
      enqueueForNewOrder(),
      enqueueForNewOrder(),
      enqueueForNewOrder(),
      enqueueForNewOrder(),
    ])

    const now = claimNow()
    const [a, b] = await Promise.all([
      claimDueJobs(db, { now, limit: 2 }),
      claimDueJobs(db2, { now, limit: 2 }),
    ])

    const aIds = a.map((j) => j.id)
    const bIds = b.map((j) => j.id)
    expect(aIds.filter((id) => bIds.includes(id))).toEqual([]) // disjoint
    expect([...aIds, ...bIds].sort()).toEqual(jobs.map((j) => j.id).sort())
  })
})

describe('markJobDone', () => {
  it('flips the job to done', async () => {
    const job = await enqueueForNewOrder()
    await markJobDone(db, job.id)
    expect((await jobById(job.id)).status).toBe('done')
  })
})

describe('markJobFailed', () => {
  it('re-queues with attempts+1 and next_attempt_at = now + 2^attempts minutes', async () => {
    const job = await enqueueForNewOrder()

    const failed = await markJobFailed(db, { id: job.id, error: 'boom', now: NOW })
    expect(failed.status).toBe('queued')
    expect(failed.attempts).toBe(1)
    expect(failed.lastError).toBe('boom')
    expect(failed.nextAttemptAt.getTime()).toBe(NOW.getTime() + 2 * MINUTE) // 2^1

    // Not claimable at `now`, claimable once the backoff elapses.
    const early = await claimDueJobs(db, { now: NOW, limit: 100 })
    expect(early.map((j) => j.id)).not.toContain(job.id)
    const later = await claimDueJobs(db, { now: new Date(NOW.getTime() + 2 * MINUTE), limit: 100 })
    expect(later.map((j) => j.id)).toContain(job.id)
  })

  it('backoff doubles per attempt', async () => {
    const job = await enqueueForNewOrder()
    await markJobFailed(db, { id: job.id, error: 'e1', now: NOW })
    const second = await markJobFailed(db, { id: job.id, error: 'e2', now: NOW })
    expect(second.attempts).toBe(2)
    expect(second.nextAttemptAt.getTime()).toBe(NOW.getTime() + 4 * MINUTE) // 2^2
  })

  it('the 8th failure moves the job to dead', async () => {
    const job = await enqueueForNewOrder()
    for (let i = 1; i < RENDER_MAX_ATTEMPTS; i++) {
      const failed = await markJobFailed(db, { id: job.id, error: `attempt ${i}`, now: NOW })
      expect(failed.status).toBe('queued')
      expect(failed.attempts).toBe(i)
    }
    const dead = await markJobFailed(db, { id: job.id, error: 'final', now: NOW })
    expect(dead.status).toBe('dead')
    expect(dead.attempts).toBe(RENDER_MAX_ATTEMPTS)
    expect(dead.lastError).toBe('final')

    const claimed = await claimDueJobs(db, { now: new Date(NOW.getTime() + 1000 * MINUTE), limit: 100 })
    expect(claimed.map((j) => j.id)).not.toContain(job.id)
  })

  it('truncates last_error to 1000 chars', async () => {
    const job = await enqueueForNewOrder()
    const failed = await markJobFailed(db, { id: job.id, error: 'x'.repeat(5000), now: NOW })
    expect(failed.lastError).toHaveLength(1000)
  })

  it('throws for an unknown job id', async () => {
    await expect(
      markJobFailed(db, { id: crypto.randomUUID(), error: 'x', now: NOW }),
    ).rejects.toThrow(/not found/)
  })
})

describe('resetDeadRenderJob', () => {
  it('re-queues a dead job with attempts 0 and a due next_attempt_at', async () => {
    const job = await enqueueForNewOrder()
    await db
      .update(schema.documentRenderJobs)
      .set({ status: 'dead', attempts: RENDER_MAX_ATTEMPTS, lastError: 'gone' })
      .where(eq(schema.documentRenderJobs.id, job.id))

    await resetDeadRenderJob(db, job.id)

    const row = await jobById(job.id)
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(0)
    expect(row.lastError).toBeNull()

    const claimed = await claimDueJobs(db, { now: new Date(), limit: 100 })
    expect(claimed.map((j) => j.id)).toContain(job.id)
  })

  it('leaves non-dead jobs untouched', async () => {
    const job = await enqueueForNewOrder()
    const failed = await markJobFailed(db, { id: job.id, error: 'once', now: NOW })

    await resetDeadRenderJob(db, job.id)

    const row = await jobById(job.id)
    expect(row.attempts).toBe(1)
    expect(row.lastError).toBe('once')
    expect(row.nextAttemptAt.getTime()).toBe(failed.nextAttemptAt.getTime())
  })
})
