// lib/sync/scope-membership.ts
//
// Scoped-replication mechanism (03-architecture.md "Scoped replication"),
// proven here against a synthetic entityType ('note') — see ADR 0005 and
// Task 22. Phase 1 reuses these functions unchanged for real assignment-
// scoped entities (orders/worksheets/bookings), just passing a real
// entityType.
//
// membershipSeq/outScopeSeq are stamped by the bump_membership_seq()
// plpgsql trigger (0007 migration) from the SAME domain_change_seq sequence
// Task 11's bump_change_seq() uses — one shared monotonic space, so a
// device's delta cursor advances consistently across both changeSeq and
// membershipSeq. The `0` passed in .values() below is a placeholder always
// overwritten by that trigger before the row is written (same pattern as
// lib/sync/ingest/customers.ts).
import { and, eq, gt } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'

export async function enterScope(
  db: PostgresJsDatabase<typeof schema>,
  opts: { userId: string; entityType: string; entityId: string },
): Promise<void> {
  // Entry always backfills as a full upsert regardless of the record's own
  // change history — re-entering scope (e.g. reassigned back) clears any
  // prior outScopeSeq and bumps membershipSeq again.
  await db
    .insert(schema.scopeMembership)
    .values({ userId: opts.userId, entityType: opts.entityType, entityId: opts.entityId, membershipSeq: BigInt(0) })
    .onConflictDoUpdate({
      target: [schema.scopeMembership.userId, schema.scopeMembership.entityType, schema.scopeMembership.entityId],
      set: { outScopeSeq: null, inScopeSince: new Date(), membershipSeq: BigInt(0) },
    })
}

export async function exitScope(
  db: PostgresJsDatabase<typeof schema>,
  opts: { userId: string; entityType: string; entityId: string },
): Promise<void> {
  await db
    .update(schema.scopeMembership)
    .set({ outScopeSeq: BigInt(0) }) // placeholder — overwritten by bump_membership_seq() as well
    .where(
      and(
        eq(schema.scopeMembership.userId, opts.userId),
        eq(schema.scopeMembership.entityType, opts.entityType),
        eq(schema.scopeMembership.entityId, opts.entityId),
      ),
    )
}

export async function pullScopedDelta(
  db: PostgresJsDatabase<typeof schema>,
  opts: { userId: string; sinceMembershipSeq: string },
): Promise<{ upserts: Array<{ entityType: string; entityId: string }>; exitedIds: string[]; cursor: string }> {
  const rows = await db
    .select()
    .from(schema.scopeMembership)
    .where(
      and(
        eq(schema.scopeMembership.userId, opts.userId),
        gt(schema.scopeMembership.membershipSeq, BigInt(opts.sinceMembershipSeq)),
      ),
    )
    .orderBy(schema.scopeMembership.membershipSeq)

  const upserts = rows
    .filter((r) => r.outScopeSeq === null)
    .map((r) => ({ entityType: r.entityType, entityId: r.entityId }))
  const exitedIds = rows.filter((r) => r.outScopeSeq !== null).map((r) => r.entityId)
  const cursor = rows.length ? String(rows[rows.length - 1].membershipSeq) : opts.sinceMembershipSeq

  return { upserts, exitedIds, cursor }
}
