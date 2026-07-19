# herbe.service Phase 1 — WS2 core: roles, session revocation, device registry, ERP identity link

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** close the two headline gaps doc24 flags for WS2 ("no roles/licensing") for the roles half, plus the ERP identity link WS4 needs on the M0→M1 critical path — without building the WebAuthn/TOTP/eID/Entra-ID/seat-licensing surface, which is out of scope for this slice (see "Deferred" below).

**Architecture:** five pure/thin additions on top of the Phase-0 auth baseline (magic link + PIN-paired devices, already built): a static role→capability lookup table; a real `session_version` check replacing the Phase-0 placeholder; two small self/admin routes for device revocation and "sign out everywhere"; a `identity_links` table + a match-by-email function that calls the *already-generic* adapter (`pullFullList('UserVc')` needs zero adapter changes); a daily cron that re-runs the match for unlinked users.

**Tech Stack:** Next.js 16 route handlers, Auth.js v5 (Credentials/magic-link, JWT strategy), Drizzle ORM / Postgres, Vitest, the existing `packages/fake-erp` Hono server.

Branch: `feature/service-phase1-ws2-roles-identity` (cut from `origin/preview` @ 69c006f, doc 25).
Worktree: `/Users/elviskvalbergs/AI/herbe-service/.claude/worktrees/service-phase1-ws2-roles-identity`.

## Global Constraints

- `pnpm exec tsc --noEmit` clean after every task.
- `pnpm exec vitest run` all green after every task.
- `pnpm exec vitest run --coverage` exit 0. Overall gate is 80% lines/branches/functions/statements (`vitest.config.ts`); `lib/erp/**`/`lib/sync/**`/`packages/erp-core/**` are gated at 90% but nothing in this slice adds files under those paths except the fake-erp fixture (not coverage-tracked) and the live-contract test (excluded from coverage). Never lower a threshold.
- Migrations: `scripts/migrations/NNNN_*.sql`, next free number, idempotent (`IF NOT EXISTS`), filename-sorted, no `_journal.json` in this repo.
- ERP-touching code (Task 4/5): extend `tests/live/erp-contract.test.ts`, run `pnpm test:live` before the slice is done. Assert counts/shapes only, never row values, never credentials.
- No comments explaining *what* the code does — only non-obvious *why* (this repo's existing style, verified by reading a dozen files above).
- Every user-facing role list in code must be the literal 5 values from `docs/05-users-auth.md` §Roles: `technician`, `team_lead`, `dispatcher`, `back_office`, `admin`. Do not invent a 6th.

---

## Context (verified by reading the actual code, not just the docs)

- **`docs/05-users-auth.md`** is the binding spec for this slice. **`docs/24-phase1-status-and-parallel-handoff.md`** §1 lists WS2 as "Not started (next-auth session exists from Phase 0; no roles/licensing)"; §4 confirms WS2 is unclaimed and independent of WS3/WS12.
- **Phase 0 already built**, verified by reading the files directly (do not redo any of this):
  - `users` table (`tenant_id`, `email`, `role text default 'technician'`, `created_at`) — `drizzle/schema.ts`.
  - Magic-link login: `lib/auth/magic-link-provider.ts` (`issueMagicLinkToken`/`authorizeMagicLink`, atomic single-use consume), wired as a Credentials provider in `lib/auth/config.ts`.
  - PIN-paired device login: `lib/auth/device-enrollment.ts` + `app/api/auth/device/{enroll,unlock}/route.ts`. `paired_devices` already has `revoked_at`, `failed_attempts`, `locked_until` (time-boxed lockout, already enforced in `unlock/route.ts`). **`revokedAt` is already checked on unlock** — Task 3 below only needs to add a way to *set* it.
  - `lib/auth/config.ts`'s `jwtCallback` has a **literal placeholder**: `token.sessionVersion = 1` at every sign-in, "Not enforced against anything yet" per its own comment. `session.user` currently exposes only `{id, tenantId}` — no `role`, no `sessionVersion`.
  - `lib/seed/personas.ts` **already defines the exact 5-role union** (`'technician' | 'team_lead' | 'dispatcher' | 'back_office' | 'admin'`) and 7 named personas (5 roles + 2 negative-access fixtures) — reuse this, don't redefine it.
  - `app/api/sync/customers/route.ts` is the existing pattern for a session-gated route + its test (`vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))`, `authMock.mockResolvedValue({ user: {...}, expires: ... })`) — Task 3's routes and tests follow this exactly.
- **No real role-gated routes exist yet.** The only two admin routes (`/api/admin/ext-tokens`, `/api/admin/run-migrations`) are static-ops-secret-gated (`ADMIN_MIGRATIONS_SECRET`), not session/role-based — they are bootstrap tooling, not user-facing, and are deliberately out of scope for role gating. The dispatch board / worksheet-approval / admin-surface routes that will actually consume the capability model belong to WS8/WS9/WS10/WS12/WS14, not built yet. **Decision (FINAL): Task 1 ships the capability model as a tested, standalone library plus `session.user.role` plumbing — it does not invent enforcement on routes that don't exist.** The "access-rights matrix as a generated test" that doc21 §WS2 TDD-focus asks for is written as a persona × capability table (using the real `PERSONAS` roles), not persona × HTTP-route, because there is no second thing to cross yet.
- **`adapter.pullFullList(register)` / `pullChanges(register, cursor)` are already fully generic** (`lib/erp/standard-books/adapter.ts`) — they take any register string and extract `body.data.<register>`. No REF_FIELD entry or adapter change is needed for `UserVc`; that map is only consulted by `listLiveRefs`, which this slice does not use. **This removes an entire task** originally assumed necessary ("add UserVc register support") — confirmed by reading `adapter.ts` directly, not assumed from the portal's heavier register-module convention.
- `docs/17-erp-register-reference.md` §`UserVc`: identity field is `Code` (`M4Code 10`), email fields are `emailAddr`/`LoginEmailAddr`, has `UUID`/`ServerSequence` (delta-capable base register, same tier as `CUVc`). Verified live 2026-07-06: `UserVc.Code` matches `WSVc.EMCode` exactly for both real technicians on the demo tenant.
- `packages/fake-erp/src/handlers/register.ts`: registers are wired via a `FIXTURES: Record<string, [...]>` map plus a `NO_UPDATES_AFTER` set for no-delta registers. Adding `UserVc` means adding a fixture file + one map entry — `UserVc` is **not** added to `NO_UPDATES_AFTER` (it's delta-capable).
- `isBooksTrue`/`parseBooksDate`/`booksNumeric` are **deliberately re-declared locally in each ingest file**, not shared from a common module (verified: `service-items.ts`, `service-orders.ts`, `worksheets.ts` each have their own copy). Follow this convention — declare a local `isBooksTrue` in the new identity-link file rather than extracting a shared util.
- `tests/live/erp-contract.test.ts` is the existing gated live suite (`describe.skipIf(!process.env.RUN_LIVE_ERP_TESTS)`, loads `.env.vars`, builds one adapter/company in `beforeAll`). Task 5 adds to this file rather than creating a second one, matching its existing "runs last, self-contained" pattern.

## Deferred (explicitly out of scope for this slice — record in doc24 §4 when done)

- WebAuthn platform-authenticator biometric unlock.
- TOTP + password + Baltic eID (Smart-ID/Dokobit/eParaksts) + Microsoft Entra ID OIDC login providers (doc05 marks these "optional per tenant"; no tenant-config mechanism exists yet to make them optional, which is itself a prerequisite these providers would need).
- Seat/license enforcement (blocked-beyond-count + admin usage view) — no billing/seat-count concept exists anywhere in the codebase yet; inventing one now would be speculative.
- Wiring `hasCapability` into any real HTTP route — none exist yet that need it; WS8 (worksheet approval), WS9 (F11 profile/device-list UI), WS10 (dispatch board), WS14 (admin surfaces) each wire it in when their routes/pages land.
- Tenant-configurable capability overrides ("whether team leads approve worksheets", "SSO only" policy) — doc05 flags these as tunable edges on top of the default matrix; the default matrix is this slice's job, tunability is not.

---

## Task 1 — Role/capability model + `session.user.role`

**Files:**
- Create: `lib/auth/roles.ts`
- Create: `lib/auth/roles.test.ts`
- Modify: `lib/seed/personas.ts` (import `Role` instead of redeclaring the union)
- Modify: `lib/auth/config.ts` (session/jwt callbacks carry `role`)
- Modify: `lib/auth/config.test.ts`
- Modify: `lib/auth/magic-link-provider.ts` (`authorizeMagicLink` returns `role`)
- Modify: `lib/auth/magic-link-provider.test.ts`

**`lib/auth/roles.ts`** — the full file:

```typescript
export type Role = 'technician' | 'team_lead' | 'dispatcher' | 'back_office' | 'admin'

export type Capability =
  | 'worksheet:execute_own'
  | 'service_item:create_in_field'
  | 'van_stock:view_own'
  | 'history:view'
  | 'team:view_bookings'
  | 'team:reassign_bookings'
  | 'crew:edit_composition'
  | 'team:review_time_entries'
  | 'order:view_all'
  | 'worksheet:approve'
  | 'worksheet:reject'
  | 'dispatch:manage'
  | 'tree:bulk_edit'
  | 'checklist:manage_templates'
  | 'document:override_generation'
  | 'sync:view_health'
  | 'pricing:view_margins'
  | 'customer:edit'
  | 'item:edit'
  | 'report:view'
  | 'document:manage_delivery'
  | 'tenant:manage_settings'
  | 'users:manage'
  | 'device:manage_enrollment'
  | 'erp_connection:manage'
  | 'document_template:manage'
  | 'structure_template:manage'
  | 'api_token:manage'

// Transcribed from docs/05-users-auth.md §Roles — one row per role's bullet
// list. team_lead's "optionally (tenant flag) approve the team's worksheets"
// is a tunable edge on top of this default matrix, not part of it (no
// tenant-config mechanism exists yet to carry that override).
export const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  technician: ['worksheet:execute_own', 'service_item:create_in_field', 'van_stock:view_own', 'history:view'],
  team_lead: [
    'worksheet:execute_own',
    'service_item:create_in_field',
    'van_stock:view_own',
    'history:view',
    'team:view_bookings',
    'team:reassign_bookings',
    'crew:edit_composition',
    'team:review_time_entries',
  ],
  dispatcher: [
    'order:view_all',
    'worksheet:approve',
    'worksheet:reject',
    'dispatch:manage',
    'tree:bulk_edit',
    'checklist:manage_templates',
    'document:override_generation',
    'sync:view_health',
    'pricing:view_margins',
  ],
  back_office: ['customer:edit', 'item:edit', 'report:view', 'document:manage_delivery'],
  admin: [
    'tenant:manage_settings',
    'users:manage',
    'device:manage_enrollment',
    'erp_connection:manage',
    'document_template:manage',
    'structure_template:manage',
    'api_token:manage',
  ],
}

export function hasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}
```

- [ ] **Step 1: Write `lib/auth/roles.test.ts` first**

```typescript
import { describe, expect, it } from 'vitest'
import { hasCapability, ROLE_CAPABILITIES, type Capability, type Role } from './roles'

describe('hasCapability', () => {
  const cases: Array<[Role, Capability, boolean]> = [
    ['technician', 'worksheet:execute_own', true],
    ['technician', 'worksheet:approve', false],
    ['technician', 'users:manage', false],
    ['team_lead', 'crew:edit_composition', true],
    ['team_lead', 'worksheet:approve', false],
    ['team_lead', 'worksheet:execute_own', true],
    ['dispatcher', 'worksheet:approve', true],
    ['dispatcher', 'pricing:view_margins', true],
    ['dispatcher', 'tenant:manage_settings', false],
    ['back_office', 'customer:edit', true],
    ['back_office', 'worksheet:approve', false],
    ['admin', 'tenant:manage_settings', true],
    ['admin', 'users:manage', true],
    ['admin', 'worksheet:approve', false],
  ]

  it.each(cases)('role=%s capability=%s -> %s', (role, capability, expected) => {
    expect(hasCapability(role, capability)).toBe(expected)
  })

  it('every role has at least one capability', () => {
    for (const role of Object.keys(ROLE_CAPABILITIES) as Role[]) {
      expect(ROLE_CAPABILITIES[role].length).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run it, confirm it fails** (`roles.ts` doesn't exist yet) — `pnpm exec vitest run lib/auth/roles.test.ts`, expect "Cannot find module './roles'".
- [ ] **Step 3: Create `lib/auth/roles.ts`** with the full content above.
- [ ] **Step 4: Run `pnpm exec vitest run lib/auth/roles.test.ts`** — expect all cases pass.

- [ ] **Step 5: Update `lib/seed/personas.ts`** — replace the inline union with the shared type:

```typescript
// lib/seed/personas.ts
import type { Role } from '@/lib/auth/roles'

export interface Persona {
  id: string
  email: string
  role: Role
}
// ... rest of file (PERSONAS object) unchanged
```

- [ ] **Step 6: Run `pnpm exec vitest run`** — confirm nothing else broke (personas is imported by `app/api/test/login/route.ts` and possibly its tests; a type-only change should be silent).

- [ ] **Step 7: Plumb `role` through the session.** Modify `lib/auth/config.ts`:
  - In the `declare module 'next-auth'` block, add `role?: string` to `interface User` and `role: string` to `Session['user']`.
  - In `jwtCallback`, inside the `if (trigger === 'signIn' && user?.id)` block, add `token.role = user.role` (after the existing `token.tenantId = user.tenantId` line). Update the `user` param type in the function signature to include `role?: string`.
  - In `sessionCallback`, add: `if (typeof token.role === 'string') { session.user.role = token.role }`.
  - In the `Credentials({ id: 'magic_link', ... })` provider's `authorize`, change the return to `{ id: user.id, email: user.email, tenantId: user.tenantId, role: user.role }`.

- [ ] **Step 8: Modify `lib/auth/magic-link-provider.ts`** — `authorizeMagicLink`'s return type becomes `{ id: string; email: string; tenantId: string; role: string } | null`, and the final `return` becomes `return { id: user.id, email: user.email, tenantId: user.tenantId, role: user.role }` (the row already carries `role` from its `default('technician')` column — no schema change needed here).

- [ ] **Step 9: Update `lib/auth/config.test.ts` and `lib/auth/magic-link-provider.test.ts`** to assert the new `role` field flows through `jwtCallback`/`sessionCallback`/`authorizeMagicLink` (mirror however those files currently assert `tenantId`, one line each for `role`).

- [ ] **Step 10: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 11: Commit**

```bash
git add lib/auth/roles.ts lib/auth/roles.test.ts lib/seed/personas.ts lib/auth/config.ts lib/auth/config.test.ts lib/auth/magic-link-provider.ts lib/auth/magic-link-provider.test.ts
git commit -m "feat(auth): role/capability model + session.user.role"
```

---

## Task 2 — `session_version` enforcement (replaces the Phase-0 placeholder)

**Files:**
- Create: `scripts/migrations/0017_users_session_version.sql`
- Create: `lib/auth/session-guard.ts`
- Create: `lib/auth/session-guard.test.ts`
- Modify: `lib/auth/config.ts`, `lib/auth/config.test.ts`
- Modify: `lib/auth/magic-link-provider.ts`, `lib/auth/magic-link-provider.test.ts`

**Design decision (FINAL):** keep `jwtCallback`/`sessionCallback` pure (matching the existing `authTime` pattern: stamped once at sign-in, copied forward unchanged) — do not add a DB call inside them. The actual per-request revocation check against the *current* stored value lives in one new function, `getVerifiedSession`, that routes call instead of `auth()` directly when they need revocation-aware auth. This mirrors how the codebase already keeps `lib/auth/config.ts` callbacks side-effect-free and puts DB-dependent logic in a separate module.

**`scripts/migrations/0017_users_session_version.sql`:**

```sql
-- scripts/migrations/0017_users_session_version.sql
--
-- WS2 (docs/05-users-auth.md "Sessions & devices"): the Phase 0 jwt callback
-- (lib/auth/config.ts) already stamps a hardcoded token.sessionVersion = 1 on
-- every sign-in but never checks it against anything ("Placeholder for Phase
-- 1" comment) — role changes/offboarding can't force-invalidate a live
-- session. This column is the real counter: lib/auth/session-guard.ts
-- bumpSessionVersion increments it, and getVerifiedSession rejects any token
-- whose stamped version no longer matches.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" integer NOT NULL DEFAULT 1;
```

**`lib/auth/session-guard.ts`** — the full file:

```typescript
import { eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from '@/drizzle/schema'
import { auth } from '@/lib/auth'
import type { Session } from 'next-auth'

type Db = PostgresJsDatabase<typeof schema>

export async function bumpSessionVersion(db: Db, userId: string): Promise<void> {
  await db
    .update(schema.users)
    .set({ sessionVersion: sql`${schema.users.sessionVersion} + 1` })
    .where(eq(schema.users.id, userId))
}

// Routes that must honor revocation (role change, device wipe, offboarding)
// call this instead of `auth()` directly. jwtCallback/sessionCallback stay
// pure and forward the sign-in-time sessionVersion unchanged (same pattern
// as authTime) — this is the one place that compares it against the
// current DB value.
export async function getVerifiedSession(db: Db): Promise<Session | null> {
  const session = await auth()
  const sessionVersion = (session?.user as { sessionVersion?: number } | undefined)?.sessionVersion
  if (!session?.user?.id || typeof sessionVersion !== 'number') return null

  const [row] = await db.select({ sessionVersion: schema.users.sessionVersion }).from(schema.users).where(eq(schema.users.id, session.user.id))
  if (!row || row.sessionVersion !== sessionVersion) return null

  return session
}
```

- [ ] **Step 1: Write `lib/auth/session-guard.test.ts` first** (DB-backed, mirrors `lib/erp/connection.test.ts`'s `createTestDatabase()` style):

```typescript
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'

const authMock = vi.fn()
vi.mock('@/lib/auth', () => ({ auth: () => authMock() }))

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

async function makeUser() {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `sg-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, email: 'a@b.test' }).returning()
  return user
}

describe('getVerifiedSession', () => {
  beforeEach(() => authMock.mockReset())

  it('returns the session when sessionVersion matches the stored value', async () => {
    const { getVerifiedSession } = await import('./session-guard')
    const user = await makeUser()
    authMock.mockResolvedValue({ user: { id: user.id, sessionVersion: 1 }, expires: '2099-01-01T00:00:00.000Z' })

    const session = await getVerifiedSession(db)
    expect(session?.user.id).toBe(user.id)
  })

  it('returns null when the token sessionVersion is stale', async () => {
    const { getVerifiedSession, bumpSessionVersion } = await import('./session-guard')
    const user = await makeUser()
    authMock.mockResolvedValue({ user: { id: user.id, sessionVersion: 1 }, expires: '2099-01-01T00:00:00.000Z' })
    await bumpSessionVersion(db, user.id)

    expect(await getVerifiedSession(db)).toBeNull()
  })

  it('returns null when there is no session', async () => {
    const { getVerifiedSession } = await import('./session-guard')
    authMock.mockResolvedValue(null)
    expect(await getVerifiedSession(db)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm exec vitest run lib/auth/session-guard.test.ts` (module doesn't exist / migration not applied).
- [ ] **Step 3: Add the migration**, add `sessionVersion: integer('session_version').notNull().default(1)` to the `users` table definition in `drizzle/schema.ts` (column, not a new table — placed alongside `role`).
- [ ] **Step 4: Create `lib/auth/session-guard.ts`** with the content above.
- [ ] **Step 5: Wire `sessionVersion` into the real sign-in path** — modify `lib/auth/magic-link-provider.ts`: `authorizeMagicLink`'s return type gains `sessionVersion: number`, return becomes `{ ..., sessionVersion: user.sessionVersion }`. Modify `lib/auth/config.ts`: the `declare module` block's `Session['user']` gains `sessionVersion: number`; `jwtCallback`'s `user` param type gains `sessionVersion?: number`; inside the `signIn` branch add `token.sessionVersion = user.sessionVersion ?? 1` **replacing** the old hardcoded `token.sessionVersion = 1`; `sessionCallback` adds `if (typeof token.sessionVersion === 'number') { session.user.sessionVersion = token.sessionVersion }`. Update the Credentials provider's `authorize` return to include `sessionVersion: user.sessionVersion`.
- [ ] **Step 6: Run `pnpm exec vitest run lib/auth/session-guard.test.ts`** — expect all three tests pass.
- [ ] **Step 7: Update `lib/auth/config.test.ts` and `lib/auth/magic-link-provider.test.ts`** for the `sessionVersion` field the same way Task 1 did for `role`.
- [ ] **Step 8: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 9: Commit**

```bash
git add scripts/migrations/0017_users_session_version.sql drizzle/schema.ts lib/auth/session-guard.ts lib/auth/session-guard.test.ts lib/auth/config.ts lib/auth/config.test.ts lib/auth/magic-link-provider.ts lib/auth/magic-link-provider.test.ts
git commit -m "feat(auth): enforce session_version revocation (replaces Phase-0 placeholder)"
```

---

## Task 3 — Device registry: list, revoke, sign-out-everywhere

**Files:**
- Create: `app/api/auth/devices/route.ts` + `route.test.ts`
- Create: `app/api/auth/devices/[id]/revoke/route.ts` + `route.test.ts`
- Create: `app/api/auth/users/[id]/sign-out-everywhere/route.ts` + `route.test.ts`

**Interfaces consumed:** `getVerifiedSession(db)` (Task 2), `hasCapability(role, capability)` (Task 1), `bumpSessionVersion(db, userId)` (Task 2). `schema.pairedDevices` (existing: `id`, `tenantId`, `userId`, `deviceLabel`, `pinHash`, `failedAttempts`, `lockedUntil`, `createdAt`, `lastUnlockAt`, `revokedAt`).

**`GET /api/auth/devices`** — list the caller's own paired devices (self-service; no admin-list-others in this slice — no admin UI consumes it yet, see Deferred):

```typescript
// app/api/auth/devices/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'

export async function GET() {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const devices = await db
    .select({
      id: schema.pairedDevices.id,
      deviceLabel: schema.pairedDevices.deviceLabel,
      createdAt: schema.pairedDevices.createdAt,
      lastUnlockAt: schema.pairedDevices.lastUnlockAt,
      revokedAt: schema.pairedDevices.revokedAt,
      lockedUntil: schema.pairedDevices.lockedUntil,
    })
    .from(schema.pairedDevices)
    .where(eq(schema.pairedDevices.userId, session.user.id))

  return Response.json({ devices })
}
```

**`POST /api/auth/devices/[id]/revoke`** — self can revoke own device; a `users:manage` capability holder (admin) can revoke any device in their own tenant:

```typescript
// app/api/auth/devices/[id]/revoke/route.ts
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  const [device] = await db.select().from(schema.pairedDevices).where(eq(schema.pairedDevices.id, id))
  if (!device) {
    return new Response('Not found', { status: 404 })
  }

  const isSelf = device.userId === session.user.id
  const isAdmin = hasCapability(session.user.role as Role, 'users:manage') && device.tenantId === session.user.tenantId
  if (!isSelf && !isAdmin) {
    return new Response('Forbidden', { status: 403 })
  }

  await db
    .update(schema.pairedDevices)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.pairedDevices.id, id)))

  return Response.json({ status: 'ok' })
}
```

**`POST /api/auth/users/[id]/sign-out-everywhere`** — self, or a `users:manage` capability holder targeting a user in the same tenant; bumps `session_version`, invalidating every live session for that user (offboarding / role change / lost-phone-with-no-specific-device-id case):

```typescript
// app/api/auth/users/[id]/sign-out-everywhere/route.ts
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { getVerifiedSession, bumpSessionVersion } from '@/lib/auth/session-guard'
import { hasCapability, type Role } from '@/lib/auth/roles'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getVerifiedSession(db)
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { id } = await params
  const isSelf = id === session.user.id
  if (!isSelf) {
    if (!hasCapability(session.user.role as Role, 'users:manage')) {
      return new Response('Forbidden', { status: 403 })
    }
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, id))
    if (!target || target.tenantId !== session.user.tenantId) {
      return new Response('Not found', { status: 404 })
    }
  }

  await bumpSessionVersion(db, id)
  return Response.json({ status: 'ok' })
}
```

- [ ] **Step 1: Write the three `route.test.ts` files first**, mirroring `app/api/sync/customers/route.test.ts`'s exact harness (`vi.mock('@/lib/auth', ...)`, `createTestDatabase`, `runMigrations`). Cover per route:
  - `devices/route.test.ts`: 401 with no session; returns only the caller's own devices (seed two users, two devices each, assert isolation).
  - `devices/[id]/revoke/route.test.ts`: 401 with no session; self can revoke own device (`revokedAt` set); a `technician` cannot revoke another user's device (403); an `admin` in the *same* tenant can revoke another user's device; an `admin` in a *different* tenant gets 403; unknown id -> 404.
  - `users/[id]/sign-out-everywhere/route.test.ts`: 401 with no session; self can bump own version; `technician` cannot bump another user's version (403); `admin` same-tenant can; `admin` cross-tenant gets 404; verify `bumpSessionVersion` actually incremented (`select` the row after).
- [ ] **Step 2: Run all three, confirm they fail** (routes don't exist).
- [ ] **Step 3: Create the three route files** with the content above.
- [ ] **Step 4: Run `pnpm exec vitest run app/api/auth`** — all green.
- [ ] **Step 5: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 6: Commit**

```bash
git add app/api/auth/devices app/api/auth/users
git commit -m "feat(auth): device revoke + sign-out-everywhere routes"
```

---

## Task 4 — `identity_links` table + match-by-email

**Files:**
- Create: `scripts/migrations/0018_identity_links.sql`
- Modify: `drizzle/schema.ts` (add `identityLinks` table, after the existing `users` table block)
- Create: `lib/auth/identity-link.ts`
- Create: `lib/auth/identity-link.test.ts`
- Create: `packages/fake-erp/src/fixtures/uservc.json`
- Modify: `packages/fake-erp/src/handlers/register.ts` (register the new fixture)

**`scripts/migrations/0018_identity_links.sql`:**

```sql
-- scripts/migrations/0018_identity_links.sql
--
-- WS2 (docs/05-users-auth.md "Model"): the app-side IdentityLink[] table —
-- links a `users` row to an external identity. Only provider 'erp' is
-- populated this slice (UserVc.Code, matched by email via
-- lib/auth/identity-link.ts matchUsersByEmail); entra-id/eid providers are
-- Phase 2+ and reuse this same shape without a further migration.
--
-- The unique index includes the nullable erp_company_id: Postgres treats
-- each NULL as distinct, so it only truly de-duplicates provider='erp' rows
-- (which always set erp_company_id) — acceptable since no other provider is
-- populated yet.
CREATE TABLE IF NOT EXISTS "identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "provider" text NOT NULL,
  "erp_company_id" uuid REFERENCES "erp_companies"("id"),
  "external_id" text NOT NULL,
  "linked_at" timestamptz NOT NULL DEFAULT now(),
  "linked_by" text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_user_provider_company_uniq" ON "identity_links" ("user_id", "provider", "erp_company_id");
CREATE INDEX IF NOT EXISTS "identity_links_erp_lookup_idx" ON "identity_links" ("erp_company_id", "external_id");
```

**`drizzle/schema.ts` addition** (place directly after the `users` table block; `tenants`/`erpCompanies`/`users` are all already declared above that point):

```typescript
export const identityLinks = pgTable(
  'identity_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    provider: text('provider').notNull(), // 'erp' | future: 'entra-id' | 'eid'
    erpCompanyId: uuid('erp_company_id').references(() => erpCompanies.id),
    externalId: text('external_id').notNull(), // UserVc.Code for provider = 'erp'
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    linkedBy: text('linked_by').notNull(), // 'auto-match:email' | admin user id
  },
  (t) => [
    unique().on(t.userId, t.provider, t.erpCompanyId),
    index('identity_links_erp_lookup_idx').on(t.erpCompanyId, t.externalId),
  ],
)
export type IdentityLinkRow = InferSelectModel<typeof identityLinks>
```

**`packages/fake-erp/src/fixtures/uservc.json`** (anonymized, mirrors `cuvc.json`'s shape; two technicians whose `Code` matches the kind of value `WSVc.EMCode` would carry, one closed/terminated account to exercise the skip path):

```json
[
  { "Code": "EMP001", "Name": "Test Tech One", "emailAddr": "tech.one@example.test", "LoginEmailAddr": "", "Closed": 0, "TerminatedFlag": 0, "UUID": "b1c2d3e4-0001", "ServerSequence": 2001 },
  { "Code": "EMP002", "Name": "Test Tech Two", "emailAddr": "", "LoginEmailAddr": "tech.two@example.test", "Closed": 0, "TerminatedFlag": 0, "UUID": "b1c2d3e4-0002", "ServerSequence": 2002 },
  { "Code": "EMP003", "Name": "Former Tech", "emailAddr": "former@example.test", "LoginEmailAddr": "", "Closed": 1, "TerminatedFlag": 1, "UUID": "b1c2d3e4-0003", "ServerSequence": 2003 }
]
```

**`packages/fake-erp/src/handlers/register.ts` modification** — add the import and one `FIXTURES` entry (do **not** add `UserVc` to `NO_UPDATES_AFTER` — it's delta-capable):

```typescript
import uservcFixture from '../fixtures/uservc.json' with { type: 'json' }
// ...
const FIXTURES: Record<string, Array<{ ServerSequence: number }>> = {
  CUVc: cuvcFixture,
  DelAddrVc: deladdrvcFixture,
  SVOSerVc: svoservcFixture,
  SVOVc: svovcFixture,
  WSVc: wsvcFixture,
  UserVc: uservcFixture,
}
```

**`lib/auth/identity-link.ts`** — the full file:

```typescript
import { and, eq, inArray } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { ErpAdapter } from '@herbe/erp-core'
import * as schema from '@/drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

function isBooksTrue(value: unknown): boolean {
  return value === 1 || value === '1' || value === true
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed ? trimmed : null
}

export interface MatchSummary {
  linked: number
  alreadyLinked: number
  noMatch: number
}

// Matches unlinked users (by tenant) against the ERP's UserVc register by
// email, and inserts an identity_links row (provider 'erp') for each match.
// Never logs email/PII — only the returned counts are meant to be logged by
// callers (docs/24 §3 "log counts only, never row values").
export async function matchUsersByEmail(
  db: Db,
  opts: { tenantId: string; erpCompanyId: string; adapter: ErpAdapter },
): Promise<MatchSummary> {
  const rows = await opts.adapter.pullFullList('UserVc')

  const emailToCode = new Map<string, string>()
  for (const row of rows) {
    if (isBooksTrue((row as Record<string, unknown>).Closed)) continue
    if (isBooksTrue((row as Record<string, unknown>).TerminatedFlag)) continue
    const code = (row as Record<string, unknown>).Code
    if (typeof code !== 'string' || !code) continue
    const email =
      normalizeEmail((row as Record<string, unknown>).LoginEmailAddr) ??
      normalizeEmail((row as Record<string, unknown>).emailAddr)
    if (!email) continue
    emailToCode.set(email, code)
  }

  const existingLinks = await db
    .select({ userId: schema.identityLinks.userId, externalId: schema.identityLinks.externalId })
    .from(schema.identityLinks)
    .where(and(eq(schema.identityLinks.erpCompanyId, opts.erpCompanyId), eq(schema.identityLinks.provider, 'erp')))

  const alreadyLinkedUserIds = new Set(existingLinks.map((l) => l.userId))
  const usedCodes = new Set(existingLinks.map((l) => l.externalId))

  const tenantUsers = await db
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.tenantId, opts.tenantId))
  const unlinkedUsers = tenantUsers.filter((u) => !alreadyLinkedUserIds.has(u.id))

  let linked = 0
  let noMatch = 0
  for (const user of unlinkedUsers) {
    const email = normalizeEmail(user.email)
    const code = email ? emailToCode.get(email) : undefined
    if (!code || usedCodes.has(code)) {
      noMatch++
      continue
    }
    await db.insert(schema.identityLinks).values({
      tenantId: opts.tenantId,
      userId: user.id,
      provider: 'erp',
      erpCompanyId: opts.erpCompanyId,
      externalId: code,
      linkedBy: 'auto-match:email',
    })
    usedCodes.add(code)
    linked++
  }

  return { linked, alreadyLinked: alreadyLinkedUserIds.size, noMatch }
}
```

Note: `inArray` is imported but unused above if you don't end up needing it — drop the import if `tsc`/lint flags it unused; it's listed here only in case a reviewer suggests batching the existing-link lookup differently. Do not leave an unused import in the committed file.

- [ ] **Step 1: Write `lib/auth/identity-link.test.ts` first** (DB-backed, no adapter needed — pass a hand-rolled fake `ErpAdapter` object with just `pullFullList` implemented, matching `ErpAdapter`'s shape from `@herbe/erp-core`):

```typescript
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import { matchUsersByEmail } from './identity-link'
import type { ErpAdapter } from '@herbe/erp-core'

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

function fakeAdapter(rows: Record<string, unknown>[]): ErpAdapter {
  return {
    capabilities: () => ({
      supportsIncrementalSync: true,
      supportsDeletesFeed: false,
      supportsDocumentFetch: false,
      supportsInvoiceStatusReadback: false,
      supportsActivityMirror: false,
    }),
    pullFullList: async () => rows,
    pullChanges: async () => ({ upserts: [], deletedRefs: [], cursor: '0' }),
    listLiveRefs: async () => [],
    pushCreate: async () => ({ erpRef: '' }),
    probeIncrementalSupport: async () => false,
  }
}

async function makeTenantAndCompany() {
  const [tenant] = await db.insert(schema.tenants).values({ slug: `il-${Date.now()}-${Math.random()}`, name: 'x' }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: 'x', adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return { tenantId: tenant.id, erpCompanyId: company.id }
}

describe('matchUsersByEmail', () => {
  it('links a user whose email matches a UserVc row, case-insensitively', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    await db.insert(schema.users).values({ tenantId, email: 'Tech.One@Example.test' })
    const adapter = fakeAdapter([{ Code: 'EMP001', emailAddr: 'tech.one@example.test', Closed: 0, TerminatedFlag: 0 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })

    expect(result).toEqual({ linked: 1, alreadyLinked: 0, noMatch: 0 })
    const links = await db.select().from(schema.identityLinks).where(eq(schema.identityLinks.tenantId, tenantId))
    expect(links).toHaveLength(1)
    expect(links[0].externalId).toBe('EMP001')
    expect(links[0].provider).toBe('erp')
  })

  it('does not re-link an already-linked user and reports it separately', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    const [user] = await db.insert(schema.users).values({ tenantId, email: 'tech.two@example.test' }).returning()
    await db.insert(schema.identityLinks).values({ tenantId, userId: user.id, provider: 'erp', erpCompanyId, externalId: 'EMP002', linkedBy: 'auto-match:email' })
    const adapter = fakeAdapter([{ Code: 'EMP002', emailAddr: 'tech.two@example.test', Closed: 0, TerminatedFlag: 0 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })
    expect(result).toEqual({ linked: 0, alreadyLinked: 1, noMatch: 0 })
  })

  it('does not match a closed/terminated UserVc row', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    await db.insert(schema.users).values({ tenantId, email: 'former@example.test' })
    const adapter = fakeAdapter([{ Code: 'EMP003', emailAddr: 'former@example.test', Closed: 1, TerminatedFlag: 1 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })
    expect(result).toEqual({ linked: 0, alreadyLinked: 0, noMatch: 1 })
  })

  it('reports no-match for a user with no corresponding UserVc email', async () => {
    const { tenantId, erpCompanyId } = await makeTenantAndCompany()
    await db.insert(schema.users).values({ tenantId, email: 'nobody@example.test' })
    const adapter = fakeAdapter([{ Code: 'EMP001', emailAddr: 'tech.one@example.test', Closed: 0, TerminatedFlag: 0 }])

    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId, adapter })
    expect(result).toEqual({ linked: 0, alreadyLinked: 0, noMatch: 1 })
  })
})
```

(Add `import { eq } from 'drizzle-orm'` to the test file's imports.)

- [ ] **Step 2: Run it, confirm it fails** (`identity-link.ts` / `identityLinks` schema don't exist).
- [ ] **Step 3: Add the migration + schema block** (content above), run `pnpm exec drizzle-kit generate` is **not** needed here since the migration is hand-written to match the schema exactly (same convention as every prior migration in this repo — verify the SQL and the Drizzle table definition agree column-for-column).
- [ ] **Step 4: Create `lib/auth/identity-link.ts`** with the content above (drop the unused `inArray` import when you copy it in).
- [ ] **Step 5: Add the fake-ERP fixture + register it** (content above).
- [ ] **Step 6: Run `pnpm exec vitest run lib/auth/identity-link.test.ts`** — all four cases pass.
- [ ] **Step 7: Verify**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 8: Commit**

```bash
git add scripts/migrations/0018_identity_links.sql drizzle/schema.ts lib/auth/identity-link.ts lib/auth/identity-link.test.ts packages/fake-erp/src/fixtures/uservc.json packages/fake-erp/src/handlers/register.ts
git commit -m "feat(auth): identity_links table + match-by-email against UserVc"
```

---

## Task 5 — Periodic re-match cron + live ERP contract proof

**Files:**
- Create: `app/api/cron/identity-rematch/route.ts` + `route.test.ts`
- Modify: `vercel.json` (add the cron entry)
- Modify: `tests/live/erp-contract.test.ts` (add two `it` blocks; capture `tenantId` in the outer scope alongside the existing `companyId`)

**Interfaces consumed:** `matchUsersByEmail` (Task 4), `buildAdapterForConnection`, `acquireCronLock`/`releaseCronLock`, `bearerMatches` — all existing, same as `app/api/cron/sync-tick/route.ts`.

**`app/api/cron/identity-rematch/route.ts`** — mirrors `sync-tick/route.ts` exactly (own lock name, own summary shape):

```typescript
// app/api/cron/identity-rematch/route.ts
//
// Daily re-match: for every active erp_companies row, links any still-
// unlinked users by email against that connection's UserVc register
// (lib/auth/identity-link.ts). Mirrors app/api/cron/sync-tick/route.ts's
// per-company error isolation — one company's ERP being unreachable must
// not block the others.
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import * as schema from '@/drizzle/schema'
import { acquireCronLock, releaseCronLock } from '@/lib/cronLock'
import { bearerMatches } from '@/lib/api/cronAuth'
import { buildAdapterForConnection } from '@/lib/erp/connection'
import { matchUsersByEmail } from '@/lib/auth/identity-link'
import '@/lib/erp/standard-books/adapter'

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || !bearerMatches(request.headers.get('authorization'), secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  const gotLock = await acquireCronLock('identity-rematch', 55)
  if (!gotLock) {
    return Response.json({ status: 'skipped', reason: 'lock held' })
  }

  try {
    const companies = await db.select().from(schema.erpCompanies).where(eq(schema.erpCompanies.active, true))
    const results: Array<{ companyId: string; status: string; summary?: Awaited<ReturnType<typeof matchUsersByEmail>> }> = []

    for (const company of companies) {
      try {
        const adapter = await buildAdapterForConnection(db, company.id)
        const summary = await matchUsersByEmail(db, { tenantId: company.tenantId, erpCompanyId: company.id, adapter })
        results.push({ companyId: company.id, status: 'ok', summary })
      } catch (err) {
        results.push({ companyId: company.id, status: `error: ${String(err)}` })
      }
    }

    return Response.json({ status: 'ok', results })
  } finally {
    await releaseCronLock('identity-rematch')
  }
}
```

- [ ] **Step 1: Write `app/api/cron/identity-rematch/route.test.ts` first**, mirroring `app/api/cron/sync-tick/route.test.ts`'s exact harness — that file mocks `buildAdapterForConnection` and (there) `syncConnection` at the module seam via `vi.hoisted`, seeds real `tenants`/`erp_companies` rows through `createTestDatabase()`, and sets `process.env.CRON_SECRET = 'test-secret'` in `beforeAll`. Copy that structure verbatim, substituting `matchUsersByEmail` for `syncConnection`:

```typescript
// app/api/cron/identity-rematch/route.test.ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as schema from '@/drizzle/schema'
import { runMigrations } from '@/scripts/migrate'
import { createTestDatabase, type TestDatabase } from '@/lib/test-support/db'
import type { ErpAdapter } from '@herbe/erp-core'
import type { MatchSummary } from '@/lib/auth/identity-link'

const { buildAdapterForConnectionMock, matchUsersByEmailMock } = vi.hoisted(() => ({
  buildAdapterForConnectionMock: vi.fn(),
  matchUsersByEmailMock: vi.fn(),
}))

vi.mock('@/lib/erp/connection', () => ({
  buildAdapterForConnection: buildAdapterForConnectionMock,
}))

vi.mock('@/lib/auth/identity-link', () => ({
  matchUsersByEmail: matchUsersByEmailMock,
}))

let testDb: TestDatabase
let sql: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>

const fakeAdapter = {} as ErpAdapter
const okSummary: MatchSummary = { linked: 1, alreadyLinked: 0, noMatch: 0 }

beforeAll(async () => {
  testDb = await createTestDatabase()
  await runMigrations(testDb.url)
  process.env.DATABASE_URL = testDb.url
  process.env.CRON_SECRET = 'test-secret'

  sql = postgres(testDb.url)
  db = drizzle(sql, { schema })
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await testDb?.cleanup()
})

afterEach(() => {
  buildAdapterForConnectionMock.mockReset()
  matchUsersByEmailMock.mockReset()
})

async function makeCompany(slug: string) {
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: slug }).returning()
  const [company] = await db
    .insert(schema.erpCompanies)
    .values({ tenantId: tenant.id, displayName: slug, adapterType: 'standard_books', adapterConfigJson: {} })
    .returning()
  return company
}

describe('GET /api/cron/identity-rematch', () => {
  it('rejects a request with no bearer header', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/cron/identity-rematch'))
    expect(res.status).toBe(401)
  })

  it('rejects a request with the wrong bearer token', async () => {
    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer wrong-secret' } }),
    )
    expect(res.status).toBe(401)
  })

  it('fans out over every active company, driving matchUsersByEmail via buildAdapterForConnection', async () => {
    const companyA = await makeCompany('rematch-a')
    const companyB = await makeCompany('rematch-b')

    buildAdapterForConnectionMock.mockResolvedValue(fakeAdapter)
    matchUsersByEmailMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')

    for (const company of [companyA, companyB]) {
      const entry = body.results.find((r: { companyId: string }) => r.companyId === company.id)
      expect(entry.status).toBe('ok')
      expect(entry.summary).toEqual(okSummary)
      expect(buildAdapterForConnectionMock).toHaveBeenCalledWith(expect.anything(), company.id)
      expect(matchUsersByEmailMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ erpCompanyId: company.id, tenantId: company.tenantId, adapter: fakeAdapter }),
      )
    }
  })

  it('reports a company whose buildAdapterForConnection throws as an error, without blocking the rest', async () => {
    const goodCompany = await makeCompany('rematch-good')
    const badCompany = await makeCompany('rematch-bad')

    buildAdapterForConnectionMock.mockImplementation(async (_db: unknown, erpCompanyId: string) => {
      if (erpCompanyId === badCompany.id) throw new Error('failed to decrypt creds')
      return fakeAdapter
    })
    matchUsersByEmailMock.mockResolvedValue(okSummary)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    const badEntry = body.results.find((r: { companyId: string }) => r.companyId === badCompany.id)
    expect(badEntry.status).toContain('failed to decrypt creds')
    expect(badEntry.summary).toBeUndefined()

    const goodEntry = body.results.find((r: { companyId: string }) => r.companyId === goodCompany.id)
    expect(goodEntry.status).toBe('ok')
    expect(matchUsersByEmailMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ erpCompanyId: badCompany.id }),
    )
  })

  it('returns {status: "skipped", reason: "lock held"} when the lock is already held', async () => {
    const { acquireCronLock, releaseCronLock } = await import('@/lib/cronLock')
    expect(await acquireCronLock('identity-rematch', 55)).toBe(true)

    const { GET } = await import('./route')
    const res = await GET(
      new Request('http://x/api/cron/identity-rematch', { headers: { authorization: 'Bearer test-secret' } }),
    )
    const body = await res.json()

    expect(body).toEqual({ status: 'skipped', reason: 'lock held' })
    await releaseCronLock('identity-rematch')
  })
})
```
- [ ] **Step 2: Run it, confirm it fails.**
- [ ] **Step 3: Create the route file** with the content above.
- [ ] **Step 4: Add the cron entry to `vercel.json`**:

```json
{ "path": "/api/cron/identity-rematch", "schedule": "0 3 * * *" }
```

(append to the existing `crons` array, alongside `sync-tick`).

- [ ] **Step 5: Run `pnpm exec vitest run app/api/cron/identity-rematch`** — green.
- [ ] **Step 6: Extend `tests/live/erp-contract.test.ts`.** Capture `tenantId` in the outer `describe` scope (`let tenantId: string` alongside `let companyId: string`; set `tenantId = tenant.id` in `beforeAll` where `tenant` is already destructured). Add two `it` blocks after the existing `WSVc` one, before the final `syncConnection` one:

```typescript
  it('pulls UserVc as a full delta-capable list', async () => {
    const rows = await adapter.pullFullList('UserVc')
    expect(Array.isArray(rows)).toBe(true)
    console.log(`live UserVc pullFullList: ${rows.length} rows`)
    expect(await adapter.probeIncrementalSupport('UserVc')).toBe(true)
  })

  it('matches a user by email against live UserVc data and links exactly once', async () => {
    const rows = await adapter.pullFullList('UserVc')
    const withEmail = rows.find((r) => typeof r.LoginEmailAddr === 'string' && r.LoginEmailAddr) ??
      rows.find((r) => typeof r.emailAddr === 'string' && r.emailAddr)
    if (!withEmail) {
      console.log('live UserVc: no row carries an email address — skipping match assertion')
      return
    }
    const email = String((withEmail as Record<string, unknown>).LoginEmailAddr || (withEmail as Record<string, unknown>).emailAddr)

    const [user] = await db.insert(schema.users).values({ tenantId, email }).returning()
    const result = await matchUsersByEmail(db, { tenantId, erpCompanyId: companyId, adapter })
    console.log(`live identity match: linked=${result.linked} alreadyLinked=${result.alreadyLinked} noMatch=${result.noMatch}`)
    expect(result.linked).toBeGreaterThanOrEqual(1)

    const links = await db.select().from(schema.identityLinks).where(eq(schema.identityLinks.userId, user.id))
    expect(links).toHaveLength(1)
    expect(links[0].provider).toBe('erp')
  })
```

Add `import { matchUsersByEmail } from '@/lib/auth/identity-link'` to the file's imports.

- [ ] **Step 7: Run the live suite**

```bash
RUN_LIVE_ERP_TESTS=1 pnpm test:live
```

Expect all tests green, including the two new ones, against the real dedicated test ERP. If `UserVc` turns out not delta-capable live (contradicting doc17's verified note), fix the assertion to match reality and flag it in the doc24 update — do not weaken the test to hide a real finding.

- [ ] **Step 8: Verify (offline)**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
pnpm exec vitest run --coverage
```

- [ ] **Step 9: Commit**

```bash
git add app/api/cron/identity-rematch vercel.json tests/live/erp-contract.test.ts
git commit -m "feat(auth): daily identity-rematch cron + live UserVc contract proof"
```

---

## Task 6 — doc24 update + push + PR

- [ ] **Step 1:** Edit `docs/24-phase1-status-and-parallel-handoff.md`:
  - §1 table: flip WS2's row to **"Core done (roles/capabilities, session revocation, device registry, ERP identity link by email — see §2). WebAuthn, TOTP/password, Baltic eID, Entra ID OIDC, seat/license enforcement deferred (unclaimed)."**
  - §2: add a bullet describing the new infra other sessions build on: `lib/auth/roles.ts` (`Role`/`Capability`/`hasCapability`), `lib/auth/session-guard.ts` (`getVerifiedSession`/`bumpSessionVersion` — the pattern any future session-gated route should use instead of bare `auth()`), `identity_links` table + `lib/auth/identity-link.ts` (`matchUsersByEmail`) as the reference for how WS4 checks "does this technician have an ERP person code" (join `identity_links` on `userId` + `provider='erp'` + `erpCompanyId`).
  - Record the newly-verified ERP fact: `UserVc` confirmed delta-capable live (or correct this if Task 5's live run said otherwise).
  - §4: list the deferred items from this plan's "Deferred" section as still-open, ready-to-assign follow-up work.
  - Refresh the "Last updated" line to today's date and this PR.
- [ ] **Step 2: Commit**

```bash
git add docs/24-phase1-status-and-parallel-handoff.md
git commit -m "docs(service): WS2 core done — roles, session revocation, device registry, identity link"
```

- [ ] **Step 3: Push and open a draft PR into `preview`**

```bash
git push -u origin feature/service-phase1-ws2-roles-identity
gh pr create --draft --base preview --title "WS2 core: roles, session revocation, device registry, ERP identity link" --body "$(cat <<'EOF'
## Summary
- Role/capability model (lib/auth/roles.ts) + session.user.role, reusing the existing 5-role union from lib/seed/personas.ts
- Real session_version enforcement (lib/auth/session-guard.ts), replacing the Phase-0 placeholder
- Device registry: list/revoke + sign-out-everywhere routes
- identity_links table + match-by-email against UserVc (no adapter changes needed — pullFullList/pullChanges are already generic)
- Daily identity-rematch cron + live ERP contract proof

## Deferred (see plan doc + doc24 §4)
WebAuthn, TOTP/password, Baltic eID, Entra ID OIDC, seat/license enforcement

## Test plan
- [ ] pnpm exec tsc --noEmit clean
- [ ] pnpm exec vitest run green
- [ ] pnpm exec vitest run --coverage exit 0
- [ ] RUN_LIVE_ERP_TESTS=1 pnpm test:live green against the dedicated test ERP
EOF
)"
```

## Self-Review checklist (run before declaring the slice done)

- [ ] Every doc05 role/bullet has a corresponding `Capability` in `ROLE_CAPABILITIES` or is explicitly listed under Deferred.
- [ ] No task references a function/type not defined in an earlier task (cross-check `getVerifiedSession`, `bumpSessionVersion`, `hasCapability`, `matchUsersByEmail` signatures are used identically everywhere they're called).
- [ ] No PII (emails, names) appears in any `console.log` in the live test — counts only.
- [ ] `.env.vars` was never printed, committed, or pasted anywhere during execution.
