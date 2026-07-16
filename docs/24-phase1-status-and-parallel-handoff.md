# 24 — Phase 1 status & parallel-session handoff

Last updated: **2026-07-16** (preview @ PR #9 sync-runner + PR #10 phase-2-recurrence; this update adds WS2 core + password/TOTP for admin via `feature/service-phase1-ws2-roles-identity`, PR into preview pending).
Purpose: let a fresh Claude/dev session pick up any remaining workstream without re-deriving state.
Workstream numbering follows `docs/21-phase-1-implementation-plan.md` §4.

## 1. Status by workstream

| WS | Scope | Status |
|---|---|---|
| WS1 | Platform foundations & app shell | **Done** (Phase 0: migrations runner, tenancy, changeSeq triggers, PWA shell, proxy.ts) |
| WS3 | **ERP adapter, inbound** | **Done, proven live** — see §2 |
| WS7 | Master data & service-item tree | **Done** (domain core: types, stores, charge-type, coverage; SVOSerVc tree via MotherNr) |
| WS8 | Orders/worksheets/status machine (domain) | **Done** (order+worksheet stores, `deriveOrderStatus`, worksheet transitions, 9→6 customer projection) |
| WS13 | HistoryEvent projector | **Done** (`lib/domain/history-projector.ts` + history store + /history endpoint) |
| WS14 | API shell (read) | **Done** — `/api/ext/v1` read API (service-items, orders, history; token auth + scope + rate limit) matches the frozen portal contract (`herbe-portal/lib/service/dto.ts`). Writes (POST /requests, /confirm, /feedback) NOT built (need Phase-2 entities / WS4) |
| WS2 | Auth roles, WebAuthn, seat licensing | **Core + password/TOTP done** — roles/capabilities, session_version revocation, device registry, ERP identity link by email, admin password+TOTP login — see §5. WebAuthn, Baltic eID, Entra ID OIDC, seat/license enforcement **deferred, unclaimed** — see §4 |
| WS4 | ERP outbound (push-queue saga, approve→invoice) | **Not started** (only the Phase-0 `pushCreate('SVOVc')` spike + outbox table exist) |
| WS5 | Bookings ↔ ActVc | **Not started** |
| WS6 | Connection config UI & sync health | **Not started** (backend state exists: `erp_sync_state` per register; no UI) |
| WS9 | Field execution UX (technician PWA) | **Not started** (offline sync-client + virtual-device simulation exist from Phase 0) |
| WS10 | Dispatch & scheduling | **Not started** |
| WS11 | Van stock, scanning, QR labels | **Not started** (`labelId` placeholder convention: `erp:<companyId>:<serial>` — see §3) |
| WS12 | Documents (report PDF/DOCX) | **Not started** |
| Phase 2 | Recurrence/SVCVc overlay | **In progress in a SEPARATE session** (docs 22/23, PR #10) — do not double-assign |

## 2. WS3 inbound — what exists and is live-proven

One `syncConnection(db, adapter, erpCompanyId)` run against the dedicated demo ERP syncs:
CUVc→customers (190), DelAddrVc→site-name map (4), SVOSerVc→service_items (55→53, dup serials collapse),
SVOVc→service_orders+service_order_rows (43+43, charge types parsed, DoneMark→Closed),
WSVc→worksheets+worksheet_rows (3+2, flags→status). All idempotent; re-runs never duplicate.

Key modules (all under the preview tip):
- `lib/security/envelope.ts` + `lib/erp/credentials.ts` — AES-256-GCM creds (`MASTER_ENCRYPTION_KEY`), portal-compatible packing; `apiCredsEncrypted` column is **text/base64** here (portal's is bytea).
- `lib/erp/connection.ts` — `buildAdapterForConnection(db, erpCompanyId)`: stored row → decrypted creds → adapter. The ONLY production path to a live adapter.
- `lib/erp/standard-books/adapter.ts` — `pullChanges` (delta), `pullFullList` (no-delta), `listLiveRefs` (`REF_FIELD` map), `probeIncrementalSupport`, `pushCreate` (SVOVc spike only).
- `lib/sync/ingest/{customers,service-items,service-orders,worksheets}.ts` + `key-sweep.ts` (Register union: CUVc|INVc|SVOSerVc, exhaustive table map).
- `lib/domain/stores/erp-refs.ts` — `putErpRef` + `findEntityIdByErpRef` (reverse lookup; migration 0016 index). Orders/worksheets have NO scalar erpRef — always match via erp_refs (purpose `primary`, register SVOVc/WSVc).
- `lib/sync/sync-connection.ts` — the orchestrator (register order = FK dependency order; per-register error isolation; `erp_sync_state` cursors: delta registers persist syncCursor, full pulls stamp lastFullSyncAt).
- `app/api/cron/sync-tick/route.ts` — cron drives it: CRON_SECRET + cron-lock + fan-out over active `erp_companies`.

ERP facts (verified live; also in memory + `docs/17/19`):
- Send `Accept: application/json` or you get XML. Rows nest under `data.<Register>` (`{data:{CUVc:[...]}, '@sequence':N}`).
- Delta (`updates_after`) works ONLY for base registers (CUVc, DelAddrVc). SVOSerVc/SVOVc/WSVc → 404: full pull + key-sweep.
- SVOSerVc identity = `SerialNr` (no SerNr). SVOVc has no OKFlag; terminal = `DoneMark`. `InvFlag/InvMark` are NOT invoiced signals (never derive Invoiced from them — needs IVVc link, deferred).
- Line `ItemType` returns localized label strings ("Invoiceable"/"Warranty"/"Goodwill") → `parseItemTypeLabel` (`lib/domain/charge-type.ts`); unmapped → invoiceable + needsReview.
- Unset numerics come back as `''` — coerce via `booksNumeric` (worksheets.ts), never bind `''` to a numeric column.

## 3. Conventions a new session must follow

- **TDD + subagent-per-task**; plans live in `docs/superpowers/plans/*.md` (one per slice — read the relevant one before extending its area).
- Tests: `TEST_DATABASE_URL=postgres://<user>@localhost:5432/postgres` (Postgres 14 via Homebrew), `pnpm exec vitest run`; coverage gate 90% on `lib/erp/**`, `lib/sync/**`, `packages/erp-core/**`. `pnpm exec tsc --noEmit` must stay clean.
- **Live contract suite**: `tests/live/erp-contract.test.ts`, gated on `RUN_LIVE_ERP_TESTS`, run via `pnpm test:live`. Needs a worktree-local `.env.vars` (git-ignored) with `ERP_DEMO_BASE_URL/COMPANY/USER/PASSWORD` + `RUN_LIVE_ERP_TESTS=1` (names in `.env.test.example`; values in the repo root `.env.local`). **Any new ERP-touching feature must extend this suite** — it has caught 3 real bugs unit tests missed (XML, envelope shape, `''` numerics). Log counts only, never row values.
- Migrations: `scripts/migrations/NNNN_*.sql` (next free number; idempotent; filename-sorted; NO _journal.json in this repo).
- Deferred-not-broken pattern: unresolvable FK → null + pick up next run (modelId, technicianUserId, siteName) — or skip+count when the column is NOT NULL (order customerId, worksheet orderId).
- `labelId` on ERP-ingested service_items: `erp:<erpCompanyId>:<serialNr>`, insert-only, pending the real QR-label design (WS11 owns replacing this).
- Admin/ops secrets: `ADMIN_MIGRATIONS_SECRET` (shared admin bearer), `CRON_SECRET`, `MASTER_ENCRYPTION_KEY` — per environment.
- Deploys: push to `preview` = herbe.service production deploy (service-test.herbe.app). Work on feature branches, PR into preview; never push main.

## 4. Ready-to-assign parallel jobs (conflict map)

Independent of each other (safe to run as parallel sessions):
1. **WS12 Documents** — worksheet/order report PDF+DOCX engine (portal's `/orders/{id}/report` expects it). Touches new `lib/documents/**` + a route; no overlap with sync code.
2. **WS2 remainder — WebAuthn, Baltic eID, Entra ID OIDC, seat/license enforcement** — core (roles/capabilities, session revocation, device registry, ERP identity link, admin password+TOTP) is done, see §5. Touches `lib/auth` only. No overlap with WS3/WS12.
3. **WS6 Connection config + sync health UI** — admin UI over existing `erp_companies` + `erp_sync_state` + creds encrypt (write side of `encryptErpCredentials`). Reads WS3 but doesn't change it.
4. **WS10 Dispatch board** (office UI over orders/worksheets/bookings-stub) — UI-heavy, minimal domain writes.
5. **WS4 ERP outbound** — push-queue saga (outbox exists), WSVc/SVOVc create+update, OK-flag write, read-back verification. **Touches the adapter + outbox**: don't pair with another adapter-touching session at the same time.
6. **WS9 Field PWA** — biggest; builds on offline sync-client + worksheets domain. Coordinate with WS4 (it produces the writes WS4 pushes) but can start UI-first.

Deferred/blocked bits to fold into whichever session touches the area: SVOVc/WSVc deletion detection (needs an erp_refs-based key-sweep variant), windowed-scan date bounds for full pulls (fine at demo scale), IVVc invoiced-status readback (WS4, WebExcellentAPI-gated), DelAddrVc siteName re-check on real tenant data (0/43 overlap on demo).

Each new session should read: this doc → `docs/21-phase-1-implementation-plan.md` (its WS section) → the relevant `docs/superpowers/plans/*.md` → then plan its own slice the same way (plan doc → subagent tasks → live proof where ERP-touching).

## 5. WS2 — what exists (roles, session revocation, device registry, identity link, admin password+TOTP)

Branch `feature/service-phase1-ws2-roles-identity` (PR into preview). Plans: `docs/superpowers/plans/2026-07-16-service-phase1-ws2-roles-identity.md` (roles/session/devices/identity-link) and `docs/superpowers/plans/2026-07-16-service-phase1-ws2-password-totp.md` (password+TOTP).

- `lib/auth/roles.ts` — `Role` (the canonical 5-value union, also re-exported by `lib/seed/personas.ts`), `Capability`, `ROLE_CAPABILITIES`, `hasCapability(role, capability)`. Transcribed from `docs/05-users-auth.md` §Roles. Not wired into any route beyond the 3 below — WS8/WS9/WS10/WS12/WS14 wire it in as their routes land. Known footgun: `hasCapability` throws (not `false`) on a role string outside the 5 literals — harmless today (nothing writes an arbitrary role yet) but worth a guard before a user-management UI lands.
- `session.user.role` and `session.user.sessionVersion` now flow through NextAuth's `jwtCallback`/`sessionCallback` (`lib/auth/config.ts`) — both stamped once at sign-in and forwarded unchanged, matching the existing `authTime` pattern (callbacks stay pure, no DB call inside).
- `lib/auth/session-guard.ts` — `getVerifiedSession(db)` (use instead of bare `auth()` in any route that must honor revocation — compares the token's stamped `sessionVersion` against the current DB value, returns `null` on mismatch/no-session) and `bumpSessionVersion(db, userId)` (atomic increment; invalidates every live session for that user). `users.session_version` column (migration 0017).
- Device registry: `GET /api/auth/devices` (self-list only), `POST /api/auth/devices/[id]/revoke` (self, or same-tenant `users:manage`; 403 for anyone else, 404 unknown id), `POST /api/auth/users/[id]/sign-out-everywhere` (self, or same-tenant `users:manage`; bumps `session_version`; 403 non-privileged cross-user, 404 cross-tenant/unknown target). No admin UI yet — API-only; UI is WS9's F11 profile page / WS14's admin surfaces.
- `identity_links` table (migration 0018) + `lib/auth/identity-link.ts`'s `matchUsersByEmail(db, {tenantId, erpCompanyId, adapter})` — links a `users` row to `UserVc.Code` by matching email (case-insensitive, `LoginEmailAddr` preferred over `emailAddr`, skips `Closed`/`TerminatedFlag` rows, first-come-wins on a duplicate ERP `Code` within one run). **No adapter changes were needed** — `pullFullList`/`pullChanges` in `lib/erp/standard-books/adapter.ts` already accept any register string generically.
- `app/api/cron/identity-rematch/route.ts` — daily (`0 3 * * *`), re-runs the match for every active `erp_companies` row, mirrors `sync-tick`'s bearer/lock/per-company-isolation pattern (300s lock TTL — sized for a daily sequential multi-company fan-out, not `sync-tick`'s 55s per-minute cadence).
- **Newly verified ERP fact**: `UserVc` confirmed delta-capable live (`probeIncrementalSupport('UserVc')` → `true`) — matches `docs/17-erp-register-reference.md`'s existing note, now proven against the real dedicated test ERP (`pnpm test:live`, 12/12 passing).
- WS4's "approval blocked if technician has no ERP person code" check (`docs/21-phase-1-implementation-plan.md` §WS4) should join `identity_links` on `userId` + `provider = 'erp'` + `erpCompanyId` — that's the reference pattern this slice establishes.

Password + TOTP for admin (`docs/05-users-auth.md`'s "Optional per tenant: password (argon2) + TOTP for admin roles" — scoped to the literal `admin` role, no tenant-config toggle exists yet so it's unconditional rather than actually optional-per-tenant):
- `lib/auth/password.ts` — `hashPassword`/`verifyPassword` (argon2id, same package already used for PIN hashing) + `getDummyPasswordHash` (memoized decoy hash so `authorizeCredentials` runs exactly one real `argon2.verify` call on every path — user-not-found, no-password-set, wrong-password, non-admin-role — no timing signal for account enumeration).
- `lib/auth/totp-secret.ts` + `lib/auth/totp.ts` — TOTP secret + recovery-code hashes packed as one JSON blob through the **existing** `lib/security/envelope.ts` (no new crypto primitive). `enrollTotp`/`confirmTotpEnrollment` (two-step: enrolling doesn't activate MFA until a real code is confirmed), `verifyTotp` (epoch-based atomic replay guard — a valid code can be used exactly once, race-safe under real concurrent submissions), `consumeRecoveryCode` (row-locked transaction, single-use, race-safe), `disableTotp` (accepts a TOTP or recovery code, always bumps `session_version` on success — reuses WS2's own `bumpSessionVersion`).
- `lib/auth/credentials-provider.ts` — a second NextAuth `Credentials` provider (`id: 'credentials'`) alongside the existing `magic_link` one, admin-role-gated, MFA-aware (falls back from TOTP to a recovery code).
- Four self-service routes, all admin-gated except `disable` (only an admin-gated route could ever have turned MFA on): `POST /api/auth/password/set` (bootstrap a password while signed in via magic link — no password-reset-by-email flow exists), `POST /api/auth/totp/enroll/start` (returns the raw `otpauthUri`/`secretBase32`/10 recovery codes — no UI renders a QR yet), `POST /api/auth/totp/enroll/finish`, `POST /api/auth/totp/disable`.
- Migration 0019 adds `users.password_hash`/`mfa_secret_encrypted`/`mfa_enabled`/`mfa_totp_last_used_epoch`.
- Design note for whoever builds the UI/role-management surface later: the device-registry routes (above) gate via `hasCapability(role, 'users:manage')`, while the password/TOTP routes gate via a literal `role === 'admin'` check — functionally identical today (only `admin` holds `users:manage`), intentionally so per each slice's own scoping, but worth reconciling into one idiom if a future role ever gets `users:manage` without being literally `admin`.

Deferred out of WS2 (unclaimed, ready to assign): WebAuthn platform-authenticator biometric unlock; Baltic eID (Smart-ID/Dokobit/eParaksts) + Microsoft Entra ID OIDC login providers (no tenant-config mechanism exists yet to make any of this "optional per tenant"); seat/license enforcement (no billing/seat-count concept exists anywhere yet); wiring `hasCapability` into any real route beyond the 3 device routes (none need it yet); tenant-configurable capability overrides (e.g. team_lead approving worksheets); a UI for password/TOTP enrollment (routes only, no QR rendering).

Also flagging, out of WS2's scope but surfaced during final review: `app/api/auth/magic-link/request/route.ts` logged the raw magic-link token + email to the console — already fixed on a separate small branch/PR (`fix/magic-link-log-pii`, off `preview`, independent of this branch), gated to non-production the same way `lib/auth/test-provider.ts` gates `TEST_AUTH`.
