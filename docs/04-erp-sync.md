# herbe.service — Two-way ERP Sync (Standard ERP & Excellent Books)

Status: draft v0.2 (2026-07-04) — spec-review fixes: adapter framework reuse (herbe.portal), capability-driven incremental sync, cache/freshness model, write mechanics & normalization, invoice back-link, Sites mapping

## Principle

The app is not a UI over the ERP; it is a peer system with its own store. Sync is a background process, per tenant, per adapter, direction-aware. A tenant may connect Standard ERP, Excellent Books, both (**migration mode only**: one ERP is marked primary per register, the other read-only — never two writable masters), or none (standalone).

Adapter order (decided 2026-07-04): **Excellent Books first** — launch tenants come from the Excellent customer base. Since both ERPs share the same register API family, the Standard ERP configuration follows cheaply. Note for Phase 0 tenant verification: booking sync and PDF features on Excellent Books require WebExcellentAPI on the tenant's installation — probe and confirm for the launch tenant specifically.

## Adapter framework: extend herbe.portal's, don't rebuild

Phase 1 targets Standard ERP and Excellent Books; other ERPs (Horizon, Jumis, Moneo are already stubbed in the portal's registry) may follow. The abstraction that makes that possible **already exists** in herbe.portal:

- **`ErpAdapter` interface + `AdapterCapabilities`** (`herbe-portal/lib/erp/types.ts`) — a neutral contract; everything outside `lib/erp/` imports only this module. Capabilities (`supportsIncrementalSync`, `supportsWebExcellentApi`, …) gate features per connection; a feature whose capability is `false` is absent from the UI, not disabled.
- **Registry + factory** (`lib/erp/registry.ts`) — adapter chosen per company config; credentials AEAD-encrypted per company (`lib/erp/credentials.ts`, envelope format, master key).
- **Standard Books REST client** — `${base_url}/api/${companyCode}/${register}` with `filter[Field]=value`, offset paging, 401→HSESSION-reset-retry, control-char-sanitizing JSON parse.
- **WebExcellentAPI client** — `WebExcellentAPI.hal?action=…`; handles the servlet's real behavior: HTTP/1.1 only (403s on HTTP/2 — undici `allowH2:false`), Basic auth only (rejects OAuth Bearer), HSESSION cookie capture/reuse, base64-in-XML document decoding.
- **Register cache + sync runner + freshness model** — see "Cache & freshness" below.

herbe.calendar independently maintains the same API family client (`lib/herbe/client.ts`) with the pieces the portal doesn't use: **`updates_after`/`@sequence` incremental reads**, OAuth token refresh against `standard-id.hansaworld.com` (advisory-lock-guarded), and **two-way `ActVc` writes** (`lib/herbe/actVcSave.ts`).

herbe.service's adapter = the portal contract, extended with service-register methods (`listServiceOrders`, `getWorksheet`, `postWorksheet`, `listKnownSerials`, stock transactions, …) + the calendar's incremental-read and write mechanics. Extraction into a shared `@herbe/erp` package is the Phase 0 plan (`08-suite-integration.md`); copy-first with attribution (the suite's existing precedent) if extraction stalls.

## API family

Both ERPs expose the HansaWorld-style register API. Verified from Excellent Books API docs (api-docs.excellent.ee):

- `GET /api/1/<Register>` — list; `filter.Field=value`, `sort`, `range`, `offset`/`limit`. Observed variants in production code: calendar uses `/api/1/...`-style paths with `updates_after`; portal uses `${base_url}/api/${companyCodeInErp}/${register}` with `filter[Field]=value`. The adapter's URL builder is per-connection config, not a constant.
- `?updates_after=<seq>` — only records changed after sequence number; response carries `@sequence` to store as the new high-water mark. **Not guaranteed on every installation/register**: the portal runs `supportsIncrementalSync: false` in production and full-scans instead. Incremental reads are a per-connection *capability*, probed at setup; the sync engine must be correct with full-scan-only connections (slower cadence, same result).
- Caveat verified in calendar code: server-side `filter[…]` matching is unreliable on some registers — the portal deliberately full-scans + filters app-side for CUVc/ContactRelVc. Treat ERP-side filters as an optimization, never as the correctness mechanism.
- `POST /api/1/<Register>` — create/update records
- Records carry `UUID` and `@url`
- Caveat from docs: sequence numbers may reset after ERP version upgrades → adapter must detect regression and fall back to full reconciliation.

**Deletion detection.** The API's `deletes_after` parameter exists but is unreliable in practice — do **not** build on it. Instead: nightly (and on demand) key-sweep reconciliation per register — page through record IDs/UUIDs with plain list calls, diff against our stored `erpRefs`, tombstone what disappeared. The same sweep doubles as the recovery path for sequence resets. Between sweeps a record deleted in the ERP may linger in the app for up to a day; acceptable for master data, and service documents are guarded anyway (an approved worksheet must never be silently deleted by sync — flag, don't delete).

### Two API tiers

`api-docs.excellent.ee` documents two APIs; the adapter must treat them as separate capability tiers:

1. **REST register API** (`/api/1/...`) — the baseline. Present on all installations. **The adapter must be fully functional with this API alone.**
2. **WebExcellentAPI** (`WebExcellentAPI.hal?action=...`) — newer, optional; not all customers have it. Detected per tenant (capability flag in adapter config, verified by probe at setup). When present, it unlocks enhancements: `windowactions` (simulate a field change, get ERP-computed fields back — prices, VAT, account derivation), `getrecordlinks`, activities, PDF download of ERP documents. Every feature built on it needs a graceful fallback or is hidden for tenants without it.

## Register mapping

Verified register codes (from API docs) vs. to-confirm (service module codes differ per version — confirm against the actual tenant ERPs during Phase 0):

| App entity | Standard ERP / Excellent Books register | Status |
|---|---|---|
| Item | `INVc` | verified |
| Price list | `PLVc` | verified |
| Item classifier | `DIVc` | verified |
| Customer class | `CCatVc` | verified |
| Employee (for user linking) | `EmplVc` | verified |
| Customer | Contacts register (`CUVc`) | verified (portal syncs it in production) |
| Contact person | `CUVc` (flag-distinguished) + relations `ContactRelVc` | verified (portal) |
| Employee/portal user lookup | `UserVc` | verified (portal + calendar) |
| Site (service address) | `CUVc` address rows / delivery addresses / Objects | confirm — model per tenant during Phase 0; Sites stay first-class app-side regardless |
| Customer service item / serial | Known Serial Numbers | confirm code |
| Service order | Service Orders register (Service Orders module) | confirm code |
| Worksheet | Work Sheets register | confirm code |
| Stock level | stock/item-status lookup or report API | confirm |
| Stock transaction (consumption, van transfer) | Stock Depreciation / Stock Movement | confirm code |
| Invoice (status back-link only) | `IVVc` | verified (seen in docs) |
| Booking | Activities `ActVc` (Standard ERP; Excellent Books via WebExcellentAPI where available) | decided |

## Cache & freshness (server-side ERP cache)

Three data layers, each with its own refresh rule — don't conflate them:

1. **ERP → server cache** (`cached_{register}` tables, portal pattern): per `(company, register)` a `sync_state` row tracks status/cursor/`lastFullSyncAt`. Two distinct freshness concepts, kept separate exactly as the portal enforces:
   - `isCacheTrustworthy(state)` — register-wide: "do we have a complete snapshot at all?" Gates whether the cache may be served. Set only by a completed full sync.
   - `isCustomerCacheFresh(...)` — per-scope (customer/technician): `max(updatedAt)` over that scope's cached rows. Triggers an on-demand incremental sync on read when stale ("sync-on-read"). Never short-circuit it from register-wide timestamps — a full sync must not make every scope look fresh.
2. **Server → device** (delta pull): every entity table carries `changeSeq`; devices pull `?after=<seq>` (see `03-architecture.md`). The device never talks to the ERP.
3. **Device → server** (outbox): app-owned facts flow up as idempotent ops; the server's ERP push queue (below) is the only writer toward the ERP.

Reads that hit a stale scope trigger a scoped incremental sync inline (bounded), then serve; full syncs run only on schedule/reconciliation — the portal's loader pattern, reused.

## Sync flows

### Inbound (ERP → app), continuous polling per register
Master data: customers, items, prices, stock levels, employees, known serial numbers, open service orders created in ERP. Poll cadence: fast registers (service orders, stock, activities) every 1–5 min; slow (items, customers) every 15–60 min; full reconciliation nightly and on sequence reset. On connections without `updates_after` support the fast cadence degrades to windowed full scans (date-range `range=` reads, calendar's `fullSyncRange` pattern: rounded month windows, ~90 d back / 30 d forward).

### Outbound (app → ERP), event-driven
- New customer / service item created in field → pushed immediately (with duplicate-check by reg. number / serial before create).
- Service order created in app → pushed on creation, ERP number stored back into `erpRefs`.
- Booking created/moved on the dispatch board → written as an Activity (`ActVc`) on the technician's ERP calendar (mapped by the user's ERP identity link; activity type per adapter config). Inbound: activities of the mapped types poll on the fast cadence and update/create bookings, so a schedule change made in the ERP (or in herbe.calendar) shows on the technician's phone.
- Worksheet → pushed when **Approved** by service manager (not per keystroke): worksheet header + rows (parts with stock location, services, time). Stock consumption posts as the ERP-appropriate stock transaction. Invoice is then created **in the ERP** by existing ERP flows; the adapter reads back invoice number/status for display in the app's service history.
- **Invoice back-link mechanics**: the pushed worksheet/order record carries the app's order number in an agreed ERP field (order-number field or a custom field — fixed per tenant field map, confirmed in Phase 0). The `IVVc` poll matches invoices back by that reference (fallback: customer + date + amount heuristic flagged for manual confirm, never silently linked). Payment status enrichment can reuse the portal's `ARVc` (open-balances) mapper.
- Attachments: pushed as record links where the ERP supports it; otherwise the app remains the system of record for media and the ERP record carries a deep link into herbe.service.

### Write mechanics & normalization (data modified on read/send)

Verified against calendar/portal production code — encode these as adapter rules, not tribal knowledge:

- **Writes** are URL-encoded form posts: `set_field.<Field>=<value>`, matrix rows as `set_row_field.<N>.<Field>` with long text **chunked across rows** (calendar's `toHerbeForm`/`saveActVcRecord`). The adapter owns chunking/reassembly; app code never sees row-chunked text.
- **Read normalization**: ERP responses may contain control characters (portal sanitizes before JSON parse), locale-formatted dates and decimals, and person lists as packed strings (calendar's `parsePersons`). Mappers normalize to ISO dates, canonical decimal strings, and arrays at the adapter boundary — domain types never carry raw ERP formats.
- **Auth is per-tier**: REST accepts OAuth Bearer (calendar refreshes tokens against `standard-id.hansaworld.com`, advisory-lock-coalesced) or Basic; **WebExcellentAPI accepts Basic only and HTTP/1.1 only**. HSESSION cookies are captured and reused (~4 h TTL) to avoid re-auth per call.
- **Field-level mapping tables are configuration, not code**: per-tenant register/field maps versioned in the backend, because Standard ERP installations are customized.
- **Pre-app history import** (Phase 1 "history includes ERP era"): initial load pages historical Work Sheets/Service Orders/Invoices per serial number into `HistoryEvent` rows through the same mappers, date-windowed (default: full available history for serials under contract, configurable horizon otherwise). Scope confirmed against real tenant data volumes in Phase 0.

### Identity & idempotency
- Every app record stores per-ERP `erpRefs {register, uuid/code, seq}`.
- Outbound ops carry the app UUID; adapter must never double-create (lookup by stored ref, then by natural key, then create).

### Error handling
- Failed pushes go to a per-tenant dead-letter queue with human-readable reason, surfaced in a back-office "Sync health" screen (count, last success per register, retry button). Silent sync failure is the #1 trust-killer for two-way integrations — this screen is a Phase 1 deliverable, not an afterthought.
- Validation mismatches (ERP rejects a row: closed period, missing account, credit-blocked customer) bounce back as actionable tasks to the service manager, with the worksheet returned to `Done` (not lost).

## Pricing & invoicing boundary

The app shows prices for informational purposes (role-gated); the ERP owns pricing truth. Baseline flow (REST tier only): on worksheet approval the adapter POSTs the record and reads the created record back with ERP-computed prices/VAT. Tenants with WebExcellentAPI get the nicer variant — `windowactions` pre-computes values before posting, so the manager sees final prices at approval time. The app never generates invoices.

## Standalone mode

No adapter configured: numbers issued from app-local series, prices from an app-maintained simple price list on Items, invoicing status features hidden. Enabling an adapter later triggers an initial-load wizard: match customers/items by natural keys, review duplicates, then switch masters per the ownership table in `02-data-model.md`.
