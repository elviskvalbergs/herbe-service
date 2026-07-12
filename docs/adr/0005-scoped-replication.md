# ADR 0005: Scoped replication — membership table, proven via a synthetic scope-exit round trip

## Status
Accepted — mechanism implemented and tested (Task 22); full validation against
real assignment-scoped entities (orders/worksheets/bookings) happens in Phase 1
once those entities exist, per `06-roadmap.md`'s own framing ("scope model
validated in the Phase 0 sync spike").

## Context
`03-architecture.md`'s scoped-replication design requires a server-side
`(userId, entityType, entityId, inScopeSince, outScopeSeq)` table so a device's
delta feed can express "this record left your scope" — something a raw
high-water mark can't do (a job reassigned away produces no row update the old
device would see, yet its data, including gate codes, must leave that phone).

Phase 0 has no assignment-scoped entities yet — the customers/items this plan
syncs (Tasks 10–16) are explicitly the *tenant-wide unfiltered* category in
`03-architecture.md`'s scope model, not the assignment-scoped category, so
there is nothing in Phase 0's own data to scope-filter. Building a placeholder
worksheet purely to exercise scoping would be exactly the kind of speculative,
unused code the project avoids. This ADR validates the mechanism itself
against a generic `entityType` column (`'note'`), not a specific entity.

## Decision
Implemented exactly as specified: `scope_membership` rows carry their own
`membershipSeq` (drawn from the same shared `domain_change_seq` sequence Task
11's `bump_change_seq()` uses for `changeSeq` — one monotonic space, not a
second sequence, via the `bump_membership_seq()` trigger added in migration
`0007`); entering scope always backfills as a full upsert regardless of the
underlying record's own change history; exiting scope emits an
`outScopeSeq`-stamped row the client applies as a local purge — mechanically
identical to a tombstone on the client, but the server retains the data (a
subscription change, not a deletion).

**Evidence shipped (Task 22):**
- `lib/sync/scope-membership.ts` — `enterScope`, `exitScope`, `pullScopedDelta`,
  tested against the local-Postgres harness (`lib/test-support/db.ts`), not
  Testcontainers, per the plan's "Test Database Harness" section.
- `lib/sync/scope-membership.test.ts` proves, against the synthetic `'note'`
  entity type: (a) a newly-entered entity appears as a full upsert in the very
  next pull; (b) exiting scope emits the entityId in `exitedIds` and does *not*
  re-send it as an upsert; (c) a second entity entering scope doesn't re-emit
  an already-exited entity as an upsert (it correctly still reports as exited).
- `lib/offline/sync-client.ts` `pullDelta` extended to apply `exitedIds` as
  `db.customers.bulkDelete(exitedIds)` — the client-purge half of the round
  trip Task 16 deferred. `lib/offline/sync-client.test.ts` proves a
  locally-cached record disappears from Dexie when the server reports it left
  scope, and that an unrelated cached record is untouched.
- `scripts/migrations/0007_scope_membership.sql` is self-idempotent (`CREATE
  TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`
  + `CREATE TRIGGER`) and re-executes cleanly a second time
  (`__tests__/db/migrate.test.ts`, mirroring the Task 11 convention for
  0002-0006) — including an explicit assertion that only one
  `%change_seq%`-named sequence (`domain_change_seq`) exists after the
  re-run, so a regression that accidentally introduced a second sequence
  would fail this test.

## Consequences
- Phase 1's orders/worksheets/bookings scoping reuses `scope_membership`
  unchanged — just call `enterScope`/`exitScope` with real entity types
  (`'serviceOrder'`, `'worksheet'`, `'booking'`) at the assignment/reassignment
  mutation sites, per `03-architecture.md`.
- The reference-closure scoping (customers/sites/service-items an in-scope
  order points at) and the nightly horizon-advance job are Phase 1 work built
  on top of this table — not built here, since nothing yet references them.
- "Proven on-device" (the literal roadmap phrase) still needs a real Phase 1
  entity and a real paired device (Task 15) exercising the full loop end to
  end — this ADR proves the server-side mechanism and one client purge path,
  not the full field scenario. Revisit this ADR's "Accepted" status if Phase
  1's real-entity validation surfaces a mismatch (e.g. the reference-closure
  join needs a different membershipSeq shape than the flat table used here).
