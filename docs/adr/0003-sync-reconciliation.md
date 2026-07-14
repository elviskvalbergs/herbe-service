# ADR 0003: Sync reconciliation — key-sweep doubles as sequence-reset recovery

## Status
Accepted — mechanism implemented and tested in Task 11; live-ERP confirmation
pending Non-Code Prerequisite 2 (a planned ERP version upgrade during Phase 0/1).

## Context
`updates_after`/`@sequence` incremental sync (Task 10) is confirmed to work on
`CUVc` but is known to reset after ERP version upgrades (`19-demo-probe-results.md`).
`deletes_after` is confirmed unreliable everywhere (HTTP 204 empty body, even
on `CUVc`) — deletions can never be detected incrementally.

## Decision
One mechanism serves both problems: `keySweepReconcile` (`lib/sync/ingest/key-sweep.ts`,
Task 11) does a full list-and-diff pass per register, independent of any cursor —
it pages every live `erpRef` from the adapter, diffs against stored non-deleted
rows for the company, and soft-deletes (`deletedAt`) whatever no longer exists.
Deletion detection *requires* this full scan regardless of sequence-reset risk,
so sequence-reset recovery is free — a full reconciliation pass is already
scheduled nightly per register; on detecting the incremental cursor has gone
stale (the ERP's returned `@sequence` is lower than the stored cursor,
indicating a reset), the sync-tick dispatcher (`app/api/cron/sync-tick/route.ts`,
Task 12) falls back to treating the next scheduled sweep as authoritative
rather than trusting the stale cursor.

**Evidence already shipped (Task 11, `lib/sync/ingest/key-sweep.ts` +
`lib/sync/ingest/key-sweep.test.ts`):**
- `keySweepReconcile` pages live refs from an adapter (`RefListingAdapter.listLiveRefs`),
  diffs against stored `erpRef`s scoped by `erpCompanyId`, and tombstones the
  ones no longer live — proven for both `CUVc` (customers) and `INVc` (items).
- The tombstone `UPDATE` is scoped by `erpCompanyId` as well as `erpRef` —
  regression-tested against two companies sharing the same `erpRef` (`erpRef`
  is only unique per company), so a sweep in one company never touches another's row.
- Tombstoning bumps `changeSeq` the same as any other write, so device delta
  polling (`changeSeq > X`) sees deletions like any other change — asserted directly.
- Task 11 also validated the migration runner's plpgsql handling on the real
  `0002` migration (`scripts/migrations/0002_domain_customers_items.sql`):
  the dollar-quoted `bump_change_seq()` function and its two `DROP TRIGGER IF
  EXISTS` / `CREATE TRIGGER` pairs apply cleanly via `runMigrations`, a second
  run is a clean no-op, and a raw-SQL re-execution test (`b6e15fa`) proves the
  migration's own `IF NOT EXISTS` / `CREATE OR REPLACE` / `DROP TRIGGER IF
  EXISTS` idempotency holds independently of the runner's filename-tracking skip.

**Not yet coded, as of Task 11:** the sequence-reset *detection* guard itself —
comparing the ERP's returned `@sequence` against the stored cursor and falling
back to the sweep on a regression — is not present in `app/api/cron/sync-tick/route.ts`.
The dispatcher today only stores whatever cursor `pullChanges` returns; it does
not compare it against the prior value. This is a small, well-understood
addition, but it is deliberately left uncoded until Non-Code Prerequisite 2 (a
scheduled ERP version upgrade) gives a real reset event to validate against,
rather than writing the guard against a synthetic one.

## Consequences
- No separate "sequence-reset handler" module — it's an emergent property of
  always running key-sweep on a schedule. Do not build a second mechanism.
- Gap tolerance: a record deleted in the ERP may linger up to one sweep
  interval (nightly, Task 11) before the app sees the tombstone — acceptable
  for master data (customers/items); Phase 1 service-order deletions get a
  tighter, explicitly-flagged path instead of silent tombstoning
  (`04-erp-sync.md`).
- **Live confirmation still needed**: this ADR's sequence-reset-detection logic
  (comparing returned `@sequence` against the stored cursor) is not yet coded
  as of Task 11 — add a small guard in Task 12's dispatcher when Prerequisite 2
  (the planned version upgrade) is scheduled, so there's a real reset event to
  validate against instead of a synthetic one.
