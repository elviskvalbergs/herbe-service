# herbe.service — Technical Architecture

Status: v0.3 (2026-07-05) — spec-line merge: platform blueprint (theming, whitelabel, settings model) folded in from the audit line; fleet-ops, cron-scheduling and device-security gaps from review round 2 resolved. Stack verified against both sibling codebases. Tenancy resolved 2026-07-05: multi-tenant core + dedicated deployments as a whitelabel option (below).

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
└──────────────────┬────────────────────────┘
                   │ one adapter, N company connections
┌──────────────────▼────────────────────────┐
│ Standard ERP / Excellent Books            │
│ (same product family)                     │
│ REST register API                         │
│ + optional WebExcellentAPI per install    │
└───────────────────────────────────────────┘
```

**Stack decision (verified against both sibling repos):**
- **Next.js 16 App Router + React 19 + TypeScript + Tailwind v4** — what both herbe.calendar and herbe.portal run today; shadcn/Radix primitives as in the portal (the calendar's hand-rolled CSS layer is the suite outlier).
- **Supabase Postgres** (decision 2026-07-04 — DB hosting only; auth stays Auth.js, **not** Supabase Auth; Neon's free tier doesn't fit service's data/photo volume, and Supabase bundles Storage we use). EU region. ORM: **Drizzle** (portal pattern). Idempotent SQL migrations with a build-time runner + admin re-run UI, lifted from the portal (`scripts/migrate-prod.mjs`, `/admin/run-migrations`).
- **Auth.js (next-auth v5)** — both siblings run it. See `05-users-auth.md` for the role-shaped login model (magic link office, PIN + biometrics field) and identity links.
- **Scheduled jobs**: `GET /api/cron/*` routes with `Bearer ${CRON_SECRET}` and Postgres advisory cron-locks (both siblings' convention). **Decision (product owner, 2026-07-05): Vercel cron is the primary scheduler for now**; `scripts/herbe-service-cron.sh` + `CRON-HANDOFF.md` are written and maintained from day one as the documented fallback, switched to only if Vercel cron's limits bite. To live within those limits (1-minute floor, one schedule per route), per-register/per-connection cadences are **not** separate cron entries: one frequent dispatcher route (`/api/cron/sync-tick`, every minute) reads due-times from the DB and fans out internally to whatever registers/connections are due — cadence stays tenant configuration, the cron surface stays tiny.
- **Supabase Storage** for media originals (same per-customer Supabase project as the DB — one vendor, one bill); thumbnails generated server-side with `sharp` (already a portal dependency). Portal's Vercel Blob usage stays portal-local (theme assets only).
- **Sentry** (`@sentry/nextjs` with tunnel route), **pino** logging — suite conventions.
- **Supabase = Postgres + Storage hosting only.** The v0.1 assumption that the suite runs on Supabase was wrong (neither sibling does); the 2026-07-04 decision brings Supabase in for DB + Storage hosting, but **no Supabase Auth, no Edge Functions, no Realtime dependency**. Realtime dispatcher updates use polling + `changeSeq` deltas first; a push channel (SSE, or Supabase Realtime since it ships with the DB) is an optimization, not a foundation.

Standalone mode = backend + app with no adapter configured. ERP sync is an add-on module per tenant, not a dependency of the core.

**Tenancy — RESOLVED 2026-07-05 (product owner): both, portal-style productized.** The application core is **multi-tenant** — tenant scoping (`tenant_id`, the calendar's `account_id` pattern) on every domain table, one shared **SaaS deployment** as the default home for tenants — **and** a customer gets a **dedicated deployment** when they need whitelabel design or overlay customisations: same codebase, stamped out by the provisioning CLI (adapted from Neon to the Supabase Management API), riding the same version train. A dedicated deploy is simply an instance hosting one tenant; nothing in the code knows the difference. Consequences: tenant scoping in the schema from day one (Postgres RLS is optional hardening later, not the mechanism); per-tenant cron chunking is mandatory in the shared deployment (calendar's `syncAllErp` batching); customisations are configuration + **overlay hooks** (theme, field policies, transformations, document templates) — never forks; a tenant that outgrows the shared deployment migrates to a dedicated one without schema changes.

**Fleet operations (vendor side).** The SaaS deployment plus the dedicated deployments form a small fleet; adopt the portal's ops story wholesale: the deployment inventory lives in a vendor-side `customers.yaml` + provisioning CLI (`bin/provision.ts` pattern); all deployments ride one **version train** — a release rolls to every deployment, per-deployment DB migrations applied by the build-time runner on deploy; per-deployment Sentry DSN tags (one Sentry project, `deployment` tag); seat counts and licensing (below) are per-tenant config, set at tenant creation/provisioning and adjustable by the vendor super-admin. Customer-specific needs are handled as configuration (themes, field policies, transformations, templates) — never forks.

## Platform blueprint — herbe.portal's approach

What we copy from the portal is the **product platform**, proven in production:

- **Theme support.** Per-tenant theming (logo, colors, typography tokens) across every herbe.service surface: back-office web app, technician PWA, customer-visible pages, generated documents — the worksheet report PDF renders in the tenant's theme. Use the **same theme-token vocabulary as herbe.portal** (`--brand-*` aliases over the Burti palette), so one tenant branding definition carries across suite apps without re-entry (concrete token list: `14-design-handoff.md`). One constraint: field-UI accessibility rules (contrast, glove-sized targets) override brand colors where they conflict.
- **Whitelabel presence** = a dedicated deployment with the tenant's domain, theme, email branding and overlay customisations — configuration and hooks on the version train, never a fork (tenancy decision above).
- **Email templates.** Notification/email sending via the portal's TemplateKey engine (copied-first per the reuse decision, `08-suite-integration.md` §6): per-purpose keys, per-tenant overrides, localized defaults, admin editor. Sending via the suite's Microsoft Graph/SMTP pattern.
- **Settings model.** Tenant settings follow the portal's conventions: same structure, same admin UX patterns, and **settings import/export** as a first-class operation (support diagnostics, cloning a proven setup, staging→production promotion, whitelabel provisioning). herbe.service's setting groups: ERP connections and transformations (`04-erp-sync.md`), status→stage maps, role policies, field policies, offline/briefcase scope, checklist defaults, document templates + number series (`12-documents-templates.md`). Secrets never travel in exports.

## Client: PWA first, wrappers optional

Decision: build as an installable PWA; add a native wrapper only for the gaps, keeping one codebase.

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
- Biometric unlock APIs beyond WebAuthn platform authenticators.
- Store distribution / MDM deployment for customers who require it.

Wrapper approach: two candidates, decided in Phase 2/3 when store distribution, NFC or biometrics become real — herbe.calendar's **native Swift `WKWebView` shell** (`ios/`, XcodeGen, token pairing via `/api/mobile/token`, APNs push) as the iOS reference, or **Capacitor** if Android needs wrapping at the same time. Web Push covers Android + installed-PWA iOS ≥16.4 for v1.

**Device data at rest — honest scope** (Phase 0 local-DB ADR): a PWA cannot hold a key the device can't reach; IndexedDB has no app-level at-rest encryption story beyond platform disk encryption. Baseline = platform disk encryption + offline PIN/biometric app-lock (rate-limited, wipe-on-N-failures per tenant policy, `05-users-auth.md`) + data minimization (briefcase horizon N days; access instructions only for the assigned technician) + remote wipe on next contact. App-layer crypto (local key wrapped by the PIN) is a hardening option; tenants that demand OS-keystore-backed encryption get the native wrapper. The GDPR line below reads accordingly.

Frontend stack: Next.js 16 + React 19 + TypeScript + Tailwind v4, shadcn/Radix primitives. State/query layer must be built over the local DB, not over HTTP: the network is an enhancement, never a requirement, for any technician-facing screen.

## Offline sync design

The part most FSM products get wrong; it drives the architecture. How the device-facing layers join the ERP-facing layers is pinned in `04-erp-sync.md` "Store topology" — the domain tables below are the single source devices sync against; ERP data reaches them only through the ingest step.

**Downstream (server → device): delta pull.** Every entity table carries a monotonic per-tenant `changeSeq`. Client stores its high-water mark and pulls `?after=<seq>` per entity on: app start, connectivity regained, push nudge, manual refresh. Deletes ship as tombstones (incl. merge-redirects, `02-data-model.md`). A "download my work" action pre-fetches everything the technician's next N days need — orders, worksheets, customers, sites, service items + history, item catalog + compatibility, own stock levels, checklist templates, attachments (thumbnails; originals on demand/Wi-Fi). **Device delta endpoints never trigger inline ERP syncs** — cron cadence keeps the domain store fresh; the sync-on-read pattern applies to office-shell reads only (`04-erp-sync.md`).

**Upstream (device → server): outbox.** Every local mutation is an append-only operation record (client UUID, entity, op, payload, base version). Replayed in order when online; server applies idempotently by UUID (safe against retries and double-taps). Photos/signatures upload as separate resumable blob uploads referenced by the ops.

**Conflicts.** Kept rare by design: ownership rules (see data-model) mean two parties seldom edit the same fields.
- Master data (customer, item): server wins, client re-reads.
- Worksheet facts (rows, time, media, checklist values): technician wins — these are statements of physical fact. Crew edits are per-member-attributed (`addedBy`), so members rarely touch the same row.
- Status transitions: guarded by a state machine server-side; an illegal transition (e.g. tech completes a worksheet a manager already rejected) is bounced back as a conflict task in the app inbox, never silently dropped.
- Same-field edits: last-writer-wins per field with full audit trail; a `conflict` sync-state flags it for review.

**Time.** Client clocks are untrusted: ops carry client timestamps, but ordering uses server receive order per device + causality (base versions).

## Backend

- **API**: Next.js API routes on Vercel, typed REST (OpenAPI-generated clients), per-tenant isolation, all list endpoints support `after=<changeSeq>` deltas — the same mechanism the ERP adapters consume. Service-to-service access (herbe.portal reading service data) via scoped hashed bearer tokens, reusing the portal's `analytics_tokens` pattern — see `08-suite-integration.md`.
- **Database**: Supabase Postgres + Drizzle. Row-versioned entities, `changeSeq` via sequence + trigger (per tenant); append-only tables for ops, history events, audit. Tenant isolation via `tenant_id` scoping in query code (calendar pattern; RLS optional hardening); dedicated deployments add infrastructure isolation on top.
- **Auth**: Auth.js v5, role-shaped providers (`05-users-auth.md`).
- **Files**: Supabase Storage for originals (stack decision above); images get server-side thumbnails (`sharp`) on upload. ERP-side documents stream through the adapter (portal pattern), never copied.
- **Realtime**: dispatcher board and sync-health screens refresh via short-interval delta polling on `changeSeq` first; Supabase Realtime or SSE is a later optimization. It's a UX enhancement, not a substitute for the offline pull/outbox mechanism devices rely on.
- **Background jobs**: Vercel cron (primary; ops-runner as documented fallback — scheduling decision above) hitting `GET /api/cron/*` with advisory cron-locks, sized to finish within function duration limits — chunk large companies/registers across runs (calendar's `syncAllErp` batching: `Promise.allSettled` per connection, 60 s per-connection timeout, 500-row upsert batches, page limit ceilings). Job inventory: per-register ERP polls, ERP push queue drain, key-sweep reconciliation, **HistoryEvent projector**, document render queue (`12-documents-templates.md`), notification delivery, recurring-order generation (Phase 3). Maintain `scripts/herbe-service-cron.sh` + `scripts/CRON-HANDOFF.md` like both siblings.
- EU-hosted: Vercel `fra1` + Supabase EU (Frankfurt) region pinning.
- **Licensing (per-user pricing decided 2026-07-04)**: per-tenant licensed seat count enforced at user activation — activating a user beyond the seat count is blocked with an upgrade prompt; seat usage (licensed vs active, by role) visible in tenant admin. Seat count is per-tenant config adjustable by the vendor super-admin (fleet-ops section above). Deactivated users free their seat (and trigger device wipe per `05-users-auth.md`).

## ERP adapter

Standard ERP and Excellent Books are the same HansaWorld product family — **one adapter** serves both, configured per company connection (portal's `erp_companies` model: N connections per install, each a separate company scope; users switch companies). The adapter framework itself is **ERP-agnostic** (portal model, with Horizon/Jumis/Moneo slots already stubbed in its registry): adapters implement a neutral contract — change detection, entity mapping through the transformation layer, idempotent push, deletion detection, capability flags — and everything above it (sync engine, DLQ + sync health, config UI, settings export) is written once. Full contract and the HansaWorld specifics: `04-erp-sync.md`.

**Do not build the adapter from scratch.** herbe.portal ships a production adapter framework for exactly these APIs: the neutral `ErpAdapter` interface + `AdapterCapabilities` (`lib/erp/types.ts`), a Standard Books REST client, a WebExcellentAPI client that already handles the real-world quirks (HTTP/1.1-only HAL servlet, HSESSION cookie reuse, Basic-auth-only endpoints, base64-in-XML PDF decoding, charset sniffing + raw-`http` fallback for malformed responses, typed `ErpTransientError`/`ErpPermanentError`/maintenance-window classification), a Postgres register cache with full/incremental sync and a two-level freshness model, and encrypted per-company credential storage. herbe.calendar independently proves the `updates_after`/`@sequence` incremental path and two-way `ActVc` writes (incl. advisory-lock-coalesced OAuth refresh). herbe.service extends this framework with the service registers instead of designing a new one — details, register mapping and reuse plan: `04-erp-sync.md` and `08-suite-integration.md`.

The ERP doubles as the **suite bus**: herbe.calendar reads/writes the same Activities register our bookings live in, and herbe.portal is fed by the same ERP our approved worksheets invoice through — so calendar and portal interop work at launch with no suite-to-suite API (`08-suite-integration.md`).

## Non-functional targets

- Cold start to usable worksheet list, offline: < 3 s on a mid-range Android phone.
- Full "download my work" for a typical week: < 1 min on 4G.
- Server round-trip for outbox replay after a day offline: < 30 s.
- All technician-critical screens function with zero connectivity; no spinner may ever block on network for cached data.
- Audit: every state change attributable (who, when, from which device) — append-only audit tables, Phase 1.
- GDPR: customer personal data minimized on device (briefcase horizon), platform disk encryption + app-lock (see "Device data at rest"), remote wipe of app data on user deactivation, retention policies per tenant.
