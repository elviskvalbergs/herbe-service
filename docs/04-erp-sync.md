# herbe.service — Two-way ERP Sync (Standard ERP & Excellent Books)

Status: draft v0.1 (2026-07-03)

## Principle

The app is not a UI over the ERP; it is a peer system with its own store. Sync is a background process, per tenant, per adapter, direction-aware. A tenant may connect Standard ERP, Excellent Books, both (rare, e.g. migration), or none (standalone).

## API family

Both ERPs expose the HansaWorld-style register API. Verified from Excellent Books API docs (api-docs.excellent.ee):

- `GET /api/1/<Register>` — list; `filter.Field=value`, `sort`, `range`, `offset`/`limit`
- `?updates_after=<seq>` — only records changed after sequence number; response carries `@sequence` to store as the new high-water mark
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
| Customer | Contacts register (`CUVc`) | confirm |
| Customer service item / serial | Known Serial Numbers | confirm code |
| Service order | Service Orders register (Service Orders module) | confirm code |
| Worksheet | Work Sheets register | confirm code |
| Stock level | stock/item-status lookup or report API | confirm |
| Stock transaction (consumption, van transfer) | Stock Depreciation / Stock Movement | confirm code |
| Invoice (status back-link only) | `IVVc` | verified (seen in docs) |

## Sync flows

### Inbound (ERP → app), continuous polling per register
Master data: customers, items, prices, stock levels, employees, known serial numbers, open service orders created in ERP. Poll cadence: fast registers (service orders, stock) every 1–5 min; slow (items, customers) every 15–60 min; full reconciliation nightly and on sequence reset.

### Outbound (app → ERP), event-driven
- New customer / service item created in field → pushed immediately (with duplicate-check by reg. number / serial before create).
- Service order created in app → pushed on creation, ERP number stored back into `erpRefs`.
- Worksheet → pushed when **Approved** by service manager (not per keystroke): worksheet header + rows (parts with stock location, services, time). Stock consumption posts as the ERP-appropriate stock transaction. Invoice is then created **in the ERP** by existing ERP flows; the adapter reads back invoice number/status for display in the app's service history.
- Attachments: pushed as record links where the ERP supports it; otherwise the app remains the system of record for media and the ERP record carries a deep link into herbe.service.

### Identity & idempotency
- Every app record stores per-ERP `erpRefs {register, uuid/code, seq}`.
- Outbound ops carry the app UUID; adapter must never double-create (lookup by stored ref, then by natural key, then create).
- Field-level mapping tables are configuration, not code: per-tenant register/field maps versioned in the backend, because Standard ERP installations are customized.

### Error handling
- Failed pushes go to a per-tenant dead-letter queue with human-readable reason, surfaced in a back-office "Sync health" screen (count, last success per register, retry button). Silent sync failure is the #1 trust-killer for two-way integrations — this screen is a Phase 1 deliverable, not an afterthought.
- Validation mismatches (ERP rejects a row: closed period, missing account, credit-blocked customer) bounce back as actionable tasks to the service manager, with the worksheet returned to `Done` (not lost).

## Pricing & invoicing boundary

The app shows prices for informational purposes (role-gated); the ERP owns pricing truth. Baseline flow (REST tier only): on worksheet approval the adapter POSTs the record and reads the created record back with ERP-computed prices/VAT. Tenants with WebExcellentAPI get the nicer variant — `windowactions` pre-computes values before posting, so the manager sees final prices at approval time. The app never generates invoices.

## Standalone mode

No adapter configured: numbers issued from app-local series, prices from an app-maintained simple price list on Items, invoicing status features hidden. Enabling an adapter later triggers an initial-load wizard: match customers/items by natural keys, review duplicates, then switch masters per the ownership table in `02-data-model.md`.
