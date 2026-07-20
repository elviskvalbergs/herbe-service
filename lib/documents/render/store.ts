// lib/documents/render/store.ts
//
// WS12 render-job queue store (docs/superpowers/plans/
// 2026-07-20-service-phase1-ws12-documents.md decision 4): the WS4
// push-queue idioms (lib/sync/push/store.ts) applied to document_render_jobs
// — plain-text status ('queued'|'running'|'done'|'dead'), attempts +
// next_attempt_at backoff (2^attempts minutes), dead after 8 attempts,
// operator re-entry mirroring resetDeadStep. This module only persists
// state; render semantics live in engine.ts, its sole consumer.
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { DocumentRenderJobRow } from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

export const RENDER_MAX_ATTEMPTS = 8
const BACKOFF_BASE_MS = 60_000 // one minute; next_attempt_at = now + 2^attempts minutes

export interface EnqueueRenderJobInput {
  tenantId: string
  erpCompanyId?: string | null
  docType: string
  orderId: string
  trigger: 'approval' | 'manual'
}

/**
 * Coalescing enqueue: an existing 'queued' job for (tenant, docType, order)
 * absorbs the new trigger — no duplicate row. The dedupe check and the
 * insert are ONE statement (INSERT … SELECT … WHERE NOT EXISTS), so a
 * sequential second call always sees the first's committed row.
 *
 * Two truly CONCURRENT calls can still both pass the NOT EXISTS (neither
 * insert is visible to the other) and create two queued jobs — migration
 * 0021 has no partial unique index to fence this, and adding one is not
 * this task. That lost race is tolerated by design: the claim loop picks
 * both up, both render, and the second simply becomes a new version of the
 * same document number.
 */
export async function enqueueRenderJob(
  db: Db,
  input: EnqueueRenderJobInput,
): Promise<DocumentRenderJobRow> {
  const dedupe = and(
    eq(schema.documentRenderJobs.tenantId, input.tenantId),
    eq(schema.documentRenderJobs.docType, input.docType),
    eq(schema.documentRenderJobs.orderId, input.orderId),
    eq(schema.documentRenderJobs.status, 'queued'),
  )

  const inserted = await db.execute(sql`
    INSERT INTO document_render_jobs (tenant_id, erp_company_id, doc_type, order_id, "trigger")
    SELECT ${input.tenantId}, ${input.erpCompanyId ?? null}, ${input.docType}, ${input.orderId}, ${input.trigger}
    WHERE NOT EXISTS (
      SELECT 1 FROM document_render_jobs
      WHERE tenant_id = ${input.tenantId}
        AND doc_type = ${input.docType}
        AND order_id = ${input.orderId}
        AND status = 'queued'
    )
    RETURNING id
  `)

  const insertedId = (inserted as unknown as { id: string }[])[0]?.id
  if (insertedId) {
    const [row] = await db
      .select()
      .from(schema.documentRenderJobs)
      .where(eq(schema.documentRenderJobs.id, insertedId))
    return row
  }

  // NOT EXISTS blocked the insert: return the absorbing queued job.
  const [existing] = await db
    .select()
    .from(schema.documentRenderJobs)
    .where(dedupe)
    .orderBy(asc(schema.documentRenderJobs.createdAt))
    .limit(1)
  if (existing) return existing

  /* v8 ignore next 9 — needs a claim racing between the two statements
     above: the queued row that blocked the insert was claimed before we
     re-read it, so a fresh job is genuinely needed. */
  const [row] = await db
    .insert(schema.documentRenderJobs)
    .values({
      tenantId: input.tenantId,
      erpCompanyId: input.erpCompanyId ?? null,
      docType: input.docType,
      orderId: input.orderId,
      trigger: input.trigger,
    })
    .returning()
  return row
}

/**
 * Atomically claim up to `limit` due queued jobs (oldest first) by flipping
 * them to 'running'. FOR UPDATE SKIP LOCKED in the id-subselect makes two
 * concurrent claimers take disjoint sets — the second skips rows the first
 * holds locks on instead of blocking or double-claiming.
 */
export async function claimDueJobs(
  db: Db,
  { now, limit }: { now: Date; limit: number },
): Promise<DocumentRenderJobRow[]> {
  const due = db
    .select({ id: schema.documentRenderJobs.id })
    .from(schema.documentRenderJobs)
    .where(
      and(
        eq(schema.documentRenderJobs.status, 'queued'),
        lte(schema.documentRenderJobs.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(schema.documentRenderJobs.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true })

  return db
    .update(schema.documentRenderJobs)
    .set({ status: 'running', updatedAt: now })
    .where(inArray(schema.documentRenderJobs.id, due))
    .returning()
}

export async function markJobDone(db: Db, id: string): Promise<void> {
  await db
    .update(schema.documentRenderJobs)
    .set({ status: 'done', updatedAt: new Date() })
    .where(eq(schema.documentRenderJobs.id, id))
}

export interface MarkJobFailedInput {
  id: string
  error: string
  now: Date
}

/**
 * WS4 backoff idiom (lib/sync/push/engine.ts runStep): attempts+1; dead at
 * RENDER_MAX_ATTEMPTS, else back to 'queued' with next_attempt_at =
 * now + 2^attempts minutes. Two statements, but only the claimer that
 * flipped the job to 'running' ever calls this — no concurrent writer.
 */
export async function markJobFailed(
  db: Db,
  { id, error, now }: MarkJobFailedInput,
): Promise<DocumentRenderJobRow> {
  const [job] = await db
    .select()
    .from(schema.documentRenderJobs)
    .where(eq(schema.documentRenderJobs.id, id))
  if (!job) throw new Error(`document render job ${id} not found`)

  const attempts = job.attempts + 1
  const lastError = error.slice(0, 1000)
  const patch =
    attempts >= RENDER_MAX_ATTEMPTS
      ? { status: 'dead', attempts, lastError, updatedAt: now }
      : {
          status: 'queued',
          attempts,
          lastError,
          updatedAt: now,
          nextAttemptAt: new Date(now.getTime() + 2 ** attempts * BACKOFF_BASE_MS),
        }

  const [updated] = await db
    .update(schema.documentRenderJobs)
    .set(patch)
    .where(eq(schema.documentRenderJobs.id, id))
    .returning()
  return updated
}

/**
 * Operator re-entry for a dead job (mirrors resetDeadStep in
 * lib/sync/push/store.ts): back to 'queued', counters cleared, immediately
 * due. Guarded on status = 'dead' so a stray id can never yank a running
 * job out from under its claimer. No-op when the job isn't dead.
 */
export async function resetDeadRenderJob(db: Db, id: string): Promise<void> {
  await db
    .update(schema.documentRenderJobs)
    .set({
      status: 'queued',
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.documentRenderJobs.id, id), eq(schema.documentRenderJobs.status, 'dead')))
}
