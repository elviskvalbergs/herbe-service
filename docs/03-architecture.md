# herbe.service — Technical Architecture

Status: draft v0.1 (2026-07-03)

## Shape

```
┌────────────── field devices ──────────────┐
│ PWA (offline-first)                       │
│  UI ── local DB (IndexedDB) ── sync client│
│  optional Capacitor wrapper (iOS/Android) │
└──────────────────┬────────────────────────┘
                   │ HTTPS, delta sync + outbox
┌──────────────────▼────────────────────────┐
│ herbe.service backend                     │
│  API ── Postgres ── sync/queue workers    │
│  auth (local + OIDC) ── files (S3-style)  │
└───────┬───────────────────────┬───────────┘
        │ ERP adapter           │ ERP adapter
┌───────▼────────┐      ┌───────▼──────────┐
│ Standard ERP   │      │ Excellent Books  │
│ REST API       │      │ REST API +       │
│ (registers)    │      │ WebExcellentAPI  │
└────────────────┘      └──────────────────┘
```

Standalone mode = backend + app with no adapter configured. ERP sync is an add-on module per tenant, not a dependency of the core.

## Client: PWA first, wrappers optional

Decision: build as an installable PWA; add a Capacitor wrapper only for the gaps, keeping one codebase.

What the PWA covers natively today:
- **Offline**: Service Worker (Workbox) for app shell; IndexedDB for data (via a wrapper like Dexie or RxDB). Storage quota is ample for orders + thumbnails; full-size photos upload-and-evict.
- **Camera**: `<input capture>` / `getUserMedia`.
- **Geolocation & navigation**: `geolocation` API; "navigate" opens Google/Apple/Waze via URL scheme; "call" via `tel:` links.
- **Signature**: canvas + pointer events.
- **Barcode/QR**: `BarcodeDetector` where available, ZXing-wasm fallback.
- **Push**: Web Push works on Android and on iOS ≥16.4 for installed PWAs.

Known PWA gaps → Capacitor wrapper (same web build) when needed:
- Reliable background sync on iOS (iOS has no Background Sync API; PWA syncs on launch/foreground — acceptable for v1).
- NFC tag reading (Web NFC is Android-only).
- Store distribution / MDM deployment for customers who require it.

Frontend stack: TypeScript + the framework used by the existing herbe apps (to be confirmed against the herbe.calendar repo — reuse of the suite's design system and components is a project requirement, see README). State/query layer must be built over the local DB, not over HTTP: the network is an enhancement, never a requirement, for any technician-facing screen.

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

- API: typed REST (OpenAPI-generated clients), per-tenant isolation, all list endpoints support `after=<changeSeq>` deltas — the same mechanism the ERP adapters consume.
- Postgres: row-versioned entities, `changeSeq` via sequence + trigger; append-only tables for ops, history events, audit.
- Files: S3-compatible object store; images get server-side thumbnails.
- Workers: sync queue (ERP adapters), history-event builder, notifications (push/email), report/PDF generation (worksheet PDF with signature for the customer).
- Multi-tenant from day one (suite pattern), EU-hosted.

## ERP adapters

Both target APIs are HansaWorld-register style (verified against Excellent Books API docs; Standard ERP's REST API is the same family):
- `GET /api/1/<Register>?updates_after=<seq>` — delta reads with `@sequence` high-water marks
- `deletes_after=<seq>` — tombstones for base registers
- `filter.Field=value`, `offset/limit` — targeted reads
- `POST /api/1/<Register>` — record creation
- Excellent Books additionally exposes `WebExcellentAPI.hal?action=...` incl. `windowactions` field-trigger simulation — used to get ERP-computed values (prices, VAT) without reimplementing ERP logic.

One adapter framework, two configurations. Details and register mapping: `04-erp-sync.md`.

## Non-functional targets

- Cold start to usable worksheet list, offline: < 3 s on a mid-range Android phone.
- Full "download my work" for a typical week: < 1 min on 4G.
- Server round-trip for outbox replay after a day offline: < 30 s.
- All technician-critical screens function with zero connectivity; no spinner may ever block on network for cached data.
- Audit: every state change attributable (who, when, from which device).
- GDPR: customer personal data minimized on device, encrypted at rest (device DB), remote wipe of app data on user deactivation.
