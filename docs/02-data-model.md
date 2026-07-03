# herbe.service — Data Model

Status: draft v0.1 (2026-07-03)

The model follows the Standard ERP Service Orders module vocabulary (Service Orders, Work Sheets, Items, Serial Numbers) so that mapping to both ERPs stays close to 1:1, while adding app-side entities the ERPs don't have (bookings, checklists, media, sync metadata).

## Entity overview

```
Customer 1──* Site 1──* ServiceItem
Customer 1──* ServiceOrder 1──* ServiceOrderRow ──> ServiceItem
ServiceOrder 1──* Worksheet 1──* WorksheetRow ──> Item
Worksheet 1──* TimeEntry, 1──* Media, 1──0..1 Signature, 1──* ChecklistResult
Worksheet *──1 User (assignee)
Booking *──1 Worksheet, *──1 User        (planning)
Item 1──* StockLevel *──1 StockLocation  (incl. van stock)
ServiceItem 1──* HistoryEvent            (derived service history)
User 1──* IdentityLink                   (Azure AD, Standard ERP, Excellent Books)
```

## Core entities

### Customer
Synced from ERP (master: ERP). Fields: code, name, reg. number, VAT number, addresses, phones, emails, contact persons, payment terms (read-only), notes, classification. App-side extras: geo-coordinates per address, "call/navigate" quick actions derive from these fields.

### Site (service address)
A customer can have many service locations. Fields: address, geo-point, access instructions (gate codes, keys — visible offline to the assigned technician only), on-site contact. Standard ERP models this loosely (delivery addresses / objects); the app keeps Sites first-class and maps to ERP address rows.

### ServiceItem (the thing being serviced)
The customer's installed equipment, identified by serial number. Fields: serial number, item code (link to Item catalog), make/model, name, customer, site, installation date, warranty start/end, service contract link, meter/counter values, status (active / inactive / replaced), photos, documents (manuals, instructions). Maps to Standard ERP Known Serial Numbers / serviced-item records (register code to confirm per ERP version).

### Item (catalog: spare parts and services)
Synced from ERP register `INVc` (verified in Excellent Books REST API). Two kinds relevant here:
- **Stocked items** (spare parts): tracked per StockLocation, optionally serial-numbered.
- **Service items** (labor/testing/travel): no stock, priced per unit/hour.
Fields: code, name, unit, base price, price lists (`PLVc`), classifiers (`DIVc`), barcode/EAN, default supplier.

### StockLocation & StockLevel
Locations: main warehouse, technician vans (one per field user), supplier/consignment. StockLevel = item × location × quantity (+ reserved). Master for quantities is the ERP; the app caches levels for offline lookup and records consumption/transfer transactions that sync back.

### ServiceOrder
The demand: "customer X needs work on service items A, B". Fields: number (app-local + ERP number after sync), customer, site, contact, description of fault/request, priority, requested/promised dates, status, orderer, salesperson/manager, related contract, rows.
- **ServiceOrderRow**: service item (serial number), reported symptom, requested work type.

Status flow: `New → Accepted → Planned → In progress → Work done → Confirmed → Invoiced → Closed` (+ `Cancelled`). "Invoiced" is set by ERP sync-back, never in the app.

### Worksheet (the work-done fact)
One or more per ServiceOrder; the technician's working document. Fields: service order link, service item(s), assignee, status, planned vs actual time, work description, fault/cause/remedy codes, internal notes, customer-visible notes.
- **WorksheetRow**: item (spare part or service), quantity, stock location it came from, price/discount (visibility role-gated), serial number of the used/replaced part.
- **TimeEntry**: start/stop or manual; type (work / travel / waiting); normal vs overtime; feeds both invoicing and payroll-side reporting.
- **ChecklistResult**: filled form instance (see ChecklistTemplate), incl. measured values / test results with pass/fail bounds.
- **Media**: photos (before/after tags), documents, short video/audio notes; EXIF time+geo kept.
- **Signature**: customer name, signature image, timestamp, geo-point; locks the worksheet content it signs.

Status flow: `Draft → Assigned → Accepted → In progress → Paused (reason: parts/access/other) → Done → Approved → Synced/Invoiced` (+ `Rejected` back to technician with comment).

### Booking (planning)
Scheduling wrapper: worksheet (or service order) × technician × time window, with all-day/estimate flags. Kept separate from Worksheet so a job can be re-planned or split across days without touching the work facts. This is what the dispatch board and technician calendar render.

### ChecklistTemplate
Reusable forms attached by item type, work type, or customer contract: sections, field types (bool, number with min/max, text, photo-required, selection), required-on-completion flags. Versioned; results always reference the template version.

### HistoryEvent (service history)
Denormalized, append-only view per ServiceItem and per Customer: every completed worksheet, part replacement, measurement, status change. Built server-side from synced facts (including pre-app history imported from the ERP) so the technician sees full history offline even for work done directly in ERP.

### User, Role, IdentityLink
See `05-users-auth.md`. Users are app-local; IdentityLink rows connect a user to Microsoft Entra ID (OIDC subject), a Standard ERP person (`EmplVc`-style code), and/or an Excellent Books employee.

## Sync metadata (on every synced entity)
- `id` — client-generated UUID (idempotency key)
- `erpRefs[]` — per-ERP: register, record id/UUID, last known `@sequence`
- `syncState` — `local / pending / synced / conflict`
- `updatedAt`, `updatedBy`, `deletedAt` (tombstone)
- `origin` — `app / standard-erp / excellent-books`

## Master-data ownership

| Entity | Master | App may edit? |
|---|---|---|
| Customers, Items, Price lists | ERP | create-new + limited fields (phones, geo, notes), synced back |
| Stock levels | ERP | via stock transactions only |
| Service items | shared | yes (two-way) |
| Service orders | shared | yes (two-way) |
| Worksheets, time, media, checklists, signatures | app | yes; pushed to ERP on approval |
| Invoices | ERP | never — read-only status back-link |
| Users, roles, bookings, checklist templates | app | yes; not synced to ERP |
