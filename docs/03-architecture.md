# herbe.service — Technical Architecture

Status: draft v0.2 (2026-07-04) — **stack decision revised** after reviewing the actual herbe.calendar and herbe.portal codebases: neither uses Supabase. The suite standard is Next.js + Neon Postgres + Auth.js + Vercel; herbe.service adopts it. See `09-spec-review.md` finding B1.

## Shape

```
┌────────────── field devices ──────────────┐
│ PWA (offline-first)                       │
│  UI ── local DB (IndexedDB) ── sync client│
│  optional native wrapper (iOS/Android)    │
└──────────────────┬────────────────────────┘
                   │ HTTPS, delta sync + outbox
┌──────────────────▼────────────────────────┐
│ Vercel: Next.js (App Router) + API routes │
│  Auth.js v5 ── sync endpoints ── crons    │
└──────────────────┬────────────────────────┘
                   │
┌──────────────────▼────────────────────────┐
│ Supabase Postgres (Drizzle ORM)           │
│ + Supabase Storage (media originals)      │
└───────┬───────────────────────┬───────────┘
        │ ERP adapter           │ ERP adapter
┌───────▼────────┐      ┌───────▼──────────┐
│ Standard ERP   │      │ Excellent Books  │
│ REST API       │      │ REST API +       │
│ (registers)    │      │ WebExcellentAPI  │
└────────────────┘      └──────────────────┘
```

**Stack decision (verified against both sibling repos):**
- **Next.js 16 App Router + React 19 + TypeScript + Tailwind v4** — what both herbe.calendar and herbe.portal run today.
- **Supabase Postgres** (decision 2026-07-04 — DB hosting only; auth stays Auth.js, **not** Supabase Auth), EU region, one project per customer per the tenancy decision below. Known divergence, accepted: both siblings host on Neon, and the portal's provisioning CLI provisions Neon projects — the CLI is adapted to the Supabase Management API in Phase 0. ORM: **Drizzle** (portal pattern; calendar's raw-SQL approach is the suite outlier). Idempotent SQL migrations with a build-time runner + admin re-run UI, lifted from the portal (`scripts/migrate-prod.mjs`, `/admin/run-migrations`).
- **Auth.js (next-auth v5)** — both siblings run it. See `05-users-auth.md` for providers and identity links.
- **Vercel cron** for all background jobs (both siblings: `GET /api/cron/*` with `Bearer ${CRON_SECRET}`, constant-time check, Postgres advisory cron-locks à la calendar's `lib/cronLock.ts`), plus the `scripts/*-cron.sh` + `CRON-HANDOFF.md` fallback-runner convention both repos maintain.
- **Supabase Storage** for media originals (same per-customer Supabase project as the DB — one vendor, one bill); thumbnails generated server-side with `sharp` (already a portal dependency). Portal's Vercel Blob usage stays portal-local (theme assets only).
- **Sentry** (`@sentry/nextjs` with tunnel route), **pino** logging — suite conventions.
- **No Supabase anywhere** — the v0.1 assumption "match herbe.calendar" was made before the repo was reachable and turned out wrong. Realtime dispatcher updates use polling + `changeSeq` deltas first; a push channel (SSE or Postgres LISTEN/NOTIFY via Neon) is an optimization, not a foundation.

Standalone mode = backend + app with no adapter configured. ERP sync is an add-on module per tenant, not a dependency of the core.

**Tenancy — DECIDED 2026-07-04.** The **portal model**: one deployment + one database per customer, stamped out by the provisioning CLI — with the DB on **Supabase Postgres** instead of Neon (adapt `lib/provisioning`'s Neon calls to the Supabase Management API; Vercel/domain/env steps unchanged). Service tenants are companies with their own ERP connection and heavy per-tenant sync jobs; isolation-per-deployment keeps cron durations bounded and data isolation trivial. RLS unnecessary. If go-to-market later needs cheap self-service tenants, revisit with the calendar model (one deployment, `account_id` scoping).

## Client: PWA first, wrappers optional

Decision: build as an installable PWA; add a Capacitor wrapper only for the gaps, keeping one codebase.

What the PWA covers natively today:
- **Offline**: Service Worker (Workbox) for app shell; IndexedDB for data (via a wrapper like Dexie or RxDB). Storage quota is ample for orders + thumbnails; full-size photos upload-and-evict.
- **Camera**: `<input capture>` / `getUserMedia`.
- **Geolocation & navigation**: `geolocation` API; "navigate" opens Google/Apple/Waze via URL scheme; "call" via `tel:` links.
- **Signature**: canvas + pointer events.
- **Barcode/QR**: `BarcodeDetector` where available, ZXing-wasm fallback.
- **Push**: Web Push works on Android and on iOS ≥16.4 for installed PWAs.

Known PWA gaps → native wrapper (same web build) when needed:
- Reliable background sync on iOS (iOS has no Background Sync API; PWA syncs on launch/foreground — acceptable for v1).
- NFC tag reading (Web NFC is Android-only).
- Store distribution / MDM deployment for customers who require it.

Wrapper approach: herbe.calendar already ships a **native Swift `WKWebView` shell** (`ios/`, XcodeGen, token pairing via `/api/mobile/token`, APNs push, WidgetKit) — reuse that pattern rather than introducing Capacitor as a third mechanism in the suite; decide in Phase 2/3 when store distribution or NFC becomes real. Web Push covers Android + installed-PWA iOS ≥16.4 for v1; the calendar's APNs pipeline (`lib/apns.ts`) is the reference when the native shell lands.

Frontend stack: Next.js 16 + React 19 + TypeScript + Tailwind v4 (confirmed suite standard, see stack decision above), shadcn/Radix primitives as in the portal. State/query layer must be built over the local DB, not over HTTP: the network is an enhancement, never a requirement, for any technician-facing screen.

## Offline sync design

The part most FSM products get wrong; it drives the architecture.

**Downstream (server → device): delta pull.** Every entity table carries a monotonic per-tenant `changeSeq`. Client stores its high-water mark and pulls `?after=<seq>` per entity on: app start, connectivity regained, push nudge, manual refresh. Deletes ship as tombstones. A "download my work" action pre-fetches everything the technician's next N days need — orders, worksheets, customers, sites, service items + history, item catalog, own stock levels, checklist templates, attachments (thumbnails; originals on demand/Wi-Fi).

**Upstream (device → server): outbox.** Every local mutation is an append-only operation record (client UUID, entity, op, payload, base version). Replayed in order when online; server applies idempotently by UUID (safe against retries and double-taps). Photos/signatures upload as separate resumable blob uploads referenced by the ops.

**Conflicts.** Kept rare by design: ownership rules (see data-model) mean two parties seldom edit the same fields.
- Master data (customer, item): server wins, client re-reads.
- Worksheet facts (rows, time, media, checklist values): technician wins — these are statements of physical fact.
- Status transitions: guarded by a state machine server-side; an illegal transition (e.g. tech completes a worksheet a manager already rejected) is bounced back as a conflict task in the app inbox, never silently dropped.
- Same-field edits: last-writer-wins per field with full audit trail; a `conflict` sync-state flags it for review.

**Time.** Client clocks are untrusted: ops carry client timestamps, but ordering uses server receive order per device + causality (base versions).

## Backend

- **API**: Next.js API routes on Vercel, typed REST (OpenAPI-generated clients), per-tenant isolation, all list endpoints support `after=<changeSeq>` deltas — the same mechanism the ERP adapters consume. Service-to-service access (herbe.portal reading service data) via scoped hashed bearer tokens, reusing the portal's `analytics_tokens` pattern — see `08-suite-integration.md`.
- **Database**: Supabase Postgres + Drizzle. Row-versioned entities, `changeSeq` via sequence + trigger; append-only tables for ops, history events, audit. Tenant isolation by construction (one DB per customer, decided).
- **Auth**: Auth.js v5 with the portal's provider set (password + TOTP, magic link, optional Google / Entra ID / Smart-ID). See `05-users-auth.md`.
- **Files**: Vercel Blob for originals; images get server-side thumbnails (`sharp`) on upload. ERP-side documents stream through the adapter (portal pattern), never copied.
- **Realtime**: dispatcher board and sync-health screens refresh via short-interval delta polling on `changeSeq` first; Supabase Realtime (available on the chosen DB hosting) or SSE is a later optimization. It's a UX enhancement, not a substitute for the offline pull/outbox mechanism devices rely on.
- **Background jobs**: Vercel Cron hitting `GET /api/cron/*` routes with `Bearer ${CRON_SECRET}` and advisory cron-locks (both siblings' proven convention), sized to finish within function duration limits — chunk large tenants/registers across runs (calendar's `syncAllErp` batching: `Promise.allSettled` per connection, 60 s per-connection timeout, 500-row upsert batches, page limit ceilings). Maintain `scripts/herbe-service-cron.sh` + `scripts/CRON-HANDOFF.md` mirrors like both siblings.
- EU-hosted: Vercel `fra1` + Supabase EU (Frankfurt) region pinning.
- **Licensing (per-user pricing decided 2026-07-04)**: per-tenant licensed seat count enforced at user activation — activating a user beyond the seat count is blocked with an upgrade prompt; seat usage (licensed vs active, by role) visible in tenant admin. Seat count lives in tenant config, set at provisioning and adjustable by super-admin. Deactivated users free their seat (and trigger device wipe per `05-users-auth.md`).

## ERP adapters

Both target APIs are HansaWorld-register style (verified against Excellent Books API docs; Standard ERP's REST API is the same family):
- `GET /api/1/<Register>?updates_after=<seq>` — delta reads with `@sequence` high-water marks
- `filter.Field=value`, `offset/limit` — targeted reads
- `POST /api/1/<Register>` — record creation
- Deletions: detected by periodic key-sweep reconciliation, not by the API's `deletes_after` (unreliable in practice)
- `WebExcellentAPI.hal?action=...` is an optional second tier (not all installations have it); when present it adds `windowactions` field-trigger simulation (ERP-computed prices/VAT), activities, and ERP document PDF download. Never a hard dependency.

**Do not build the adapter from scratch.** herbe.portal ships a production adapter framework for exactly these APIs: a neutral `ErpAdapter` interface + `AdapterCapabilities` (`lib/erp/types.ts`, with Horizon/Jumis/Moneo adapter slots already stubbed in its registry), a Standard Books REST client, a WebExcellentAPI client that already handles the real-world quirks (HTTP/1.1-only HAL servlet, HSESSION cookie reuse, Basic-auth-only endpoints, base64-in-XML PDF decoding), a Postgres register cache with full/incremental sync and a two-level freshness model, and encrypted per-company credential storage. herbe.calendar independently proves the `updates_after`/`@sequence` incremental path and two-way `ActVc` writes. herbe.service extends this framework with the service registers instead of designing a new one — details, register mapping and reuse plan: `04-erp-sync.md` and `08-suite-integration.md`.

## Non-functional targets

- Cold start to usable worksheet list, offline: < 3 s on a mid-range Android phone.
- Full "download my work" for a typical week: < 1 min on 4G.
- Server round-trip for outbox replay after a day offline: < 30 s.
- All technician-critical screens function with zero connectivity; no spinner may ever block on network for cached data.
- Audit: every state change attributable (who, when, from which device).
- GDPR: customer personal data minimized on device, encrypted at rest (device DB), remote wipe of app data on user deactivation.
