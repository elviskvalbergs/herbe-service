# herbe.service — Data Model

Status: v0.7 (2026-07-06, + work/travel segments with return-after-done, from a real Frontu↔Standard ERP customer request). Previous: v0.6 (2026-07-06, owner decisions — round 4: manual `Work done`/`Confirmed` order transitions, per-row **charge type** (invoiceable/warranty/contract/goodwill), per-row **service-item attribution**, work-entry modes, re-sign as manager judgment). Previous: v0.5 (2026-07-05, review round 3 — `16-spec-review-round-3.md`: billing adjustments & correction worksheets, media-completeness approval gate, order-cancellation cascade, inbound-crew lead rule, negative stock, customer-facing numbering, `labelId`, `enRoute`/ETA, CustomerFeedback). Previous: v0.4 — merge of the two spec lines (see `10-spec-review-gaps.md`): the audit line's tree/lot/coverage model, **team jobs (lead + members)**, DistanceEntry, field policies and DocumentTemplate folded into the reviewed v0.2 base (company scoping, Contact-as-CUVc, booking statuses, order derivation, signature revision rule). Crew decision per product owner 2026-07-05: **multi-person is the primary mode**.

The model follows the Standard ERP / Excellent Books Service Orders module vocabulary (Service Orders, Work Sheets, Items, Serial Numbers — same product, same registers) so that ERP mapping stays close to 1:1, while adding app-side entities the ERP doesn't have (bookings, checklists, media, sync metadata).

## Entity overview

```
Customer 1──* Site 1──* ServiceItem (tree: parent link; kind: system|unit|lot)
ServiceItem *──1 ItemModel ──* PartCompatibility ──> Item
Customer 1──* ServiceOrder 1──* ServiceOrderRow ──> ServiceItem (any node + coverage)
ServiceOrder 1──* Worksheet 1──* WorksheetRow ──> Item, ──> ServiceItem (row attribution)
Worksheet *──1 User (lead), 1──* WorksheetMember ──> User   (team jobs)
Worksheet 1──* TimeEntry, 1──* DistanceEntry, 1──* Media, 1──0..1 Signature, 1──* ChecklistResult
Booking *──1 ServiceOrder, *──0..1 Worksheet, *──1 User   (planning; one booking per
                                          technician, crew bookings share a crewGroupId)
Item 1──* StockLevel *──1 StockLocation  (incl. van stock)
ServiceItem 1──* HistoryEvent            (derived service history)
ServiceOrder 1──* CustomerFeedback       (portal-submitted, Phase 3)
User 1──* IdentityLink                   (Standard ERP / Excellent Books person code,
                                          optionally Entra ID / eID)
```

## Company scoping

A **tenant** (customer of ours; on the shared SaaS deployment or a dedicated one — `03-architecture.md` tenancy) holds one or more **ERP company connections** (portal `erp_companies` model; clarified 2026-07-04). Every domain entity carries `tenant_id`; every ERP-derived or ERP-synced entity — customers, contacts, sites, service items, items, stock, orders, worksheets, bookings, history — carries `erp_company_id`. Companies are fully separate data scopes: no sharing, no merging, no cross-company lookups. Users can have access to several companies and switch context; the active company scopes every list and search. Standalone tenants get one implicit local company; if an ERP connection is enabled later, that implicit company is **bound to the connection** (one-way, irreversible) — existing records keep their `erp_company_id`, nothing is re-stamped (see `04-erp-sync.md` standalone section). Users, roles, checklist templates, document templates and field policies are tenant-level, not company-level.

## Core entities

### Customer & Contact
Synced from ERP (master: ERP). In both target ERPs, customers **and** contact persons live in the same Contacts register (`CUVc`, distinguished by flags), with contact↔customer relations in `ContactRelVc` — verified against the herbe.portal adapter (`lib/erp/standard-books/registers/contacts.ts`, `relations-and-users.ts`). The app models them the same way: **Contact** is first-class, related to one or more Customers, not a field list on Customer.

Customer fields: code, name, reg. number, VAT number, addresses, phones, emails, payment terms (read-only), notes, classification. Contact fields: code, name, phone, email, role, linked customer(s). App-side extras: geo-coordinates per address; "call/navigate" quick actions derive from these fields.

### Site (service address)
A customer can have many service locations. Fields: address, geo-point, access instructions (gate codes, keys — visible offline to the assigned technician only), on-site contact. Standard ERP models this loosely (delivery addresses / objects); the app keeps Sites first-class and maps to ERP address rows.

### ServiceItem (the thing being serviced)
The customer's installed equipment — a **tree, not a flat list** (full design: `11-service-items-and-parts.md`). Nodes have `parentId`, materialized `path`, `kind` (`system` grouping/zone node, `unit` serialized asset, `lot` counted group of like items with `quantity`), a link to the **ItemModel** registry (what it is), and `positionCode` (tenant numbering). Unit fields: serial number, installation date, warranty start/end, service contract link, meter/counter values, status (active / inactive / replaced), photos, documents. Every node additionally carries a **`labelId`** — a stable, non-guessable identifier minted at node creation, printed into QR labels (Phase 2) and resolved by one login-routed resolver URL (`08-suite-integration.md` §4a); it survives serial-number corrections and node moves, so stickers outlive data fixes. Orders/worksheets may target any node; group-level rows carry **coverage** (`all` / `n of m` / list / exceptions) and history projects down to covered descendants. Only `unit` nodes map to the ERP serial register (Known Serial Numbers — register code to confirm per ERP version); the tree itself is app-owned. Phase 1 ships `system`/`unit` nodes (flat is a degenerate tree — no later migration); `lot` + coverage arrive Phase 2.

### ItemModel (what a service item is)
Make/model/category registry with per-category attributes, documents, and default checklist template. Referenced by ServiceItems and by **PartCompatibility** (`model × catalog part × role × qty`) and alternative-item groups (equivalence + supersession) — the machinery behind "parts that fit this machine" and automatic substitute offering. App-owned; seedable from ERP classifiers. Details: `11-service-items-and-parts.md`.

### Item (catalog: spare parts and services)
Synced from ERP register `INVc` (verified in Excellent Books REST API). Two kinds relevant here:
- **Stocked items** (spare parts): tracked per StockLocation, optionally serial-numbered.
- **Service items** (labor/testing/travel): no stock, priced per unit/hour.
Fields: code, name, unit, base price, price lists (`PLVc`), classifiers (`DIVc`), barcode/EAN, default supplier.

### StockLocation & StockLevel
Locations: main warehouse, technician vans (one per field user), supplier/consignment. StockLevel = item × location × quantity (+ reserved). Master for quantities is the ERP; the app caches levels for offline lookup and records consumption/transfer transactions that sync back.

**Offline contention rule (owner, 2026-07-05):** there is no hard reservation — two offline technicians may both consume the last unit. Cached levels may therefore go **negative**; a negative level (or an ERP-rejected stock transaction) raises a reconciliation task in sync health instead of blocking the technician. Serial-numbered parts double-issued offline surface the same way (the second consumption of one serial is a conflict task, never a silent overwrite). The `reserved` component is informational (planned usage from bookings' expected parts), not an enforcement mechanism.

### ServiceOrder
The demand: "customer X needs work on service items A, B". Fields: number (app-local + ERP number after sync — **customer-facing surfaces show the ERP number once synced, the app number before; the shown number never changes retroactively** except for that one app→ERP switch, which is announced in the portal/order events), customer, site, contact, description of fault/request, priority, requested/promised dates, status, orderer, salesperson/manager, related contract, **default charge type** (below), rows.
- **ServiceOrderRow**: service item node (unit, lot or system — group rows carry coverage), reported symptom, requested work type.

Status flow: `New → Accepted → Planned → In progress → Work done → Confirmed → Invoiced → Closed` (+ `Cancelled`). "Invoiced" is set by ERP sync-back, never in the app.

**Transition rules (owner, 2026-07-06: the two decision states are manual; the in-flight states derive).** The order's arc is human judgment at both ends — the technician decides when the *job* is done (not just their worksheet), the manager decides when it is ready for invoicing:
- `Planned` — derived: at least one booking exists for the order.
- `In progress` — derived: any worksheet is `In progress` or `Paused`.
- `Work done` — **manual, by the technician** (normally the lead): an explicit "job done" action on the order, prompted when they set their (last open) worksheet to `Done` but never forced — worksheets done ≠ job done (a return visit may be known needed). This is the signal the manager watches for: orders in `Work done` are the review queue — check the worksheets, adjust billing, add documents, prepare for invoicing.
- `Confirmed` — **manual, by the manager**: "reviewed, ready to invoice". Requires all worksheets `Approved` (approving the last one prompts the confirm, doesn't perform it).
- `Invoiced` — invoice back-link received from ERP.
- Adding a new worksheet/booking to a `Work done`/`Confirmed` order rolls it back to the matching derived state. Derived states are recomputed server-side on every worksheet/booking transition; manual states are guarded by the same server-side machine (offline "job done" taps replay through the outbox like any transition).
- Per-tenant/work-type **automation hooks** (auto-`Work done` when all worksheets Done, auto-`Confirmed` on last approval) are a future workflow-configuration feature, off by default — the manual flow is the product baseline.
- **Cancellation cascade**: `Cancelled` is allowed only while no worksheet is beyond `Accepted` — otherwise the transition is blocked with the list of live work (finish or cancel the worksheets first, same pattern as field-policy blocks). Cancelling auto-cancels the order's open bookings (ERP-activity handling per `04-erp-sync.md` — the activity is voided in place, not deleted, on REST-only connections) and its `Draft/Assigned/Accepted` worksheets, with an inbox notice to affected technicians. `Closed` requires all worksheets terminal (`Synced`, `Rejected`-resolved, or cancelled).

### Worksheet (the work-done fact)
One or more per ServiceOrder; the working document of a **job**. Fields: service order link, service item node(s), **lead** (responsible technician), **members** (the rest of the crew on a team job — every member can execute: add rows, time, media, checklist values), status, planned vs actual time, work description, fault/cause/remedy codes, internal notes, customer-visible notes. **One worksheet per job, not per person**: a two-technician boiler replacement is one document with two members, not two documents to reconcile. Status transitions (complete, sign) belong to the lead; a member's contributions are attributed (`addedBy` on rows/media).
- **WorksheetRow**: item (spare part or service), quantity, stock location it came from — **the member's own van or another location**, price/discount (visibility role-gated), serial number of the used/replaced part, `addedBy`, **service item node** (row attribution, below), **charge type** (override of the worksheet default, below).
- **TimeEntry**: **per member** (`userId`): start/stop or manual; type (work / travel / waiting), travel entries additionally carry **direction** (`toSite` / `return`); normal vs overtime; feeds both invoicing (all members' hours are billable lines) and payroll-side reporting per person. Start/stop cycles produce discrete entries — **work segments**: pausing at 10:45 and resuming at 16:34 is two work entries, not one edited entry; the segment boundaries are facts (they drive the segment activities in `04-erp-sync.md` and the actual-time reporting a customer sees). **Return travel after "job done" is first-class** (customer-driven, 2026-07-06): a `travel/return` entry may start after the worksheet is `Done` and attaches to it until `Approved` — the technician completes on site, drives back, and the trip still lands on the right worksheet with zero extra taps; delivery to server/ERP is the ordinary outbox, so nothing depends on the technician "sending" anything. A segment left running is auto-stopped at a per-tenant cutoff (e.g. 20:00) and flagged for review, never silently extended overnight.
- **DistanceEntry**: **per member**, driven kilometers for the job — entered directly after the job *or* as odometer before/after (distance computed); `billable` flag decides whether it becomes a travel-item worksheet row at approval (travel item mapping in adapter config) or stays a cost record. Optional feature per tenant; can be made a required field via field policies (below). Future: computed from a routing/telematics API — the entry stays the same, only its source changes.
- **ChecklistResult**: filled form instance (see ChecklistTemplate), incl. measured values / test results with pass/fail bounds.
- **Media**: photos (before/after tags), documents, short video/audio notes; EXIF time+geo kept.
- **Signature**: customer name, signature image, timestamp, geo-point; locks the worksheet content it signs.
- **CustomerConfirmation** (0..1, Phase 3): remote confirmation of the finished work/report — `{method: portal_confirm | esign, confirmedBy, confirmedAt, signedFileMediaRef?}`. Written only by the herbe.portal signoff callback (`08-suite-integration.md` §4 — all remote customer interaction lives in the portal, owner decision 2026-07-05); the on-site canvas Signature remains the no-portal baseline. Shown in history and on the report. Where the tenant has WebExcellentAPI, the signed file also attaches to the booking's ERP activity as a record link.

**Charge type (owner, 2026-07-06).** Every worksheet row is one of **`invoiceable` / `warranty` / `contract` / `goodwill`** — this is what tells the ERP what to bill. The default cascades: set on the **ServiceOrder** (suggested from context: linked contract → `contract`; targeted unit inside warranty → `warranty`; else `invoiceable`), inherited as the **Worksheet** default, overridable on **each row** (a warranty repair can still have an invoiceable extra). Technicians see and can set it per row (field-policy-gated); the manager reviews it at approval like prices. It maps directly to the ERP worksheet's chargeable/warranty handling so invoicing excludes non-chargeable rows natively — exact field mapping per `04-erp-sync.md` (Phase 0 confirm). Non-invoiceable rows still post stock consumption (the part physically left the van) and still appear in history and on the customer report (marked, e.g. "warranty — no charge").

**Service-item row attribution (owner, 2026-07-06).** A worksheet may cover several service item nodes, so **every WorksheetRow carries the node it belongs to** — auto-filled when the worksheet targets a single node, picked from the worksheet's nodes otherwise (field policy can hard-require it; group rows may attribute to a `system`/`lot` node with coverage). ChecklistResults are attributed the same way (a checklist instance runs against a node); Media attribution is optional but offered at capture. This is what keeps per-serial history truthful — the HistoryEvent projector uses row attribution, not worksheet-level guessing. TimeEntry stays per member per worksheet (labor is job-level; splitting minutes per node is bookkeeping nobody does honestly).

Status flow: `Draft → Assigned → Accepted → In progress → Paused (reason: parts/access/other) → Done → Approved → Synced` (+ `Rejected` back to technician with comment). Invoicing status is tracked on the ServiceOrder (ERP back-link), not on the worksheet.

**Signature lock vs. rejection/correction (refined by owner, 2026-07-06).** A signature freezes the worksheet content it signed. If a manager rejects a signed worksheet, or the ERP bounces it (closed period, missing account), corrections happen as a **new revision**: the signed revision is kept immutable in history and the worksheet reopens for editing. Whether the correction warrants a **re-signature is the manager's call**: the system diffs the revisions, flags customer-visible changes (rows, quantities, work description) and recommends re-signing, but the manager decides — "ask re-sign" (worksheet returns to the technician/portal for signature) or "proceed on the existing signature" (audited, both revisions visible side by side). Metadata fixes the customer never sees (account codes, internal notes, stock location corrections) don't trigger the recommendation at all. Once the manager approves — "all good" — the worksheet is immutable; anything discovered later goes through the correction-worksheet path below.

**Billing adjustments & post-sync corrections (owner, 2026-07-05).** The signed content and the billed content are allowed to differ: at approval the manager may adjust billable quantities/prices/discounts as a **billing-adjustment layer** on top of the signed snapshot — the customer-signed facts stay immutable, the report renders the signed content, the ERP push carries the adjusted rows, and both layers are visible side by side in the worksheet history. Mistakes discovered **after** `Synced` (wrong part booked, ERP already invoiced) are never fixed by editing: a **correction worksheet** is created under the same order (referencing the original), goes through the same approve/push cycle, and the ERP handles the financial correction by its own means (credit note etc.) — mirroring `04-erp-sync.md`'s "flag, don't delete" rule on the app side.

**Media-completeness gate.** Photos/signature blobs upload separately from the ops that reference them (`03-architecture.md`), so a worksheet can be `Done` server-side while media is still queued on the device. The approval screen shows per-worksheet media upload state; **Approve is blocked while referenced media is missing**, with an audited manager override ("approve without N pending photos" — a dead phone must not block invoicing forever). The report PDF renders only present media and is regenerated when waived media arrives later.

**Crew & reassignment.** The lead is set when the worksheet is created (from the booking's technician, or picked by the dispatcher); for worksheets born from an **inbound crew activity** (ERP/calendar-created, `04-erp-sync.md`) the lead defaults to the activity's main person (`MainPerson`) — if that person has no linked user, the first identity-linked member becomes lead and sync health warns. Members are kept in sync with the job's crew bookings (below). Reassigning a member's booking updates the members list; changing the **lead** is an explicit manager/team-lead action. From `Accepted` onward, crew changes are recorded (who joined/left, when) so time attribution stays truthful.

### Booking (planning)
Scheduling wrapper: service order (optionally a specific worksheet) × **one technician** × time window, with all-day/estimate flags. Kept separate from Worksheet so a job can be re-planned or split across days without touching the work facts. This is what the dispatch board and technician calendar render.

- A booking always references a ServiceOrder; the worksheet link is optional (planning can precede worksheet creation). When a technician accepts/starts a booking that has no worksheet yet, the app creates one (status `Assigned`, lead = that technician) and links it.

**Work-entry modes (owner, 2026-07-06 — companies work differently; all three are supported, none is configuration):**
1. **Booking-first**: the technician follows dispatch — opens the booking, worksheet is created on accept/start (the rule above). The booking shows everything the worksheet would (order, site, service items, history shortcut) — it *is* the job card until execution starts; only stock, checklists and time capture live on the worksheet.
2. **Worksheet-prepared-ahead**: office creates the worksheet before the visit (e.g. the day before) to preload documents, checklists and expected parts to pick up; the booking links to it. The technician opens the same job and continues on the prepared worksheet.
3. **Walk-up, no booking**: the technician looks up (or creates) a customer, creates order + worksheet on the spot and starts working — no booking ever exists. Booking-less worksheets appear in the technician's Today/Jobs views alongside bookings (`07-ui-screens.md` F1/F2) and reach the ERP/calendar via the worksheet's shadow activity (`04-erp-sync.md` activity-purpose map), so dispatch still sees reality.
The engine treats these as one model — booking optional, worksheet created at whichever moment fits the tenant's way of working.
- Status: `planned → confirmed → cancelled` (+ `rescheduled` recorded as cancel-and-recreate with a link). Execution progress (on site, done) lives on the Worksheet/TimeEntry — with one exception: the booking carries **`enRoute` + `etaMinutes`**, set by the technician's explicit "On my way" tap (+ static route estimate) and cleared on work start. These feed the "technician on the way" notification and the portal ETA view (`08-suite-integration.md` §4); fields exist from the Phase 2 schema/API, the UI action ships Phase 3.
- Times are stored **UTC + explicit site/tenant timezone** (herbe.calendar's `booked_utc`/`host_timezone` lesson); the adapter converts to/from ERP-local date+time at the boundary using the connection's timezone config.

**Team jobs**: a crew on one job = one booking *per technician*, sharing a `crewGroupId`. The dispatch board moves the group as one (or detaches a member — e.g. the apprentice leaves at lunch: split their booking, others unchanged). Different members can have different windows on the same job. All crew bookings point at the same worksheet, whose members list stays in sync with the bookings.

Bookings sync two-way with ERP **Activities (`ActVc`)** — the same register in Standard ERP and Excellent Books (one product family; herbe.calendar reads and writes it over plain REST in production). The mapping is richer than a calendar entry — full detail incl. **multi-person crew activities as the primary mode**, workflow-stage mirror, native Service Order / Service Item fields, two-way notes, record links and echo suppression: `04-erp-sync.md` "Booking ↔ Activity mapping". Activities created/moved in the ERP for the mapped activity types flow back as bookings.

### DocumentTemplate & GeneratedDocument
Tenant-defined DOCX mail-merge templates per document type (worksheet report, order confirmation, compliance certificate…), with selection rules and number series; generated documents are immutable, versioned Media records linked to their root entity and the service item nodes they certify. Full design: `12-documents-templates.md`.

### ChecklistTemplate
Reusable forms attached by item type, work type, or customer contract: sections, field types (bool, number with min/max, text, photo-required, selection), required-on-completion flags. Versioned; results always reference the template version.

### Contract (service contract / agreement)
Referenced from Phase 1 (`ServiceOrder.relatedContract`, `ServiceItem.serviceContractLink` — nullable until Phase 3), built as a feature in Phase 3. Fields: customer, covered service item nodes (subtree references — coverage view in `11-service-items-and-parts.md`), response-time terms, price-rule reference (informational; the ERP owns pricing), validity period, recurring-service rules (calendar-based generation, horizon). Ownership: app-owned initially; both ERPs have a service-contracts register — whether to sync (and which direction) is a Phase 0 "confirm" item in the `04-erp-sync.md` register table.

### HistoryEvent (service history)
Denormalized, append-only view per ServiceItem node and per Customer: every completed worksheet, part replacement, measurement, status change — with group-level events **projected** to covered descendants and rolled up to ancestors (`11-service-items-and-parts.md`).

**Production rules** (the projector is a first-class Phase 1 component, not an afterthought): events are emitted (a) on worksheet status transitions server-side, (b) on ERP-poll ingest of historical/foreign records (pre-app history import, work done directly in ERP), and (c) on service item status changes. Every event carries a deterministic key (source record id + event type + revision) so re-running the projector is idempotent; a full rebuild per company is an admin action (`07-ui-screens.md` A8). Events ship to devices through the normal `changeSeq` delta feed.

### CustomerFeedback (Phase 3)
Satisfaction feedback per order: `order × portal user`, rating (1-tap scale) + optional comment, written only through `POST /api/ext/v1/orders/{id}/feedback` (idempotent — resubmission updates). Rendered read-only in the portal once given; feeds Phase 3 reporting (satisfaction per technician/customer/period). No in-service customer UI (owner decision 2026-07-05 — the portal is the only customer surface).

### User, Role, IdentityLink
See `05-users-auth.md`. Users are app-local; IdentityLink rows connect a user to a Standard ERP / Excellent Books person (`EmplVc`-style code) and/or (optionally, net-new for the suite) a Microsoft Entra ID subject or eID.

## Field policies (hidden / optional / required)

Whether a field is shown, editable, or mandatory is **tenant configuration, not code** — the DistanceEntry question ("optional here, mandatory there") generalizes:

- **FieldPolicy**: entity/form × field × state (`hidden / read-only / optional / required`) × scope (**role**, and where relevant **work type**). Example rows: *DistanceEntry.km required for technicians on work type "on-site"*, *WorksheetRow.price hidden for technicians*, *fault/cause/remedy required for managers at approval*.
- **Enforcement at status transitions**, not per keystroke (offline-friendly): `required` blocks the transition it is bound to (technician can't set *Done* without km; manager can't *Approve* without remedy code) with a clear list of what's missing. Client enforces for UX, server enforces for truth — same state machine as `03-architecture.md` conflicts.
- Defaults ship sensible (everything optional beyond the structural minimum); policies live in tenant settings, travel in settings export/import (`04-erp-sync.md`), and are edited in admin alongside checklist templates — the same "required-on-completion" idea, applied to the built-in forms.
- Deliberately **not** a form builder: fields are the spec'd ones; policies only tune visibility/necessity. Custom fields, if ever, are a separate later decision.

## Sync metadata (on every synced entity)
- `id` — client-generated UUID (idempotency key)
- `erpRef` — for the record's company connection: register, record id/UUID, last known `@sequence` (the connection itself is fixed by `erp_company_id`)
- `syncState` — `local / pending / synced / conflict`
- `updatedAt`, `updatedBy`, `deletedAt` (tombstone)
- `origin` — `app` or the connection id it arrived from (adapter-agnostic; not an enum of ERP products, so new adapters need no schema change)

## Record merges (field-created duplicates)

When back office merges a field-created provisional record into an existing one (`07-ui-screens.md` O7), the merge must survive offline replicas that still hold the old UUID:

- A server-side **alias row** (`oldId → survivingId`, permanent) is written; all server FKs re-point to the survivor in the same transaction.
- The delta feed ships a **tombstone-with-redirect** for the old id; clients re-point local FKs and drop the provisional record.
- Queued outbox ops still referencing the old id are rewritten through the alias table at ingest — never rejected.
- History events of the provisional record re-attach to the survivor via the projector (deterministic keys make this idempotent).

## Master-data ownership

| Entity | Master | App may edit? |
|---|---|---|
| Customers, contacts, Items, Price lists | ERP | create-new + limited fields (phones, geo, notes), synced back |
| Stock levels | ERP | via stock transactions only |
| Service items: `unit` nodes (serials) | shared | yes (two-way, flat serial register) |
| Service item tree, `system`/`lot` nodes, coverage | app | yes; never pushed to ERP (`11-service-items-and-parts.md`) |
| ItemModel registry, part compatibility, alternatives | app | yes; seedable from ERP classifiers |
| Service orders | shared | yes (two-way) |
| Contracts | app (ERP sync = Phase 0 confirm) | yes |
| Worksheets, time, distance, media, checklists, signatures | app | yes; pushed to ERP on approval |
| Invoices | ERP | never — read-only status back-link |
| Bookings | app | yes; mirrored two-way as ERP Activities (`ActVc`) |
| Users, roles, checklist templates, field policies | app | yes; not synced to ERP |
| Document templates, generated documents | app | yes; finished PDFs attach to ERP records as links (`12-documents-templates.md`) |
