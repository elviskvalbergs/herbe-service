# herbe.service Phase 1 — ERP connection foundation + live contract test

**Slice goal:** prove the *production inbound pipe* against the dedicated test ERP. Build the missing
credentials→adapter plumbing (nothing in the repo turns a stored `erp_companies` row into a live
`ErpAdapter` today) and a gated live contract test that pulls a real register through that path.
This is the WS3 prerequisite — register mappers/ingests (SVOSerVc/SVOVc/WSVc) follow in later slices,
once the pipe is proven.

Branch: `feature/service-phase1-erp-connection` (cut from current `feature/service-phase1-ext-read` @ 0e9a2a0).
Worktree: `/Users/elviskvalbergs/AI/herbe-service/.claude/worktrees/phase1-plan`.

## Context (verified via digest `hs-ws3-digest.md`)
- `packages/erp-core`: `ErpAdapter` interface + `getAdapter(type, config)` registry. `standard_books` adapter
  registered in `lib/erp/standard-books/adapter.ts`; config schema `{ baseUrl, companyNumber, auth:{kind:'basic',username,password} }`.
- **Gap (§4/#5):** no `lib/security/envelope.ts`, no `lib/erp/credentials.ts`, no factory reads
  `erp_companies.apiCredsEncrypted`/`adapterConfigJson` → adapter. Every test instantiates the adapter from a
  literal config. So the ERP can't be reached from a stored connection at all.
- Portal has both modules to mirror (read-only reference):
  - `/Users/elviskvalbergs/AI/herbe-portal/lib/security/envelope.ts` (the crypto primitive: `encrypt`/`decrypt`, `ALGO_VERSION`).
  - `/Users/elviskvalbergs/AI/herbe-portal/lib/erp/credentials.ts` (packing `keyId(16)||nonce(12)||ciphertext`, `ErpCredentialsError` codes `missing|corrupt|stale_format`).
  - `/Users/elviskvalbergs/AI/herbe-portal/app/api/admin/erp-companies/route.ts` (the *encrypt* side — how the blob is written).
- Schema: `erp_companies` has `adapterType`, `adapterConfigJson jsonb`, `apiCredsEncrypted text`, `secretVersion integer` (`drizzle/schema.ts:13-23`).
- Coverage gate: `vitest.config.ts` holds `lib/erp/**`, `packages/erp-core/**`, `lib/sync/**` to 90%.
- Live-ERP env: **no committed contract exists.** This slice establishes it (names below).

## Env-var contract (this slice defines it)
Live test reads, all from the worktree-local `.env.vars` (git-ignored; user drops it in):
- `RUN_LIVE_ERP_TESTS=1` — gate. Absent → the live suite is skipped, never fails CI.
- `ERP_BASE_URL`, `ERP_COMPANY_NUMBER`, `ERP_USER`, `ERP_PASSWORD` — the dedicated ERP connection.
- `ERP_CREDS_KEY` (or whatever the ported envelope module names its key env var — Task 1 confirms from portal;
  keep the portal's name so both apps share the convention). For the live test a throwaway key is fine.

**Security:** creds/values never printed, committed, or put in a subagent prompt. `.env.vars` stays on-machine,
git-ignored, loaded only at test runtime. The test asserts *shape*, never echoes payloads.

---

## Task 1 — Envelope + ERP credentials + `buildAdapterForConnection` (offline)

**Port (mirror portal, adapt imports to service layout):**
1. `lib/security/envelope.ts` — port from portal. Confirm the key env-var name the portal uses and keep it.
2. `lib/erp/credentials.ts` — port `decryptErpCredentials(blob)` + `ErpCredentialsError`. Add `encryptErpCredentials(obj)`
   producing the same `keyId||nonce||ciphertext` packing (read the portal admin route for the write side).
3. `lib/erp/connection.ts` — new: `buildAdapterForConnection(db, erpCompanyId): Promise<ErpAdapter>`:
   - load the `erp_companies` row (throw plain `Error` if unknown — programming guard);
   - `decryptErpCredentials(row.apiCredsEncrypted)` → `{ username, password }` (or full creds object);
   - merge `adapterConfigJson` (baseUrl, companyNumber) + decrypted auth into the `standardBooksConfigSchema` shape;
   - `getAdapter(row.adapterType, config)` and return it.

**Tests (all offline, no real ERP):**
- `lib/security/envelope.test.ts` — encrypt→decrypt round-trip; tamper → throws.
- `lib/erp/credentials.test.ts` — encrypt→decrypt round-trip; `null` blob → `missing`; too-short → `corrupt`;
  bad keyId → `stale_format`.
- `lib/erp/connection.test.ts` (DB-backed, `createTestDatabase()`): seed a tenant + `erp_companies` row whose
  `apiCredsEncrypted = encryptErpCredentials({username,password})` and `adapterConfigJson = {baseUrl, companyNumber}`;
  assert `buildAdapterForConnection` returns an adapter whose `capabilities()` matches `standard_books`; unknown id → throws.

**Verify:** `pnpm exec tsc --noEmit` clean; the three test files pass vs live PG14; coverage on the new `lib/erp/**`/`lib/security/**` files ≥ 90%.

**Commit:** `feat(erp): connection credentials envelope + buildAdapterForConnection factory`.

---

## Task 2 — Gated live-ERP contract test + env contract doc (needs `.env.vars`)

- `tests/live/erp-contract.test.ts`, `describe.skipIf(!process.env.RUN_LIVE_ERP_TESTS)`:
  - load `.env.vars` (worktree root) via `dotenv` in the test/setup;
  - `createTestDatabase()`; seed a tenant + `erp_companies` row with `apiCredsEncrypted = encryptErpCredentials({username:ERP_USER,password:ERP_PASSWORD})`, `adapterConfigJson = {baseUrl:ERP_BASE_URL, companyNumber:ERP_COMPANY_NUMBER}`;
  - `buildAdapterForConnection` → adapter (**exercises the full production path against the real ERP**);
  - assert: `pullChanges('CUVc', '0')` → `{ upserts: [...], cursor }` non-empty shape; `pullChanges('DelAddrVc','0')` succeeds (delta-capable base register);
    `probeIncrementalSupport('SVOVc')` and `('WSVc')` → `false` (confirms no-delta live, matching the fake-ERP model);
    `capabilities()` returns the expected flags.
  - Assert shapes/counts only — never log row contents.
- `vitest.config.ts`: exclude `tests/live/**` from the default run (separate project or `exclude`) so `pnpm test`
  never touches the network and the coverage gate ignores it. A `pnpm test:live` script runs it explicitly.
- `.env.test.example` at repo root documenting the five env vars (names only, empty values) + a one-paragraph note in
  `docs/15-testing-strategy.md` under the nightly live-contract section pointing at `pnpm test:live`.

**Verify (offline):** default `pnpm test` still green and does NOT run the live suite; `tsc` clean.
**Verify (live, when `.env.vars` present):** `RUN_LIVE_ERP_TESTS=1 pnpm test:live` → green against the dedicated ERP.

**Commit:** `test(erp): gated live-ERP contract test + env contract`.

---

## Out of scope (later WS3 slices)
Register mappers/ingests (SVOSerVc→service_items, SVOVc→service_orders windowed-scan+key-sweep, WSVc→worksheets),
fake-ERP fixtures for them, key-sweep `Register` union widening, charge-type label→enum table, sync-runner wiring.
All ERP **writes** (WS4) remain out of scope entirely.
