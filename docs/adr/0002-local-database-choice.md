# ADR 0002: Local on-device database — Dexie over RxDB

## Status
Proposed — pending product-owner sign-off (Non-Code Prerequisite 6).

## Context
`03-architecture.md` ("Client: PWA first, wrappers optional") names Dexie and
RxDB as the two IndexedDB-wrapper candidates for offline data, left
undecided at spec time. herbe.service needs: bulk upsert of delta-synced
records (customers today; items, orders, worksheets, checklists from Phase 1
per the scoped-replication design), and an outbox of pending local
mutations replayed on reconnect. Multi-tab consistency is *not* a
requirement — `05-users-auth.md` describes a single device-bound session per
paired technician phone (PIN/biometric-gated local unlock, device registry,
remote wipe), not multiple simultaneous tabs/windows in the field.

RxDB's headline differentiators over Dexie are a built-in replication
protocol and multi-tab reactive queries (RxJS-based). Neither maps to a
requirement here: replication is custom-built per `03-architecture.md`'s
"Offline sync design" (per-user scoped delta pull + append-only outbox, not
a generic client-server replication protocol), and the PWA is
single-tab-per-technician by design.

## Decision
**Dexie.** Absent a concrete need for RxDB's replication engine or
multi-tab reactivity, Dexie's simpler API and smaller bundle win — bundle
size matters directly for the PWA's cold-start budget on a mid-range Android
phone in the field. Task 16 built `lib/offline/db.ts` (`OfflineDb`, a thin
Dexie subclass with a single `customers` table keyed on `id`) on this basis
already; this ADR records the decision the code already reflects and backs
it with a bulk-upsert spike.

**Spike evidence** (`lib/offline/db.spike.test.ts`, run via
`pnpm vitest run lib/offline/db.spike.test.ts` against `fake-indexeddb`):
bulk-upserting 1000 customer records via `db.customers.bulkPut()` completed
in **~24 ms** (24.0–24.5 ms across three runs), well inside the 2000 ms
CI-safe ceiling and negligible against any realistic offline-pull budget.
Bulk-upsert throughput is not a limiting factor for either library at this
scale — the decision rests on scope-fit (replication/multi-tab, above), not
on a performance gap Dexie would lose.

## Device-at-rest security scope (bundled per `03-architecture.md`'s framing)
Baseline, already decided and non-negotiable regardless of DB choice
(`03-architecture.md` "Device data at rest — honest scope"): a PWA cannot
hold a key the device itself can't reach, so IndexedDB has no app-level
at-rest encryption story beyond the platform's own disk encryption. The
scope is:
- **Platform disk encryption** (iOS/Android device-level, outside the app's
  control).
- **Offline PIN/biometric app-lock** (`05-users-auth.md`): WebAuthn platform
  authenticator or local PIN, rate-limited with wipe-on-N-failures per
  tenant policy.
- **Data minimization**: briefcase horizon (N days, tenant setting) limits
  what's replicated to the device at all; access instructions replicate
  only to the assigned technician.
- **Remote wipe on next contact**: device registry supports remote
  sign-out (`session_version` bump) and local data purge, both Phase 1.

**App-layer crypto is explicitly optional**, not required for Phase 0/1: a
local key wrapped by the PIN would harden the store further, but adds
complexity with no requirement driving it today. Revisit only if a tenant's
compliance posture demands OS-keystore-backed encryption at rest — that
requirement pushes that tenant to the native-wrapper path (`03-architecture.md`
"Known PWA gaps → native wrapper") instead of trying to bolt keystore access
onto a PWA.

## Consequences
- No RxDB dependency; Dexie's `bulkPut`/`Table` API is what Task 16 shipped
  and what all future offline-store work (items, orders, worksheets,
  checklists) builds on.
- If a future requirement introduces a genuine need for multi-tab
  reactivity or a generic replication protocol, this ADR is the one to
  revisit — don't silently introduce RxDB alongside Dexie.
- Device-at-rest posture is fixed at "platform encryption + app-lock +
  minimization + remote wipe" for Phase 0/1; app-layer crypto stays a
  backlog item, not a requirement, until a tenant's compliance needs force
  the native-wrapper path.
