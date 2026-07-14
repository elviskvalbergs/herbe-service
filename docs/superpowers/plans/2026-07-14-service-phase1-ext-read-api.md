# herbe.service Phase 1 — `/api/ext/v1` Read API Implementation Plan (Slice 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build herbe.service's `/api/ext/v1` **read** API — the scoped-bearer-token shell (WS14) plus the GET endpoints (`/service-items`, `/service-items/{id}`, `/service-items/{id}/history`, `/orders`, `/orders/{id}`) — producing exactly the frozen shapes the already-shipped herbe.portal service-enrichment client consumes, so the portal enrichment lights up end-to-end against herbe.service.

**Architecture:** New `app/api/ext/v1/*` route handlers, authenticated by a per-company hashed bearer token (new `ext_tokens` table with a `customer_codes[]` scope), rate-limited (token-keyed windowed counter). Each route resolves the token → `(tenantId, erpCompanyId, customerCodes)` scope, reads the domain entities via new customer-scoped + `changeSeq`-cursor-paginated store functions, and maps them to the portal DTO shapes with a pure mapper layer. The internal 9-state order status is projected to the customer-visible 6-state vocabulary. Writes (`POST /requests`, `/confirm`, `/feedback`) and the report PDFs are **out of scope** (Phase-2 entities / later slice).

**Tech Stack:** Next.js 16 App Router, drizzle-orm/Postgres, vitest (now runnable against local Postgres), zod, pnpm workspace, TypeScript. No new runtime deps (token hashing via `node:crypto`).

**Spec:** herbe.service `docs/08-suite-integration.md` §4/§4a (token scoping "one hashed bearer token per company connection", `customerCodes` "narrow never widen", rate limit 429+`Retry-After`, the 9→6 status map at line 71), `docs/05-users-auth.md` (API tokens are an Admin capability), `docs/02`/`docs/11` (the domain the reads project). **The response shapes are frozen by the portal contract** — the canonical source is `herbe-portal` `lib/service/dto.ts` (`ServiceItemSummary`/`Detail`, `HistoryEvent`, `OrderSummary`/`Detail`, `WorksheetSummary`) and the endpoint/query list in `lib/service/client.ts`. Grounding research digest: `hs-apiext-digest.md` (2026-07-14).

## Scope

**In scope (this slice):** the token shell + rate limit + the 5 GET read endpoints + the domain additions they require (a `customer_id` link on `service_items`, customer-scoped paginated store reads, the 9→6 status projection, the DTO mappers) + a minimal admin token-mint path.

**Explicitly out of scope (defer):**
- `POST /requests` (creates an order — a write; not scheduled in any herbe.service doc), `POST /orders/{id}/confirm`, `POST /orders/{id}/feedback` (write Phase-2 `OrderSignoff`/`CustomerFeedback` entities), `GET /orders/{id}/report` + `GET /worksheets/{id}/report.pdf` (need the document engine). The portal's client already treats all of these as best-effort and degrades gracefully.
- A full `sites` table (the spec's `Customer→Site→ServiceItem` model). This slice adds `service_items.customer_id` only; `siteName` stays free-text; a `sites` table is a later slice.
- Booking/ETA, contract linkage, meters, item documents, worksheet PDF flag, `leadName`/`crewSize`, `timeTotalMinutes` — all `.optional()` in the portal DTO (or a documented `[]`); omitted here, see the mapper task.

## Global Constraints

- **Base branch: `feature/service-phase1-core`** (the domain-core slice, now merged onto current `preview` — it carries the domain entities this slice reads). Cut this slice's branch from it (or continue on it if the domain-core PR #3 hasn't merged). If PR #3 has merged to `preview`, cut from `preview` instead. Confirm at execution time.
- **Frozen response shapes:** every endpoint's JSON must validate against the portal's `lib/service/dto.ts` zod schemas — same field names, same required/optional split. A contract test (Task 10) asserts this against copies of those schemas. `timeline` and `OrderDetail.invoices` are **required arrays** in the DTO with no domain source yet → return `[]` (legal, parses).
- **Token model** (`08:86`): one hashed bearer token per `(erp_company_id)`; the token carries a `customer_codes text[]` scope (empty/null = all customers of that company). A request's `customerCodes` param **narrows, never widens** the token's scope: intersect the request codes with the token's codes; if the token has a restricted list and the request asks for codes outside it, silently drop the out-of-scope codes (narrow) rather than 400. Point lookups (`/{id}`) must verify the row's owning customer is within the resolved scope, else 404 (not 403 — don't confirm existence).
- **Auth failures**: 401 `{error, code}` for a missing/invalid/revoked token; 403 for wrong-scope where appropriate; 429 `{error}` + `Retry-After` header on rate-limit breach. Shapes must match what the portal client maps (`herbe-portal lib/service/client.ts`: 401/403→`auth`, 429→`rate_limited` reading `Retry-After`, 5xx→`server`).
- **Tenant/company scope comes only from the token**, never from request input (mirrors the session-IDOR rule in `app/api/sync/customers/route.ts:15-19`).
- **Migrations:** hand-authored `scripts/migrations/NNNN_*.sql`, applied by `scripts/migrate.mjs` in filename order, tracked in `herbe_migrations.applied`; idempotency by tolerated error codes; NO `_journal.json`. Next number is `0014` (last is `0013_history_events.sql`; verify with `ls scripts/migrations/*.sql | sort | tail -1`).
- **New domain columns** follow the established template (bump-trigger-driven `change_seq` where the row is delta-fed; `service_items` already has `change_seq`, so `customer_id` just joins the existing row).
- **TDD:** pure logic (status projection, token hash/verify logic, DTO mappers) gets full local RED→GREEN; DB-backed store + route tests now run locally against Postgres — set `TEST_DATABASE_URL=postgres://<user>@localhost:5432/postgres` with a running `postgresql@14`/`@17`. Core-logic modules (`lib/domain/**`, the mappers, the token verifier) stay ≥90% (the `lib/domain/**` 90% override exists; add `lib/api/ext/**` + `lib/security/tokens.ts` to it).
- **Commits:** one per task min; trailer:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TarGC3f9guUBQLodgCTiaD
  ```

## File Structure

**New:**
- `scripts/migrations/0014_service_item_customer_and_ext_tokens.sql` — `service_items.customer_id` + the `ext_tokens` table.
- `drizzle/schema.ts` (modify) — `service_items.customerId`; `extTokens` table + row type.
- `lib/domain/stores/service-items.ts` / `service-orders.ts` (modify) — `insertServiceItem` gains `customerId`; add `scanServiceItemsForCustomer` / `scanServiceOrdersForCustomer` (customer-scoped, `changeSeq`-cursor, `limit`).
- `lib/domain/customer-order-status.ts` (+ test) — `toCustomerOrderStatus(internal: OrderStatus): CustomerOrderStatus` (9→6).
- `lib/security/tokens.ts` (+ test) — `generateToken()`, `hashToken()`, `constantTimeEqual()`.
- `lib/api/ext/tokens-store.ts` — `mintExtToken`, `findExtTokenByHash`, `touchExtToken`, `revokeExtToken`.
- `lib/api/ext/auth.ts` (+ test) — `verifyExtRequest(req)` → `{ ok, tenantId, erpCompanyId, tokenId, resolveScopeCodes(requested?: string[]) } | { ok:false, status, code }`.
- `lib/api/ext/rate-limit.ts` (+ test) — token-keyed windowed limiter → `{ allowed, retryAfterSec? }`.
- `lib/api/ext/mappers.ts` (+ test) — pure domain-row → portal-DTO mappers.
- `lib/api/ext/dto.ts` — zod schemas mirroring the portal's `lib/service/dto.ts` (server-side response validation + the contract test).
- `app/api/ext/v1/service-items/route.ts`, `service-items/[id]/route.ts`, `service-items/[id]/history/route.ts`, `orders/route.ts`, `orders/[id]/route.ts`.
- `lib/seed/scenarios/domain.ts` (modify) — set `customerId` on seeded service items; seed one `ext_tokens` row.
- Tests under `tests/unit/domain/**`, `tests/unit/security/**`, `tests/unit/api/ext/**`.

**Modify:** `vitest.config.ts` (extend the 90% override to `lib/api/ext/**`, `lib/security/tokens.ts`).

---

### Task 1: `service_items.customer_id` + `ext_tokens` schema

**Files:** Create `scripts/migrations/0014_service_item_customer_and_ext_tokens.sql`; modify `drizzle/schema.ts`, `lib/domain/stores/service-items.ts`, `lib/seed/scenarios/domain.ts`.

**Interfaces:** Produces `service_items.customer_id uuid NULL REFERENCES customers(id)`; `extTokens` table (`id`, `tenant_id`, `erp_company_id`, `name`, `token_hash` unique, `customer_codes text[]`, `created_at`, `last_used_at`, `revoked_at`) + `ExtTokenRow`; `insertServiceItem` accepts optional `customerId`.

- [ ] **Step 1: Verify next migration number** — `ls scripts/migrations/*.sql | sort | tail -1` → expect `0013`; use `0014`.
- [ ] **Step 2: Write the migration.** `ALTER TABLE "service_items" ADD COLUMN IF NOT EXISTS "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL;` + `CREATE INDEX IF NOT EXISTS "service_items_customer_idx" ON "service_items" ("customer_id");`. Then:
```sql
CREATE TABLE IF NOT EXISTS "ext_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid NOT NULL REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "customer_codes" text[] NOT NULL DEFAULT '{}'::text[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "ext_tokens_hash_uniq" ON "ext_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "ext_tokens_company_idx" ON "ext_tokens" ("erp_company_id");
```
- [ ] **Step 3: Drizzle** — add `customerId: uuid('customer_id').references(() => customers.id)` to `serviceItems`; add the `extTokens` pgTable + `export type ExtTokenRow = InferSelectModel<typeof extTokens>;`.
- [ ] **Step 4: Store + seed** — `insertServiceItem` input gains optional `customerId` (threaded into the insert). In `lib/seed/scenarios/domain.ts`, set `customerId` on the seeded units/lots (to the seeded customer) so `/service-items?customerCodes=` returns them.
- [ ] **Step 5: Verify** — `pnpm exec tsc --noEmit` clean; with `TEST_DATABASE_URL` set + Postgres running, `pnpm exec vitest run tests/unit/domain/service-items-store.test.ts tests/unit/seed` → PASS (extend the store test to insert with `customerId` and read it back).
- [ ] **Step 6: Commit** — `feat(ext): service_items.customer_id + ext_tokens schema`.

---

### Task 2: Customer-scoped, paginated store reads

**Files:** modify `lib/domain/stores/service-items.ts`, `service-orders.ts`; add a shared customer-code→id resolver.

**Interfaces:** Produces `resolveCustomerIdsByCodes(db, tenantId, erpCompanyId, codes: string[]): Promise<string[]>` (join `customers` WHERE `erpRef IN codes`); `scanServiceItemsForCustomer(db, { tenantId, customerIds, after?: bigint, limit: number }): Promise<ServiceItemRow[]>`; `scanServiceOrdersForCustomer(db, { tenantId, customerIds, after?, limit, status? }): Promise<ServiceOrderRow[]>`. Both order by `changeSeq` asc, filter `deletedAt IS NULL` + `changeSeq > after`, cap at `limit`.

- [ ] **Step 1-4: TDD (DB-backed).** Test (`tests/unit/domain/customer-scoped-reads.test.ts`): seed 2 customers' items/orders; assert each customer-scoped scan returns only its own rows; assert `after`-cursor paginates (returns rows with `changeSeq > cursor`); assert `limit` caps. Mirror the `gt(changeSeq, after)` idiom from `app/api/sync/customers/route.ts:35-39`. Implement, verify against live Postgres.
- [ ] **Step 5: Commit** — `feat(ext): customer-scoped changeSeq-paginated service-item/order reads`.

---

### Task 3: 9→6 customer-order-status projection (pure)

**Files:** create `lib/domain/customer-order-status.ts` + `tests/unit/domain/customer-order-status.test.ts`.

**Interfaces:** Produces `type CustomerOrderStatus = 'received'|'scheduled'|'in_progress'|'work_done'|'completed'|'cancelled'`; `toCustomerOrderStatus(s: OrderStatus): CustomerOrderStatus`.

- [ ] **Step 1: Failing test** — assert the exact map (`docs/08:71`): `New`→received, `Accepted`→received, `Planned`→scheduled, `In progress`→in_progress, `Work done`→work_done, `Confirmed`→work_done, `Invoiced`→completed, `Closed`→completed, `Cancelled`→cancelled. Assert every `OrderStatus` member maps (exhaustive).
- [ ] **Step 2-4:** RED → implement as a `Record<OrderStatus, CustomerOrderStatus>` (TS enforces exhaustiveness) → GREEN.
- [ ] **Step 5: Commit** — `feat(ext): customer-visible 9→6 order-status projection`.

---

### Task 4: Token hashing + ext-token store

**Files:** create `lib/security/tokens.ts` (+ test), `lib/api/ext/tokens-store.ts`.

**Interfaces:** Produces `generateToken(): string` (32 random bytes base64url), `hashToken(raw: string): string` (sha256 hex), `constantTimeEqual(a,b): boolean`; store `mintExtToken(db, {tenantId, erpCompanyId, name, customerCodes})→{id, raw}` (persists only the hash, returns raw once), `findExtTokenByHash(db, hash)→ExtTokenRow|null`, `touchExtToken(db, id)` (bump `last_used_at`, fire-and-forget), `revokeExtToken(db, id)`.

- [ ] **Step 1-4:** Pure TDD for `tokens.ts` (round-trip: `hashToken(generateToken())` is 64 hex chars; `constantTimeEqual` true/false; two generated tokens differ). Implement `tokens.ts` with `node:crypto` (`randomBytes`, `createHash`, `timingSafeEqual`). Implement the store (DB-backed; a store test that mints + finds-by-hash + revoke round-trips against live Postgres).
- [ ] **Step 5: Commit** — `feat(ext): scoped bearer token hashing + ext_tokens store`.

---

### Task 5: Ext request auth + scope resolution

**Files:** create `lib/api/ext/auth.ts` + `tests/unit/api/ext/auth.test.ts`.

**Interfaces:** Produces `verifyExtRequest(db, req): Promise<VerifiedExt | ExtAuthError>` where `VerifiedExt = { ok:true; tenantId; erpCompanyId; tokenId; tokenCustomerCodes: string[]; resolveScopeCodes(requested?: string[]): string[] }` and `ExtAuthError = { ok:false; status:401|403; code:'no_token'|'invalid_token'|'revoked' }`. `resolveScopeCodes`: if `tokenCustomerCodes` empty → return `requested ?? []` (all); else return `requested ? requested.filter(c => tokenCustomerCodes.includes(c)) : tokenCustomerCodes` (narrow, never widen).

- [ ] **Step 1: Failing test** — mock `findExtTokenByHash`. Assert: missing `Authorization: Bearer` → `{ok:false, 401, no_token}`; unknown hash → `{ok:false, 401, invalid_token}`; revoked (`revokedAt` set) → `{ok:false, 401, revoked}`; valid → `{ok:true, ...}` and `resolveScopeCodes(['A','B'])` intersects with the token's codes (widen attempt drops out-of-scope); empty-token-scope returns the requested as-is.
- [ ] **Step 2-4:** RED → implement (read `Authorization` header, `hashToken`, `findExtTokenByHash`, checks; `touchExtToken` fire-and-forget on success) → GREEN.
- [ ] **Step 5: Commit** — `feat(ext): bearer verify + narrow-never-widen customerCodes scope`.

---

### Task 6: Token-keyed rate limit

**Files:** create `lib/api/ext/rate-limit.ts` + test (+ a migration if a counter table is used; prefer an in-memory/DB windowed counter consistent with the repo — check whether P0 already has a rate-limit table before adding one).

**Interfaces:** Produces `checkExtRateLimit(db, tokenId, endpoint): Promise<{ allowed:true } | { allowed:false; retryAfterSec:number }>` — windowed counter keyed on `(tokenId, endpoint)`, policy map per endpoint (e.g. `{ maxPerMinute: 120 }`).

- [ ] **Step 1: Decide the backend** — check `scripts/migrations/` + `lib/` for any existing rate-limit/counter table (the digest found none; herbe.service only has cron `bearerMatches`). If none, add `0015_ext_rate_limit.sql` with an `ext_rate_limit` counter table (`token_id`, `endpoint`, `window_start`, `count`) OR use a simpler fixed-window row-insert-and-count. Keep it minimal.
- [ ] **Step 2-5: TDD** the window logic (allowed under the cap; blocked over it with a correct `retryAfterSec`); implement; commit `feat(ext): token-keyed rate limiter (429 + Retry-After)`.

---

### Task 7: DTO mappers (pure)

**Files:** create `lib/api/ext/dto.ts` (zod schemas mirroring portal `lib/service/dto.ts`), `lib/api/ext/mappers.ts` + `tests/unit/api/ext/mappers.test.ts`.

**Interfaces:** Produces `mapServiceItemSummary(row, model?)`, `mapServiceItemDetail(row, model?)`, `mapHistoryEvent(row, orderNumber?)`, `mapOrderSummary(row, {customerStatus, serviceItems})`, `mapOrderDetail(row, {customerStatus, serviceItems, worksheets})`, `mapWorksheetSummary(ws, rows)` — each returns an object that PARSES against the corresponding `lib/api/ext/dto.ts` schema (which mirrors the portal's).

- [ ] **Step 1: Copy the portal DTO schemas** into `lib/api/ext/dto.ts` (transcribe from `herbe-portal lib/service/dto.ts` — same shapes; these are the frozen contract). Server validates its own output against these before responding.
- [ ] **Step 2: Failing test** — feed representative domain rows; assert each mapper's output `.parse()`s under its schema. Assert the mappings the digest flagged: `status` is the projected 6-value (via Task 3); `warranty.status` derived from `warrantyUntil` vs now; `model` from the joined `itemModels`; `OrderDetail.timeline` = `[]` and `OrderDetail.invoices` = `[]` (required-but-no-source); optional-absent fields (booking/contract/meters/documents/feedback/confirmation) omitted; `HistoryEvent.at` falls back to `createdAt` when the `at` column is null.
- [ ] **Step 3-5:** RED → implement pure mappers → GREEN. Commit `feat(ext): domain→portal DTO mappers`.

---

### Task 8: `GET /api/ext/v1/service-items` (+ `{id}`, `{id}/history`)

**Files:** create `app/api/ext/v1/service-items/route.ts`, `service-items/[id]/route.ts`, `service-items/[id]/history/route.ts`.

- [ ] **Step 1: List route** — `verifyExtRequest` → `checkExtRateLimit` → parse `customerCodes`/`labelId`/`after`/`limit` → `resolveScopeCodes` → `resolveCustomerIdsByCodes` → `scanServiceItemsForCustomer` (or, if `labelId` present, resolve the single item by `labelId` and scope-check its customer) → join `itemModels` → `mapServiceItemSummary[]` → `{ data, nextCursor }` (nextCursor = last row's `changeSeq` as string). Mirror the route/pagination shape of `app/api/sync/customers/route.ts`, swapping session for `verifyExtRequest`.
- [ ] **Step 2: Detail + history routes** — `getServiceItemById` + scope-check its `customerId` ∈ resolved scope (else 404); `mapServiceItemDetail`. History: `getHistoryForItem` (after scope-checking the item) → `mapHistoryEvent[]` (bare array, not `{data}`-wrapped).
- [ ] **Step 3: TDD (DB-backed route tests)** — seed via `seedDomain` + an `ext_tokens` row; hit the routes with the token; assert: 200 + shapes parse; wrong/absent token → 401; a `customerCodes` outside the token scope is narrowed (returns only in-scope); an item of another customer via `/{id}` → 404. Run against live Postgres.
- [ ] **Step 4: Commit** — `feat(ext): GET /service-items (+ detail, history)`.

---

### Task 9: `GET /api/ext/v1/orders` (+ `{id}`)

**Files:** create `app/api/ext/v1/orders/route.ts`, `orders/[id]/route.ts`.

- [ ] **Step 1: List route** — verify+ratelimit+scope → `scanServiceOrdersForCustomer` (optional `status` filter: map the incoming customer-status filter back, or filter post-projection) → for each order join its `service_order_rows`→service items for `serviceItems[]`, project status via `toCustomerOrderStatus(deriveOrderStatus(...))` → `mapOrderSummary[]` → `{ data, nextCursor }`.
- [ ] **Step 2: Detail route** — `getServiceOrderById` + scope-check its `customerId`; `getWorksheetsForOrder`→`mapWorksheetSummary[]`; `mapOrderDetail` (with `timeline:[]`, `invoices:[]`).
- [ ] **Step 3: TDD (DB-backed)** — seeded orders across statuses; assert the projected `status` values (e.g. a `Confirmed` internal order → `work_done`), worksheets present on detail, scope enforcement, pagination. Run against live Postgres.
- [ ] **Step 4: Commit** — `feat(ext): GET /orders (+ detail)`.

---

### Task 10: Admin token mint + coverage gate + contract verification

**Files:** modify `vitest.config.ts`; add a minimal token-mint entry point (an admin route `app/api/admin/ext-tokens/route.ts` guarded by the existing `bearerMatches`/`ADMIN_MIGRATIONS_SECRET`-style admin auth, or a `scripts/mint-ext-token.mjs` CLI — pick whichever matches how P0 exposes admin ops); add `tests/unit/api/ext/contract.test.ts`.

- [ ] **Step 1: Minimal mint path** — a way for an admin to create an `ext_tokens` row and get the raw token once (route or script), reusing `mintExtToken`. Keep it minimal — full admin UI is not required by this slice.
- [ ] **Step 2: Coverage gate** — add `lib/api/ext/**` + `lib/security/tokens.ts` to the 90% override in `vitest.config.ts`.
- [ ] **Step 3: Contract test** — a test that imports the response DTO schemas and asserts they are structurally identical (field names + required/optional) to the portal's frozen `lib/service/dto.ts` shapes (copy the portal schemas into the test as the expected reference), so drift is caught. This is the guard that the server keeps producing what the portal consumes.
- [ ] **Step 4: Verification pass** — full `pnpm exec vitest run` against live Postgres → green; `pnpm exec tsc --noEmit` clean; the ext-module coverage ≥90%.
- [ ] **Step 5: Commit** — `feat(ext): admin token mint + contract test + coverage gate`.

---

## Self-Review

**Spec coverage:** token shell (scoped hashed bearer + narrow-never-widen + rate limit) → Tasks 4/5/6; the 5 read endpoints producing frozen portal shapes → Tasks 7/8/9; the 9→6 status projection → Task 3; the `service_items` customer-linkage gap the digest surfaced → Task 1; customer-scoped pagination → Task 2; contract-drift guard → Task 10. Writes/reports/sites/booking explicitly deferred (Scope). ✓

**Placeholder scan:** the route tasks (8/9) reference cloning the `app/api/sync/customers/route.ts` pagination shape rather than reproducing it — deliberate (it's the repo's proven idiom). Net-new pure logic (status projection, token hashing, scope resolution, mappers) has full interfaces + TDD assertions specified. `timeline`/`invoices` `[]` handling is called out explicitly (not a vague "handle it").

**Type consistency:** `CustomerOrderStatus` (Task 3) is consumed by the mappers (Task 7) and order routes (Task 9). `verifyExtRequest`'s `resolveScopeCodes` (Task 5) is used by every route (8/9). `ExtTokenRow` (Task 1) is used by the store (Task 4) + auth (Task 5). Store fn names (`scanServiceItemsForCustomer`/`scanServiceOrdersForCustomer`, `resolveCustomerIdsByCodes`) are consistent across Tasks 2/8/9.

**Execution-time confirmations:** (1) whether PR #3 (domain core) has merged to `preview` — if so base off `preview`, else off `feature/service-phase1-core`; (2) whether a rate-limit counter table already exists in P0 before adding one (Task 6); (3) `TEST_DATABASE_URL` + a running Postgres for the DB-backed tests (now available locally via `postgresql@14`/`@17` on 5432); (4) how P0 exposes admin operations, to pick the mint entry point (Task 10).

## Next (after this slice)
The ERP inbound adapter (WS3) + outbound push-queue saga (WS4) — both gated on the owner-arranged dedicated test ERP — then the `POST` write endpoints (`/requests`, `/confirm`, `/feedback`) once their Phase-2 entities (`OrderSignoff`, `CustomerFeedback`) exist. The remaining Phase-1 product workstreams (dispatch board, van stock/scanning, documents/DOCX, field-execution UX) are separate large slices.
