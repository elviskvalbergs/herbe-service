# herbe.service Phase 1 — Domain Core Implementation Plan (Slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ERP-independent domain core of herbe.service Phase 1 — the service-item tree, service orders + worksheets, the server-side status machine, charge types, the HistoryEvent projector, and a full seed dataset — as pure, TDD-covered modules with a Postgres schema, so every later Phase-1 workstream (ERP push, dispatch, field UX, `/api/ext/v1`) has a correct spine to build on.

**Architecture:** Server is truth; the client is UX. All entity state and every transition are enforced by pure server-side modules with injected I/O (no rules in HTTP handlers or components). New tables follow the existing `customers`/`items` template (`tenantId` + optional `erpCompanyId` + `changeSeq` + `deletedAt` + `unique(erpCompanyId, erpRef)`). ERP-owned concepts (the `Invoiced`/`Closed` order states, the `erpRef` set) are modelled now but, in this ERP-independent slice, are only ever reached via seed/test paths — the ERP poll that normally drives them is a later, test-ERP-gated slice.

**Tech Stack:** Next.js 16 (App Router), drizzle-orm + Postgres (Supabase), vitest 3 (v8 coverage), pnpm workspace, TypeScript. No new runtime dependencies.

**Spec:** herbe.service `docs/02-data-model.md` (entities + status machine), `docs/11-service-items-and-parts.md` (the tree + coverage), `docs/04-erp-sync.md` (charge-type enum only), `docs/15-testing-strategy.md` (TDD + seed conventions), and the workstream plan `docs/21-phase-1-implementation-plan.md` (WS7/WS8/WS13, milestone M0). Research digest that grounds this plan: the P0 codebase map + spec extract produced 2026-07-14 (`customers`/`items` schema template at `drizzle/schema.ts:40-85`, migration mechanism at `scripts/migrate.mjs`, seed at `lib/seed/scenarios/baseline.ts`).

## Scope

**In scope (this plan — Slice 1):** the domain entities + status machine + charge type + coverage logic + HistoryEvent projector + seed. Everything here is buildable and fully testable with **no ERP connection** (against a throwaway test Postgres via `lib/test-support/db.ts`).

**Explicitly deferred to later slices (do NOT build here):**
- **`/api/ext/v1` API** (shell + read endpoints + `POST /requests`/`/confirm`/`/feedback`). herbe.service's own `06-roadmap.md:65` commits only the API *shell* to Phase 1 and `08-suite-integration.md:58` marks the read API "future, re-cut later"; the write endpoints need Phase-2 entities (`OrderSignoff`, `CustomerFeedback`). Those endpoints also *read the entities this plan builds*, so they are the natural **next** slice — see "Next slice" at the end. Building them now would pull scope forward ahead of the owner's sequencing; this plan deliberately does not.
- **ERP inbound adapter (WS3) and the outbound push-queue saga (WS4).** Both are gated on the owner-arranged dedicated test ERP (`21-...` §3 blocker). This plan models the ERP-facing fields (`erpRef` set, ERP-owned states) but wires no ERP I/O.
- Dispatch board, van stock/scanning, DOCX documents, field-execution UX, auth/role changes, whitelabel, licensing (WS9-WS12, WS14).

## Global Constraints

- **Base branch: `phase0/foundations`** (this repo's real code lives there; `preview` is docs-only). This plan's branch `feature/service-phase1-core` is cut from `origin/phase0/foundations`. Run `pnpm install` in the worktree before the first test run. Do NOT base on `preview`.
- **Migrations:** hand-authored `scripts/migrations/NNNN_description.sql`, applied by `scripts/migrate.mjs` and tracked in the `herbe_migrations.applied` table (by filename). Highest existing is `0007_scope_membership.sql`; this plan uses `0008`+. Idempotency here is **by tolerated Postgres error codes** (42710/42P07/42P06/42701/42P16/42704 are caught and warned), NOT by `IF NOT EXISTS` — but still prefer `IF NOT EXISTS`/`CREATE TYPE ... ` guarded where trivially possible. Each statement runs in its own implicit transaction. There is **no `_journal.json`** (unlike herbe.portal). Verify the next number with `ls scripts/migrations/*.sql | sort | tail -1` at execution time.
- **Every new domain table** carries: `id uuid PK default gen_random_uuid()`, `tenant_id uuid NOT NULL` (FK `tenants`), `erp_company_id uuid` (FK `erp_companies`; **nullable** — app-only rows have none), `change_seq bigint` (bumped by the existing `bump_change_seq()` trigger — attach the trigger per table exactly as migration `0002` does for `customers`/`items`), `updated_at`, `deleted_at` (tombstone), and `UNIQUE (erp_company_id, erp_ref)` **only** where the row has a single scalar ERP counterpart. Copy the shape from `customers`/`items` (`drizzle/schema.ts:40-85`).
- **Tenant scope comes only from the session** (`session.user.tenantId`), never from client input (a client-supplied `tenantId` was a real IDOR — `app/api/sync/customers/route.ts:15-30`). Store functions take `tenantId` as a caller-supplied arg from the session, never from a request body.
- **Server is truth:** the status machine, charge-type derivation, coverage math, and the projector are **pure modules** under `lib/domain/**` with injected I/O — no business rules in route handlers or components (`21-...` §2; `03:118`).
- **`erpRef` is a set keyed by purpose**, not a scalar (`02:154-158`): a Worksheet maps to both a `WSVc` record and a `worksheetShadow` `ActVc`. Model it as a dedicated `erp_refs` side table keyed `(entity_type, entity_id, purpose)` from the start, so the ERP-push slice needs no reshaping migration. The scalar `erp_ref` column on the entity tables stays for the primary register ref + the `UNIQUE(erp_company_id, erp_ref)` fast path.
- **Charge-type enum is locked to ERP "string set 31"** (`04:103`, `02:88`): app values `invoiceable | warranty | contract | goodwill` map 1:1 to the integer `ItemType` `1 | 2 | 3 | 4` (`0` = "-"/unset). Push writes the integer; inbound `0` → `invoiceable` **and flags for manager review**. **Never conflate with `INVc.ItemType`** (a different field). Only `invoiceable` charges the customer.
- **One worksheet per (ServiceOrder × technician)** — `WSVc.EMCode` is single-technician. Crew = N worksheets sharing a `crew_group_id`; there is no shared "lead worksheet" (`02:97`).
- **TDD is mandatory:** every spec rule lands as a named failing test first (`15:§1`). The status machine, charge-type, coverage, and projector are **core-logic modules requiring ≥90% line/branch coverage**; add their directory to the 90% override list in `vitest.config.ts` (currently only `lib/erp/**`, `packages/erp-core/**`, `lib/sync/**` — `15:9`). Overall floor is 80%.
- **ERP-owned states in a standalone build:** `Invoiced` (linked `IVVc`) and `Closed` (`SVOVc.DoneMark`) have no live source without an ERP. Model them as valid terminal states, reachable in this slice **only** via an explicit seed/test setter (`setErpOwnedState`), never via the normal transition API. The normal ERP-poll trigger is a later slice.
- **i18n:** this slice is API/logic + seed only — no user-facing UI, so no locale keys required. If a task adds an admin/debug screen, add `en` + `lv` keys only (`locales/{en,lv}.json`; the other 5 stay `{}`).
- **Commits:** frequent, one per task minimum. Trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TarGC3f9guUBQLodgCTiaD
  ```
- Match existing code style (comments only for *why*; follow the `customers`/`items`/`lib/seed` idioms).

## File Structure

**New files:**
- `scripts/migrations/0008_service_items.sql`, `0009_item_models.sql`, `0010_service_orders.sql`, `0011_worksheets.sql`, `0012_erp_refs.sql`, `0013_history_events.sql` — schema migrations.
- `drizzle/schema.ts` (modify) — add the new tables + `InferSelectModel` exports.
- `lib/domain/charge-type.ts` (+ test) — the charge-type enum ↔ integer mapping + default-suggestion + inbound-0 rule.
- `lib/domain/coverage.ts` (+ test) — group-coverage resolution + projection/rollup + coverage-% math.
- `lib/domain/order-status.ts` (+ test) — the order status machine (pure).
- `lib/domain/worksheet-status.ts` (+ test) — the worksheet status machine (pure).
- `lib/domain/history-projector.ts` (+ test) — the idempotent HistoryEvent projector.
- `lib/domain/types.ts` — shared domain enums/types (order + worksheet status unions, charge type, node kind, erpRef purpose, HistoryEvent).
- `lib/domain/stores/service-items.ts`, `service-orders.ts`, `worksheets.ts`, `erp-refs.ts`, `history.ts` (+ tests) — the DB store layer (CRUD/scan, tenant-scoped), following the `customers`/`items` store idiom.
- `lib/seed/scenarios/domain.ts` (+ test) — the seed extension (full tree + orders/worksheets in every status).

**Modified files:**
- `vitest.config.ts` — add `lib/domain/**` to the 90% coverage override.
- `lib/seed/scenarios/baseline.ts` — call the new `seedDomain(db, ctx)` after the tenant/erpCompany seed.
- `lib/seed/index.ts` — re-export `seedDomain` if needed.

---

### Task 1: Domain types + service-item tree schema & store

**Files:**
- Create: `lib/domain/types.ts`
- Create: `scripts/migrations/0008_service_items.sql`, `scripts/migrations/0009_item_models.sql`
- Modify: `drizzle/schema.ts` (add `itemModels`, `serviceItems` tables + type exports)
- Create: `lib/domain/stores/service-items.ts`
- Test: `tests/unit/domain/service-items-store.test.ts`

**Interfaces:**
- Produces: `type NodeKind = 'system' | 'unit' | 'lot'`; `type OrderStatus`, `type WorksheetStatus`, `type ChargeType`, `type ErpRefPurpose`, `interface HistoryEvent` (all in `lib/domain/types.ts`); Drizzle tables `itemModels`, `serviceItems`; store fns `insertServiceItem`, `getServiceItemById(tenantId, id)`, `scanServiceItemsForTenant(tenantId)`, `getChildren(tenantId, parentId)`.

- [ ] **Step 1: Define `lib/domain/types.ts`** (the vocabulary every later task imports)

```ts
export type NodeKind = 'system' | 'unit' | 'lot';

export type OrderStatus =
  | 'New' | 'Accepted' | 'Planned' | 'In progress'
  | 'Work done' | 'Confirmed' | 'Invoiced' | 'Closed' | 'Cancelled';

export type WorksheetStatus =
  | 'Draft' | 'Assigned' | 'Accepted' | 'In progress' | 'Paused'
  | 'Done' | 'Approved' | 'Synced' | 'Rejected';

export type ChargeType = 'invoiceable' | 'warranty' | 'contract' | 'goodwill';

/** Purpose key for an entity's ERP reference (erpRef is a set, not a scalar). */
export type ErpRefPurpose = 'primary' | 'worksheetShadow' | 'orderShadow' | 'workSegment';

export type HistoryEventKind =
  | 'work_done' | 'part_replaced' | 'measurement' | 'status_change'
  | 'covered_by_group_service' | 'erp_history';

export interface HistoryEvent {
  /** Deterministic idempotency key: `${sourceId}:${kind}:${revision}`. */
  key: string;
  serviceItemId: string;
  at: string; // ISO
  kind: HistoryEventKind;
  summary: string;
  orderId?: string;
  worksheetId?: string;
  coverage?: { covered: number; of: number };
}
```

- [ ] **Step 2: Read the template** — read `drizzle/schema.ts:40-85` (`customers`/`items`) and `scripts/migrations/0002_domain_customers_items.sql` in full. Every new table mirrors that shape and re-attaches the `bump_change_seq` trigger exactly as `0002` does.

- [ ] **Step 3: Write `scripts/migrations/0009_item_models.sql`** (models first — service items FK it)

```sql
CREATE TABLE IF NOT EXISTS "item_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "make" text,
  "model" text,
  "category" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "item_models_tenant_idx" ON "item_models" ("tenant_id");
```

- [ ] **Step 4: Write `scripts/migrations/0008_service_items.sql`**

```sql
CREATE TABLE IF NOT EXISTS "service_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "erp_ref" text,
  "parent_id" uuid REFERENCES "service_items"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "serial_nr" text,
  "secondary_serial" text,
  "quantity" integer,
  "model_id" uuid REFERENCES "item_models"("id") ON DELETE SET NULL,
  "path" text NOT NULL DEFAULT '',
  "position_code" text,
  "label_id" text NOT NULL,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "site_name" text,
  "warranty_until" timestamptz,
  "warranty_labor_covered" boolean NOT NULL DEFAULT false,
  "warranty_parts_covered" boolean NOT NULL DEFAULT false,
  "change_seq" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "service_items_erp_ref_uniq" UNIQUE ("erp_company_id", "erp_ref")
);
CREATE INDEX IF NOT EXISTS "service_items_tenant_idx" ON "service_items" ("tenant_id");
CREATE INDEX IF NOT EXISTS "service_items_parent_idx" ON "service_items" ("parent_id");
CREATE INDEX IF NOT EXISTS "service_items_label_idx" ON "service_items" ("label_id");
CREATE INDEX IF NOT EXISTS "service_items_change_seq_idx" ON "service_items" ("change_seq");
CREATE UNIQUE INDEX IF NOT EXISTS "service_items_label_uniq" ON "service_items" ("label_id");
```

Then attach the change-seq trigger for this table, copying the exact `CREATE TRIGGER ... EXECUTE FUNCTION bump_change_seq()` statement `0002` uses for `items`, retargeted to `service_items`. (Read `0002` for the precise trigger syntax — reproduce it verbatim with the new table name.)

- [ ] **Step 5: Add the Drizzle tables to `drizzle/schema.ts`** (after `items`), mirroring the `items` definition's column helpers exactly; add `export type ServiceItemRow = InferSelectModel<typeof serviceItems>;` and `export type ItemModelRow = InferSelectModel<typeof itemModels>;`.

- [ ] **Step 6: Write the failing store test** — `tests/unit/domain/service-items-store.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase } from '@/lib/test-support/db';
import { runMigrations } from '@/scripts/migrate.mjs';
import { insertServiceItem, getServiceItemById, getChildren } from '@/lib/domain/stores/service-items';
// ... use the same test-DB bootstrap the existing store tests use; read an existing
// store test (e.g. tests touching customers/items) for the exact createTestDatabase +
// migrate + drizzle-connect boilerplate and copy it verbatim.

describe('service-items store', () => {
  it('inserts a system node and reads it back scoped by tenant', async () => {
    const sys = await insertServiceItem(db, { tenantId, kind: 'system', name: 'Store 14', labelId: 'L-sys-1' });
    const got = await getServiceItemById(db, tenantId, sys.id);
    expect(got?.kind).toBe('system');
    // cross-tenant read returns null
    expect(await getServiceItemById(db, otherTenantId, sys.id)).toBeNull();
  });

  it('nests a unit under a system and lists children', async () => {
    const sys = await insertServiceItem(db, { tenantId, kind: 'system', name: 'Zone 2', labelId: 'L-sys-2' });
    const unit = await insertServiceItem(db, { tenantId, kind: 'unit', name: 'AHU-2', serialNr: 'SN9', parentId: sys.id, labelId: 'L-unit-1' });
    const kids = await getChildren(db, tenantId, sys.id);
    expect(kids.map((k) => k.id)).toContain(unit.id);
  });
});
```

- [ ] **Step 7: Run it — fails** (module/table missing): `pnpm vitest run tests/unit/domain/service-items-store.test.ts` → FAIL.

- [ ] **Step 8: Implement `lib/domain/stores/service-items.ts`** following the `customers`/`items` store idiom (tenant-scoped selects, `deletedAt` filtering). Provide `insertServiceItem(db, input)`, `getServiceItemById(db, tenantId, id)` (returns null cross-tenant / when tombstoned), `scanServiceItemsForTenant(db, tenantId)`, `getChildren(db, tenantId, parentId)`.

- [ ] **Step 9: Run — passes.** Register both migration files (no journal — just the files). Verify with `pnpm vitest run tests/unit/domain/service-items-store.test.ts` → PASS. `pnpm tsc --noEmit` (or the repo's typecheck script) → clean.

- [ ] **Step 10: Commit**

```bash
git add lib/domain/types.ts drizzle/schema.ts scripts/migrations/0008_service_items.sql scripts/migrations/0009_item_models.sql lib/domain/stores/service-items.ts tests/unit/domain/service-items-store.test.ts
git commit -m "feat(domain): service-item tree schema + store + domain types"
```

---

### Task 2: Charge-type module

**Files:**
- Create: `lib/domain/charge-type.ts`
- Test: `tests/unit/domain/charge-type.test.ts`

**Interfaces:**
- Consumes: `ChargeType` from `lib/domain/types.ts`.
- Produces: `chargeTypeToItemType(c: ChargeType): 1|2|3|4`; `itemTypeToChargeType(n: number): { charge: ChargeType; needsReview: boolean }`; `suggestChargeType(input: { contractLinked: boolean; unitInWarranty: boolean }): ChargeType`; `chargesCustomer(c: ChargeType): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { chargeTypeToItemType, itemTypeToChargeType, suggestChargeType, chargesCustomer } from '@/lib/domain/charge-type';

describe('charge type ↔ ItemType (string set 31)', () => {
  it('maps app charge types to the ERP integer 1..4', () => {
    expect(chargeTypeToItemType('invoiceable')).toBe(1);
    expect(chargeTypeToItemType('warranty')).toBe(2);
    expect(chargeTypeToItemType('contract')).toBe(3);
    expect(chargeTypeToItemType('goodwill')).toBe(4);
  });
  it('maps ERP 0 (unset) to invoiceable AND flags it for manager review', () => {
    expect(itemTypeToChargeType(0)).toEqual({ charge: 'invoiceable', needsReview: true });
  });
  it('maps ERP 1..4 back without a review flag', () => {
    expect(itemTypeToChargeType(2)).toEqual({ charge: 'warranty', needsReview: false });
  });
});

describe('suggestChargeType', () => {
  it('contract-linked row → contract', () => {
    expect(suggestChargeType({ contractLinked: true, unitInWarranty: true })).toBe('contract');
  });
  it('warranty unit, no contract → warranty', () => {
    expect(suggestChargeType({ contractLinked: false, unitInWarranty: true })).toBe('warranty');
  });
  it('neither → invoiceable', () => {
    expect(suggestChargeType({ contractLinked: false, unitInWarranty: false })).toBe('invoiceable');
  });
});

describe('chargesCustomer', () => {
  it('only invoiceable charges the customer', () => {
    expect(chargesCustomer('invoiceable')).toBe(true);
    for (const c of ['warranty', 'contract', 'goodwill'] as const) expect(chargesCustomer(c)).toBe(false);
  });
});
```

- [ ] **Step 2: Run — fails.** `pnpm vitest run tests/unit/domain/charge-type.test.ts` → FAIL.

- [ ] **Step 3: Implement `lib/domain/charge-type.ts`**

```ts
import type { ChargeType } from './types';

const TO_INT: Record<ChargeType, 1 | 2 | 3 | 4> = { invoiceable: 1, warranty: 2, contract: 3, goodwill: 4 };
const FROM_INT: Record<number, ChargeType> = { 1: 'invoiceable', 2: 'warranty', 3: 'contract', 4: 'goodwill' };

export function chargeTypeToItemType(c: ChargeType): 1 | 2 | 3 | 4 {
  return TO_INT[c];
}

/** Inbound `0` ("-"/unset) is not silently assumed invoiceable — it is flagged for manager review (02:88). */
export function itemTypeToChargeType(n: number): { charge: ChargeType; needsReview: boolean } {
  if (n === 0) return { charge: 'invoiceable', needsReview: true };
  const charge = FROM_INT[n];
  if (!charge) return { charge: 'invoiceable', needsReview: true };
  return { charge, needsReview: false };
}

export function suggestChargeType(input: { contractLinked: boolean; unitInWarranty: boolean }): ChargeType {
  if (input.contractLinked) return 'contract';
  if (input.unitInWarranty) return 'warranty';
  return 'invoiceable';
}

export function chargesCustomer(c: ChargeType): boolean {
  return c === 'invoiceable';
}
```

- [ ] **Step 4: Run — passes.** `pnpm vitest run tests/unit/domain/charge-type.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/charge-type.ts tests/unit/domain/charge-type.test.ts
git commit -m "feat(domain): charge-type ↔ ItemType mapping + suggestion rules"
```

---

### Task 3: Coverage module (group-service math)

**Files:**
- Create: `lib/domain/coverage.ts`
- Test: `tests/unit/domain/coverage.test.ts`

**Interfaces:**
- Produces: `type Coverage = { mode: 'all' } | { mode: 'n_of_m'; n: number } | { mode: 'list'; ids: string[] } | { mode: 'all_except'; ids: string[] }`; `resolveCoveredIds(coverage: Coverage, memberIds: string[]): string[]`; `coverageFraction(coverage: Coverage, memberIds: string[]): { covered: number; of: number }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveCoveredIds, coverageFraction, type Coverage } from '@/lib/domain/coverage';

const members = ['a', 'b', 'c', 'd']; // 4 members

describe('resolveCoveredIds', () => {
  it("'all' covers every member", () => {
    expect(resolveCoveredIds({ mode: 'all' }, members).sort()).toEqual(members);
  });
  it("'n_of_m' covers the first n members deterministically", () => {
    expect(resolveCoveredIds({ mode: 'n_of_m', n: 2 }, members)).toEqual(['a', 'b']);
  });
  it("'list' covers exactly the listed members that are still present", () => {
    expect(resolveCoveredIds({ mode: 'list', ids: ['b', 'z'] }, members)).toEqual(['b']);
  });
  it("'all_except' covers everyone but the excepted", () => {
    expect(resolveCoveredIds({ mode: 'all_except', ids: ['c'] }, members).sort()).toEqual(['a', 'b', 'd']);
  });
});

describe('coverageFraction', () => {
  it('reports covered/of for n_of_m', () => {
    expect(coverageFraction({ mode: 'n_of_m', n: 3 }, members)).toEqual({ covered: 3, of: 4 });
  });
});
```

- [ ] **Step 2: Run — fails.** → FAIL.

- [ ] **Step 3: Implement `lib/domain/coverage.ts`**

```ts
export type Coverage =
  | { mode: 'all' }
  | { mode: 'n_of_m'; n: number }
  | { mode: 'list'; ids: string[] }
  | { mode: 'all_except'; ids: string[] };

export function resolveCoveredIds(coverage: Coverage, memberIds: string[]): string[] {
  switch (coverage.mode) {
    case 'all':
      return [...memberIds];
    case 'n_of_m':
      return memberIds.slice(0, Math.max(0, Math.min(coverage.n, memberIds.length)));
    case 'list': {
      const set = new Set(coverage.ids);
      return memberIds.filter((id) => set.has(id));
    }
    case 'all_except': {
      const set = new Set(coverage.ids);
      return memberIds.filter((id) => !set.has(id));
    }
  }
}

export function coverageFraction(coverage: Coverage, memberIds: string[]): { covered: number; of: number } {
  return { covered: resolveCoveredIds(coverage, memberIds).length, of: memberIds.length };
}
```

- [ ] **Step 4: Run — passes.** → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/coverage.ts tests/unit/domain/coverage.test.ts
git commit -m "feat(domain): group-coverage resolution + fraction math"
```

---

### Task 4: Service orders + worksheets schema, erp_refs, stores

**Files:**
- Create: `scripts/migrations/0010_service_orders.sql`, `0011_worksheets.sql`, `0012_erp_refs.sql`
- Modify: `drizzle/schema.ts`
- Create: `lib/domain/stores/service-orders.ts`, `lib/domain/stores/worksheets.ts`, `lib/domain/stores/erp-refs.ts`
- Test: `tests/unit/domain/orders-worksheets-store.test.ts`

**Interfaces:**
- Consumes: `serviceItems` (Task 1); `OrderStatus`/`WorksheetStatus`/`ChargeType`/`ErpRefPurpose` (Task 1 types); `Coverage` (Task 3).
- Produces: tables `serviceOrders`, `serviceOrderRows`, `worksheets`, `worksheetRows`, `timeEntries`, `distanceEntries`, `erpRefs`; stores `insertServiceOrder`/`getServiceOrderById`/`scanServiceOrdersForTenant`/`setOrderStatus`, `insertWorksheet`/`getWorksheetById`/`getWorksheetsForOrder`/`setWorksheetStatus`, `putErpRef`/`getErpRefs`.

- [ ] **Step 1: Write `0010_service_orders.sql`** — `service_orders` (base columns per Global Constraints + `customer_id`, `site_name`, `contact_name`, `description text`, `priority text`, `requested_at timestamptz`, `promised_date timestamptz`, `status text NOT NULL DEFAULT 'New'`, `default_charge_type text NOT NULL DEFAULT 'invoiceable'`, `order_number text` [the app number; ERP number lands in erp_refs], `crew_group_id uuid`) and `service_order_rows` (`id`, `order_id` FK, `service_item_id` FK nullable, `coverage jsonb`, `symptom text`, `work_type text`, `charge_type text`). Attach the `bump_change_seq` trigger to `service_orders`. Indexes on `tenant_id`, `customer_id`, `status`, `change_seq`.

- [ ] **Step 2: Write `0011_worksheets.sql`** — `worksheets` (base + `order_id` FK, `technician_user_id uuid`, `crew_group_id uuid`, `status text NOT NULL DEFAULT 'Draft'`, `work_description text`, `fault text`, `cause text`, `remedy text`, `signed_on_site boolean NOT NULL DEFAULT false`, `signature_locked_at timestamptz`, `revision int NOT NULL DEFAULT 0`, `rejected_reason text`), `worksheet_rows` (`id`, `worksheet_id` FK, `service_item_id` FK nullable, `description text`, `quantity numeric`, `unit text`, `serial text`, `charge_type text NOT NULL DEFAULT 'invoiceable'`, `stock_location text`, `price numeric`, `sum numeric`), `time_entries` (`id`, `worksheet_id` FK, `kind text` [work|travel], `direction text` [to|from|null], `started_at`, `ended_at`, `minutes int`, `pause_reason text`), `distance_entries` (`id`, `worksheet_id` FK, `km numeric`, `billable boolean`). Attach `bump_change_seq` to `worksheets`. **Enforce one-worksheet-per-(order×technician)** with `CREATE UNIQUE INDEX ... ON worksheets (order_id, technician_user_id) WHERE deleted_at IS NULL AND technician_user_id IS NOT NULL`.

- [ ] **Step 3: Write `0012_erp_refs.sql`** — the erpRef set:

```sql
CREATE TABLE IF NOT EXISTS "erp_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,   -- 'service_order' | 'worksheet' | 'service_item'
  "entity_id" uuid NOT NULL,
  "purpose" text NOT NULL,       -- ErpRefPurpose
  "register" text,               -- 'SVOVc' | 'WSVc' | 'SVOSerVc' | 'ActVc'
  "record_ref" text NOT NULL,    -- ERP SerNr / @url
  "last_sequence" bigint,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_refs_uniq" UNIQUE ("entity_type", "entity_id", "purpose")
);
CREATE INDEX IF NOT EXISTS "erp_refs_entity_idx" ON "erp_refs" ("entity_type", "entity_id");
```

- [ ] **Step 4: Add all tables to `drizzle/schema.ts`** with `InferSelectModel` exports (`ServiceOrderRow`, `WorksheetRow` — note the collision: name the worksheet-line table export `WorksheetLineRow` and the order-line `ServiceOrderLineRow` to avoid confusing the *row entity* with a *table row type*; the drizzle table consts can be `serviceOrderRows`/`worksheetRows`).

- [ ] **Step 5: Write the failing store test** — `tests/unit/domain/orders-worksheets-store.test.ts`: insert an order (defaults to status `New`), add a worksheet, assert the unique `(order_id, technician_user_id)` index rejects a second worksheet for the same tech on the same order, assert `putErpRef` + `getErpRefs` round-trips two purposes (`primary` + `worksheetShadow`) for one worksheet, assert cross-tenant reads return nothing. (Reuse the Task-1 test-DB bootstrap.)

- [ ] **Step 6: Run — fails.** → FAIL.

- [ ] **Step 7: Implement the three stores** following the `customers`/`items` idiom. `setOrderStatus`/`setWorksheetStatus` here are **thin persistence setters** (write the status column); they do NOT contain transition rules — those live in Tasks 5/6 and call these setters. `putErpRef` upserts on the `(entity_type, entity_id, purpose)` unique key; `getErpRefs(db, entityType, entityId)` returns all purposes.

- [ ] **Step 8: Run — passes.** → PASS. `pnpm tsc --noEmit` → clean.

- [ ] **Step 9: Commit**

```bash
git add scripts/migrations/0010_service_orders.sql scripts/migrations/0011_worksheets.sql scripts/migrations/0012_erp_refs.sql drizzle/schema.ts lib/domain/stores/service-orders.ts lib/domain/stores/worksheets.ts lib/domain/stores/erp-refs.ts tests/unit/domain/orders-worksheets-store.test.ts
git commit -m "feat(domain): service orders, worksheets, time/distance, erp_refs schema + stores"
```

---

### Task 5: Worksheet status machine

**Files:**
- Create: `lib/domain/worksheet-status.ts`
- Test: `tests/unit/domain/worksheet-status.test.ts`

**Interfaces:**
- Consumes: `WorksheetStatus` (types).
- Produces: `canTransitionWorksheet(from: WorksheetStatus, to: WorksheetStatus): boolean`; `assertWorksheetTransition(from, to): void` (throws `DomainTransitionError`); `isTerminalWorksheet(s: WorksheetStatus): boolean`; `class DomainTransitionError extends Error`.

- [ ] **Step 1: Write the failing test** — cover the spec flow `Draft → Assigned → Accepted → In progress → Paused → Done → Approved → Synced` plus `Rejected` (from `In progress`/`Paused`/`Done`, back to the technician), and the illegal jumps.

```ts
import { describe, it, expect } from 'vitest';
import { canTransitionWorksheet, assertWorksheetTransition, DomainTransitionError } from '@/lib/domain/worksheet-status';

describe('worksheet status machine', () => {
  it('allows the happy path Draft→Assigned→Accepted→In progress→Done→Approved→Synced', () => {
    const path = ['Draft','Assigned','Accepted','In progress','Done','Approved','Synced'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransitionWorksheet(path[i], path[i + 1])).toBe(true);
  });
  it('allows In progress↔Paused and Paused→Done', () => {
    expect(canTransitionWorksheet('In progress', 'Paused')).toBe(true);
    expect(canTransitionWorksheet('Paused', 'In progress')).toBe(true);
    expect(canTransitionWorksheet('Paused', 'Done')).toBe(true);
  });
  it('allows Rejected from In progress/Paused/Done and re-entry to In progress', () => {
    expect(canTransitionWorksheet('Done', 'Rejected')).toBe(true);
    expect(canTransitionWorksheet('Rejected', 'In progress')).toBe(true);
  });
  it('rejects illegal jumps (Draft→Approved, Synced→anything)', () => {
    expect(canTransitionWorksheet('Draft', 'Approved')).toBe(false);
    expect(canTransitionWorksheet('Synced', 'Draft')).toBe(false);
  });
  it('assertWorksheetTransition throws DomainTransitionError on an illegal move', () => {
    expect(() => assertWorksheetTransition('Draft', 'Synced')).toThrow(DomainTransitionError);
  });
});
```

- [ ] **Step 2: Run — fails.** → FAIL.

- [ ] **Step 3: Implement `lib/domain/worksheet-status.ts`** as an explicit adjacency map (`Record<WorksheetStatus, WorksheetStatus[]>`) plus the assert/terminal helpers. `Synced` is terminal; `Rejected` transitions back to `In progress`. Base the exact edges on `docs/02-data-model.md:92`.

- [ ] **Step 4: Run — passes.** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(domain): worksheet status machine"`

---

### Task 6: Order status machine (derived + manual + ERP-owned + rollback + cancellation)

**Files:**
- Create: `lib/domain/order-status.ts`
- Test: `tests/unit/domain/order-status.test.ts`

**Interfaces:**
- Consumes: `OrderStatus`, `WorksheetStatus` (types).
- Produces:
  - `deriveOrderStatus(input: { manualState: 'Work done' | 'Confirmed' | null; erpState: 'Invoiced' | 'Closed' | null; cancelled: boolean; bookingCount: number; worksheets: WorksheetStatus[] }): OrderStatus` — the single server-side recompute.
  - `canSetManual(target: 'Work done' | 'Confirmed', worksheets: WorksheetStatus[]): { ok: boolean; reason?: string }` — the manual-transition guards.
  - `canCancel(worksheets: WorksheetStatus[]): boolean` — cancellation allowed only while no worksheet is beyond `Accepted`.
  - `worksheetsToCancelOnOrderCancel(worksheets: { id: string; status: WorksheetStatus }[]): string[]` — Draft/Assigned/Accepted worksheet ids to auto-cancel.

- [ ] **Step 1: Write the failing test** (table-driven — this is the load-bearing suite, `15:§3`)

```ts
import { describe, it, expect } from 'vitest';
import { deriveOrderStatus, canSetManual, canCancel, worksheetsToCancelOnOrderCancel } from '@/lib/domain/order-status';

describe('deriveOrderStatus', () => {
  const base = { manualState: null, erpState: null, cancelled: false, bookingCount: 0, worksheets: [] as any[] };
  it('ERP state wins (Closed > Invoiced > manual > derived)', () => {
    expect(deriveOrderStatus({ ...base, erpState: 'Closed', manualState: 'Confirmed' })).toBe('Closed');
    expect(deriveOrderStatus({ ...base, erpState: 'Invoiced', manualState: 'Confirmed' })).toBe('Invoiced');
  });
  it('Cancelled overrides everything except ERP terminal', () => {
    expect(deriveOrderStatus({ ...base, cancelled: true })).toBe('Cancelled');
  });
  it('manual Confirmed shows when set', () => {
    expect(deriveOrderStatus({ ...base, manualState: 'Confirmed', worksheets: ['Approved'] })).toBe('Confirmed');
  });
  it('In progress is derived when any worksheet is In progress/Paused', () => {
    expect(deriveOrderStatus({ ...base, worksheets: ['In progress'] })).toBe('In progress');
    expect(deriveOrderStatus({ ...base, worksheets: ['Paused'] })).toBe('In progress');
  });
  it('Planned is derived when a booking exists and no worksheet is active', () => {
    expect(deriveOrderStatus({ ...base, bookingCount: 1 })).toBe('Planned');
  });
  it('New when nothing has happened', () => {
    expect(deriveOrderStatus(base)).toBe('New');
  });
  it('adding a fresh worksheet rolls a Confirmed order back to the recomputed derived state', () => {
    // manualState cleared by the caller on rollback; here the derived recompute with an active worksheet
    expect(deriveOrderStatus({ ...base, manualState: null, worksheets: ['In progress'] })).toBe('In progress');
  });
});

describe('canSetManual', () => {
  it('Work done is allowed regardless of worksheet states (technician decision)', () => {
    expect(canSetManual('Work done', ['In progress']).ok).toBe(true);
  });
  it('Confirmed requires ALL worksheets Approved', () => {
    expect(canSetManual('Confirmed', ['Approved', 'Approved']).ok).toBe(true);
    expect(canSetManual('Confirmed', ['Approved', 'Done']).ok).toBe(false);
  });
});

describe('cancellation', () => {
  it('allowed only while no worksheet is beyond Accepted', () => {
    expect(canCancel(['Accepted', 'Draft'])).toBe(true);
    expect(canCancel(['In progress'])).toBe(false);
  });
  it('auto-cancels Draft/Assigned/Accepted worksheets', () => {
    expect(worksheetsToCancelOnOrderCancel([
      { id: 'w1', status: 'Draft' }, { id: 'w2', status: 'Accepted' }, { id: 'w3', status: 'In progress' },
    ])).toEqual(['w1', 'w2']);
  });
});
```

- [ ] **Step 2: Run — fails.** → FAIL.

- [ ] **Step 3: Implement `lib/domain/order-status.ts`** encoding `docs/02-data-model.md:63-95` precisely: precedence `Closed > Invoiced > Cancelled > manual(Confirmed/Work done) > derived(In progress > Planned > Accepted/New)`. `canSetManual('Confirmed', ...)` requires every worksheet `=== 'Approved'` (and at least one). `canCancel` = no worksheet in a state after `Accepted` in the worksheet flow order. `worksheetsToCancelOnOrderCancel` filters to `Draft|Assigned|Accepted`. Keep it a pure function; the caller (a later slice's transition service) clears `manualState` to trigger the rollback recompute.

- [ ] **Step 4: Run — passes.** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(domain): order status machine — derived/manual/ERP-owned + rollback + cancellation"`

---

### Task 7: HistoryEvent projector

**Files:**
- Create: `lib/domain/history-projector.ts`
- Modify: `drizzle/schema.ts` (+ `scripts/migrations/0013_history_events.sql`)
- Create: `lib/domain/stores/history.ts`
- Test: `tests/unit/domain/history-projector.test.ts`

**Interfaces:**
- Consumes: `HistoryEvent`, `HistoryEventKind` (types); `Coverage`/`resolveCoveredIds` (Task 3).
- Produces:
  - `projectWorksheetApproved(input: { worksheetId: string; orderId: string; revision: number; at: string; primaryItemId: string; groupCoverage?: { coverage: Coverage; memberIds: string[] }; summary: string }): HistoryEvent[]` — pure; deterministic keys; one event on the primary node + one `covered_by_group_service` event per covered descendant.
  - `dedupeByKey(events: HistoryEvent[]): HistoryEvent[]` — idempotent-merge helper.
  - store: `upsertHistoryEvents(db, tenantId, events)` (idempotent on `key`), `getHistoryForItem(db, tenantId, serviceItemId)`.

- [ ] **Step 1: Write `0013_history_events.sql`** — `history_events` (`id`, `tenant_id`, `service_item_id` FK, `key text NOT NULL`, `at timestamptz`, `kind text`, `summary text`, `order_id uuid`, `worksheet_id uuid`, `coverage_covered int`, `coverage_of int`, `created_at`), `UNIQUE (tenant_id, key)`, index on `(tenant_id, service_item_id)`. (Append-only; no `bump_change_seq` needed — history is delta-fed.)

- [ ] **Step 2: Add `historyEvents` to `drizzle/schema.ts`** + `HistoryEventRow` export.

- [ ] **Step 3: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { projectWorksheetApproved, dedupeByKey } from '@/lib/domain/history-projector';

describe('projectWorksheetApproved', () => {
  it('emits one work_done event on the primary item with a deterministic key', () => {
    const ev = projectWorksheetApproved({ worksheetId: 'w1', orderId: 'o1', revision: 0, at: '2026-07-01T00:00:00Z', primaryItemId: 'i1', summary: 'Serviced' });
    expect(ev).toHaveLength(1);
    expect(ev[0].key).toBe('w1:work_done:0');
    expect(ev[0].kind).toBe('work_done');
    expect(ev[0].serviceItemId).toBe('i1');
  });
  it('projects a covered_by_group_service event onto each covered descendant', () => {
    const ev = projectWorksheetApproved({
      worksheetId: 'w2', orderId: 'o1', revision: 0, at: '2026-07-01T00:00:00Z', primaryItemId: 'grp',
      groupCoverage: { coverage: { mode: 'n_of_m', n: 2 }, memberIds: ['a', 'b', 'c'] }, summary: 'Zone service',
    });
    // one primary event + two covered descendants
    const covered = ev.filter((e) => e.kind === 'covered_by_group_service').map((e) => e.serviceItemId).sort();
    expect(covered).toEqual(['a', 'b']);
    expect(ev.find((e) => e.kind === 'covered_by_group_service')?.coverage).toEqual({ covered: 2, of: 3 });
  });
  it('re-running with the same input yields identical keys (idempotent)', () => {
    const input = { worksheetId: 'w1', orderId: 'o1', revision: 0, at: '2026-07-01T00:00:00Z', primaryItemId: 'i1', summary: 'x' };
    const a = projectWorksheetApproved(input);
    const b = projectWorksheetApproved(input);
    expect(dedupeByKey([...a, ...b]).length).toBe(a.length);
  });
});
```

- [ ] **Step 4: Run — fails.** → FAIL.

- [ ] **Step 5: Implement `lib/domain/history-projector.ts`** (pure) + `lib/domain/stores/history.ts` (`upsertHistoryEvents` uses `onConflictDoNothing` on `(tenant_id, key)`; `getHistoryForItem` scoped by tenant). Deterministic key = `${worksheetId}:${kind}:${revision}` for the primary, `${worksheetId}:covered:${revision}:${descendantId}` for group projections. Covered descendants come from `resolveCoveredIds(groupCoverage.coverage, groupCoverage.memberIds)`.

- [ ] **Step 6: Run — passes.** → PASS. Add a store-level idempotency test (`upsertHistoryEvents` twice → one row) using the Task-1 test-DB bootstrap.

- [ ] **Step 7: Commit** — `git commit -m "feat(domain): HistoryEvent projector (deterministic, idempotent) + store"`

---

### Task 8: Seed the domain (full tree + orders/worksheets in every status)

**Files:**
- Create: `lib/seed/scenarios/domain.ts`
- Modify: `lib/seed/scenarios/baseline.ts` (call `seedDomain`), `lib/seed/index.ts` (re-export if needed)
- Test: `tests/unit/seed/domain-seed.test.ts`

**Interfaces:**
- Consumes: all stores (Tasks 1, 4, 7); `PERSONAS`/`TENANTS` from the existing seed; `deriveOrderStatus` (Task 6).
- Produces: `seedDomain(db, ctx: { tenantId: string; erpCompanyId: string; technicianUserId: string }): Promise<void>`.

- [ ] **Step 1: Read `lib/seed/scenarios/baseline.ts`** in full — note the fixed `faker.seed(42)`, fixed `SEED_TIMESTAMP`, the hardcoded `TENANTS` UUIDs, and the comment (lines 5-8) that defers domain data. `seedDomain` extends the same deterministic style (no `Date.now()`, no random UUIDs — derive stable ids or use `faker` after the fixed seed).

- [ ] **Step 2: Write the failing test** — `tests/unit/seed/domain-seed.test.ts`: after `seedBaseline(db)` (which now calls `seedDomain`), assert the seeded data includes (per `15-testing-strategy.md §5.1`): a `system`→`unit`/`lot` tree (≥1 of each kind), a service order in each of `New`, `Planned`, `In progress`, `Work done`, `Confirmed`, `Invoiced`, `Cancelled`, at least one **signed** worksheet (`signed_on_site = true`, `signature_locked_at` set), one **Rejected** worksheet, and one **crew job** (two worksheets sharing a `crew_group_id`). Assert re-running `seedBaseline` on a fresh DB produces identical ids (determinism).

- [ ] **Step 3: Run — fails.** → FAIL.

- [ ] **Step 4: Implement `lib/seed/scenarios/domain.ts`** — build the tree via `insertServiceItem`, then orders/worksheets via the Task-4 stores, using `setErpOwnedState`-style direct writes for the `Invoiced` order (this slice's only path to an ERP-owned state — a small exported test/seed helper `setErpOwnedState(db, orderId, 'Invoiced')` added to `lib/domain/stores/service-orders.ts`, documented as seed/test-only). Wire `seedDomain` into `seedBaseline` after the tenant/erpCompany rows exist, once per seeded erpCompany.

- [ ] **Step 5: Run — passes.** → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(seed): full service-item tree + orders/worksheets in every status"`

---

### Task 9: Coverage-gate config + domain-core verification pass

**Files:**
- Modify: `vitest.config.ts`
- Test: whole `tests/unit/domain/**` + `tests/unit/seed/**`

- [ ] **Step 1: Add `lib/domain/**` to the 90% coverage override** in `vitest.config.ts` (the block currently listing `lib/erp/**`, `packages/erp-core/**`, `lib/sync/**` — `15:9` requires state machines/mappers/projector at the 90% floor). Copy the existing override entry's shape.

- [ ] **Step 2: Run the domain suite with coverage** — `pnpm vitest run tests/unit/domain tests/unit/seed --coverage` → all PASS, and `lib/domain/**` reports ≥90% line + branch. If any module is under, add the missing-case test (the status machines and projector are the likely gaps — add the untested illegal-transition / empty-coverage cases).

- [ ] **Step 3: Full typecheck + suite** — `pnpm tsc --noEmit` → clean; `pnpm test` → green (the pre-existing suites unaffected; note any pre-existing failures explicitly and confirm they exist on `phase0/foundations` before this branch).

- [ ] **Step 4: Commit** — `git commit -m "test(domain): 90% coverage gate for lib/domain; verification pass"`

---

## Self-Review

**Spec coverage** (docs → tasks):
- `02` service-item entity + tree → Task 1; `11` tree kinds/coverage/labelId → Tasks 1, 3. ✓
- `02` charge type (set 31, ItemType map, suggestion, inbound-0 review) / `04` enum → Task 2. ✓
- `11` group coverage (all/n-of-m/list/all-except + fraction) → Task 3. ✓
- `02` ServiceOrder(+Row) / Worksheet(+Row/TimeEntry/DistanceEntry) entities, one-per-(order×tech), erpRef-as-set → Task 4. ✓
- `02` worksheet status flow + Rejected + signature-revision fields → Tasks 4 (fields) + 5 (transitions). ✓
- `02` order status machine (derived/manual/ERP-owned/rollback/cancellation cascade) → Task 6. ✓
- `02` HistoryEvent projector (deterministic keys, group down-projection/rollup, idempotent) → Task 7. ✓
- `15` seed pack (every status, signed/rejected/crew) → Task 8; `15` 90% core-logic coverage → Task 9. ✓

**Deferred, with a task in the "Next slice" note (NOT a gap):** `/api/ext/v1` shell + read endpoints; ERP inbound (WS3) + push saga (WS4); the customer-visible 9→6 status mapping (that projection belongs to the `/api/ext` read layer, next slice); dispatch/stock/documents/field-UX (WS9-12). These are out of this slice's scope by the plan's Scope section, aligned with `06-roadmap.md`'s own sequencing.

**Placeholder scan:** the two DB-touching test files reuse "the Task-1 test-DB bootstrap" rather than repeating the `createTestDatabase` boilerplate in every snippet — Task 1 Step 6 says to copy it verbatim from an existing store test; this is a deliberate DRY reference to real repo code, not a placeholder. All pure-logic modules (charge-type, coverage, both status machines, projector) have complete code. The migration SQL for the two largest tables (Task 4 Steps 1-2) is described column-by-column rather than reproduced as a full block to keep the plan readable — the column lists are exhaustive and the `service_items`/`erp_refs` full-SQL blocks (Tasks 1, 4-Step-3) show the exact style to follow.

**Type consistency:** `OrderStatus`/`WorksheetStatus`/`ChargeType`/`ErpRefPurpose`/`NodeKind`/`HistoryEvent` are all defined once in Task 1's `lib/domain/types.ts` and consumed unchanged in Tasks 2, 4, 5, 6, 7. `Coverage` is defined in Task 3 and consumed in Task 7. Store function names in Task 4's Produces block match their callers in Tasks 6/8.

**Execution-time checks to confirm (grounded in the digest, verify against the repo):**
1. The exact `createTestDatabase` + `runMigrations` + drizzle-connect boilerplate an existing store test uses (Task 1 Step 6) — reproduce it, don't guess.
2. The precise `CREATE TRIGGER ... bump_change_seq()` syntax from `0002` (Tasks 1, 4) — copy verbatim per table.
3. The repo's typecheck command (`pnpm tsc --noEmit` vs a `package.json` script) and test invocation (`pnpm vitest` vs `pnpm test`).
4. `gen_random_uuid()` availability (pgcrypto) — the existing tables use `defaultRandom()`, so it's already enabled; confirm.

---

## Next slice (immediately after this one — not built here)

Once the domain core exists, the highest-value follow-on is the **`/api/ext/v1` read API** that lights up the herbe.portal enrichment already built and shipped:

- **API shell (WS14):** per-company hashed scoped bearer tokens + admin minting + rate limiting (429 + `Retry-After`) — copy-first from herbe-calendar's `apiTokens`/`rateLimit` patterns (none exist in this repo yet).
- **Read endpoints** producing the portal's frozen v1.2 shapes (portal `lib/service/dto.ts`): `GET /service-items`, `/service-items/{id}`, `/service-items/{id}/history`, `/orders`, `/orders/{id}` — reading the entities this slice builds, applying the 9→6 customer-visible status projection (`08:71`). This *pulls forward* the read API ahead of `08:58`'s "future" marking, which is explicitly supported by the "seeded staging serves the portal's tests" note (`08` §4 / `15` §5.5) now that the portal's module shape has settled.
- **Deferred to Phase 2** (need `OrderSignoff`/`CustomerFeedback` entities): `POST /orders/{id}/confirm`, `POST /orders/{id}/feedback`, `GET /orders/{id}/report`. The portal's relays/report calls already degrade gracefully (best-effort) until then.
- **Deferred, test-ERP-gated:** the ERP inbound adapter (WS3) and the outbound push-queue saga (WS4).
