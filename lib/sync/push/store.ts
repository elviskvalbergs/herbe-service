// lib/sync/push/store.ts
//
// Store for the ERP push queue (WS4 outbound slice, docs/superpowers/plans/
// 2026-07-16-service-phase1-erp-outbound.md decisions 1-3): erp_push_groups
// is the FIFO saga unit per lane (0017_erp_push_queue.sql); erp_push_steps
// are the seq-ordered work items within a group. This module only persists
// and reads state — saga semantics (idempotency, retry backoff, DLQ
// transitions) live in the engine (Task 5), which is the sole consumer of
// this surface.
import { and, asc, eq, ne } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import type { PushGroupRow, PushStepRow } from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

/** Groups and steps share the same status vocabulary (decisions 1/3). */
export type PushStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead'

export interface CreatePushGroupStepInput {
  seq: number
  entityType: string
  entityId: string
  register: string
  op: string
}

export interface CreatePushGroupInput {
  tenantId: string
  erpCompanyId: string
  lane: string
  kind: string
  steps: CreatePushGroupStepInput[]
}

// Inserts the group and its steps in one transaction: a step-insert failure
// (e.g. a caller-supplied duplicate seq, which trips the group_id+seq
// unique constraint) must not leave an orphaned, step-less group behind.
export async function createPushGroup(
  db: Db,
  input: CreatePushGroupInput,
): Promise<{ groupId: string }> {
  return db.transaction(async (tx) => {
    const [group] = await tx
      .insert(schema.erpPushGroups)
      .values({
        tenantId: input.tenantId,
        erpCompanyId: input.erpCompanyId,
        lane: input.lane,
        kind: input.kind,
      })
      .returning()

    if (input.steps.length > 0) {
      await tx.insert(schema.erpPushSteps).values(
        input.steps.map((step) => ({
          groupId: group.id,
          seq: step.seq,
          entityType: step.entityType,
          entityId: step.entityId,
          register: step.register,
          op: step.op,
        })),
      )
    }

    return { groupId: group.id }
  })
}

export async function getStepsForGroup(db: Db, groupId: string): Promise<PushStepRow[]> {
  return db
    .select()
    .from(schema.erpPushSteps)
    .where(eq(schema.erpPushSteps.groupId, groupId))
    .orderBy(asc(schema.erpPushSteps.seq))
}

export interface RunnableGroup {
  group: PushGroupRow
  steps: PushStepRow[]
}

// Per lane, the FIFO "gate" is the OLDEST group whose status isn't the sole
// terminal state ('succeeded' — skipped over, never blocking). If that gate
// group is 'dead', its lane produces nothing (a dead group blocks the lane
// until an operator calls resetDeadStep). Otherwise the gate group runs only
// if none of its steps have next_attempt_at in the future — this never
// skips ahead to a newer group in the same lane; a not-yet-ready gate group
// simply means the lane yields nothing this tick.
export async function getRunnableGroups(db: Db, erpCompanyId: string, now: Date): Promise<RunnableGroup[]> {
  const activeGroups = await db
    .select()
    .from(schema.erpPushGroups)
    .where(and(eq(schema.erpPushGroups.erpCompanyId, erpCompanyId), ne(schema.erpPushGroups.status, 'succeeded')))
    .orderBy(asc(schema.erpPushGroups.lane), asc(schema.erpPushGroups.createdAt))

  const gateGroupByLane = new Map<string, PushGroupRow>()
  for (const group of activeGroups) {
    if (!gateGroupByLane.has(group.lane)) {
      gateGroupByLane.set(group.lane, group)
    }
  }

  const runnable: RunnableGroup[] = []
  for (const group of gateGroupByLane.values()) {
    if (group.status === 'dead') continue

    const steps = await getStepsForGroup(db, group.id)
    const gated = steps.some((step) => step.nextAttemptAt != null && step.nextAttemptAt > now)
    if (gated) continue

    runnable.push({ group, steps })
  }

  return runnable
}

export interface MarkStepPatch {
  status?: PushStatus
  attempts?: number
  nextAttemptAt?: Date | null
  erpRef?: string | null
  errorMessage?: string | null
}

export async function markStep(db: Db, stepId: string, patch: MarkStepPatch): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (patch.status !== undefined) set.status = patch.status
  if (patch.attempts !== undefined) set.attempts = patch.attempts
  if (patch.nextAttemptAt !== undefined) set.nextAttemptAt = patch.nextAttemptAt
  if (patch.erpRef !== undefined) set.erpRef = patch.erpRef
  if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage

  await db.update(schema.erpPushSteps).set(set).where(eq(schema.erpPushSteps.id, stepId))
}

export async function markGroup(db: Db, groupId: string, status: PushStatus): Promise<void> {
  await db
    .update(schema.erpPushGroups)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.erpPushGroups.id, groupId))
}

// The DLQ re-entry (app/api/admin/push-retry route, Task 6): an
// operator-retried dead step is reset AND its group put back to pending so
// the next engine tick resumes from this step.
export async function resetDeadStep(db: Db, stepId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [step] = await tx
      .update(schema.erpPushSteps)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: null, errorMessage: null, updatedAt: new Date() })
      .where(eq(schema.erpPushSteps.id, stepId))
      .returning()

    if (!step) return

    await tx
      .update(schema.erpPushGroups)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(schema.erpPushGroups.id, step.groupId))
  })
}
