# herbe.service — Competitive Feature Analysis

Status: v0.1 (2026-07-03). Method: web research of vendor sites, official docs and review aggregators (vendor sites partially blocked from the research environment; findings corroborated across sources — details and source lists in [docs/research/](research/)).

Products analyzed: Frontu, Microsoft Dynamics 365 Field Service, Salesforce Field Service, IFS FSM / IFS Cloud Service Management, AllDevice, Odoo Field Service, Acumatica Field Service.

## Product capsules

**Frontu** (LT, ex-Tasker) — technician-first FSM for SMBs, closest to our target segment. Work order pool with technician self-assignment, post-completion admin approval, offline Android app, QR/NFC arrival confirmation per customer object, customer portal, recurring work orders from templates, warehouse add-on with per-technician stock, named ERP connectors + open API. Modular paid add-ons; ~€20–30/user/mo.

**Dynamics 365 Field Service** (~$105/user/mo) — the reference enterprise data model: Work Order → Incident Types (templates bundling tasks, products, services, skills) → Resource Requirement → Booking. Fixed 6-state WO lifecycle + custom substatuses + independent booking statuses. Schedule board with assistant and optimization add-in, truck-as-warehouse with full PO/RMA loop, agreements auto-generating WOs and invoices, IoT alert→WO, Copilot, customer portal with self-scheduling and technician tracking.

**Salesforce Field Service** (~$165–380/user/mo) — cleanest separation of *what* (WorkOrder) from *when/who* (ServiceAppointment); configurable status state machine; scheduling = hard rules + weighted objectives; strongest packaged preventive maintenance (calendar, criteria, and usage/meter-based rules); offline-first mobile with "briefcase" data priming; Appointment Assistant (Uber-style tracking, no-login self-scheduling); AI work summaries.

**IFS FSM** — enterprise best-of-breed for complex service: Request → Scope → Task → Assignment with separate status machines; always-on continuous schedule optimization (PSO); van + 3PL stock, loan/exchange, full RMA/depot repair; contract/SLA entitlement engine; component-level and supplier warranties. Designed to sync standalone to foreign ERPs — validates our peer-system sync approach.

**AllDevice** (EE) — simplicity-focused CMMS, not FSM. Hierarchical device tree, PM by interval / runtime counters / sensor readings with predictive drift of next-service dates, QR label → asset history, min-stock → auto purchase orders, flat pricing, all features in every plan. Gaps: no dispatch, portal, signatures, invoicing — shows where CMMS ends and FSM begins.

**Odoo Field Service** — FSM as a thin extension of Project (and being absorbed into Planning as of 19.2). Intake from sale order/helpdesk/email, Gantt/map views, worksheet templates, signature → instant invoice, van stock as default-warehouse-per-user. **No offline mobile** — its biggest gap and our clearest edge. Single-database "integration": invoice built directly from the linked sale order.

**Acumatica Field Service** — FSM embedded in cloud ERP. Service Order → Appointment(s); order *types* configure workflow and billing target; equipment with component-level warranties; contracts auto-generating PM orders; route optimization + live GPS; **billing cycles** per customer (per appointment / per order / grouped); offline only partial.

## Feature matrix (condensed)

| Domain | Frontu | D365 | SFS | IFS | AllDevice | Odoo | Acumatica | herbe.service |
|---|---|---|---|---|---|---|---|---|
| Offline-first mobile | ✔ (Android) | ✔ | ✔ | ✔ | partial | ✖ | partial | **✔ core requirement** |
| Order vs assignment separation | partial | ✔ | ✔✔ | ✔✔ | ✖ | ✖ | ✔ | ✔ (ServiceOrder/Worksheet/Booking) |
| Dispatch board + map | ✔ | ✔✔ | ✔✔ | ✔✔ | ✖ | ✔ | ✔ | ✔ Phase 2 |
| Route/schedule optimization | ✖ | add-in | ✔✔ | ✔✔ | ✖ | ✖ | ✔ | Phase 4 |
| Van/tech stock | add-on | ✔✔ | ✔ | ✔✔ | ✔ | ✔ | ✔ | ✔ Phase 2 (ERP-backed) |
| Checklists/inspections | ✔ | ✔✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ Phase 1 basic → 2 builder |
| Signature + service report PDF | ✔ | ✔ | ✔✔ | ✔ | ✖ | ✔ | ✔ | ✔ Phase 1 |
| QR/NFC on assets | ✔✔ | ✔ | ✔ | ✔ | ✔✔ | ✖ | ✖ | ✔ Phase 2 |
| Asset/serial service history | ✔ | ✔ | ✔ | ✔✔ | ✔✔ | ✖ | ✔ | ✔ Phase 1, incl. ERP-era history |
| Contracts + recurring PM | ✔ | ✔✔ | ✔✔✔ | ✔✔ | ✔✔ | workaround | ✔✔ | Phase 3 (calendar) → 4 (meter) |
| Customer portal + tracking | ✔✔ | ✔✔ | ✔✔✔ | ✔ | ✖ | ✖ | ✔ | Phase 3 |
| Invoicing | via ERP | built-in | built-in | built-in | ✖ | built-in | built-in ✔✔ | **always in ERP** |
| Two-way sync to foreign ERP | connectors | BC-native | ✖ | ✔✔ | ✖ | ✖ | n/a | **✔✔ core differentiator** |
| AI assist | ✖ | ✔✔ | ✔✔ | ✔✔ | ✖ | ✖ | ✔ | Phase 4 |

## Design decisions taken from this analysis

1. **Adopt the three-document spine** (Salesforce/D365 pattern): ServiceOrder (what), Worksheet (done facts), Booking (when/who). Products that conflate them (Odoo, AllDevice) can't re-plan without corrupting work records.
2. **Incident-type-style templates later, checklist templates first.** D365 Incident Types (bundled tasks+parts+skills per fault type) are powerful but heavy; start with checklist templates per item/work type (Phase 1–2), grow toward work templates (Phase 3).
3. **Configurable status machine, fixed core states** (Salesforce lesson): keep our canonical states, allow tenant substatuses and pause reasons — not free-form workflows.
4. **Technician self-assignment pool** (Frontu) — cheap to build, loved by small teams that don't have a dispatcher.
5. **QR labels on service items** (Frontu + AllDevice): scan → item card, history, start work. Doubles as arrival confirmation. High value/effort ratio.
6. **Offline "briefcase" priming** (Salesforce): explicit "download my work" scope, not lazy caching.
7. **Approval step before invoicing** (Frontu, and our own flow): worksheet Approved is the sync trigger to ERP — matches Acumatica/Odoo's finding that field docs and billing docs must stay separate documents.
8. **Billing cycles stay out**: Acumatica's per-customer billing grouping is exactly the kind of logic that belongs in the ERP, not in us. We only guarantee clean, itemized worksheet data.
9. **PM in three tiers** (Salesforce taxonomy): calendar-based (Phase 3) → criteria/usage-meter (Phase 4, with AllDevice-style predictive drift) → IoT (out of scope until real demand).
10. **Uber-style tracking + self-scheduling** are the current customer-experience bar (SFS Appointment Assistant, D365 portal). Phase 3 delivers the 80%: status notifications, "technician on the way" with ETA, confirm/reschedule links — without live map tracking initially.
11. **Where we win**: the only technician-first, offline-first app with *native, two-way, register-level* Standard ERP / Excellent Books sync — Odoo has no offline, Frontu's connectors are shallow, enterprise suites cost 5–15× more and assume their own ERP.
