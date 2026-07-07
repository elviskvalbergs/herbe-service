# herbe.service — Competitive Feature Analysis

Status: v0.3 (2026-07-07). Change: design decision 3 corrected — tenant substatuses marked deferred (Phase-4 candidate), not adopted; they appeared nowhere in the data model/roadmap/UI docs. Previous: v0.2 (2026-07-03). Method: web research of vendor sites, official docs and review aggregators; v0.2 re-verified pricing and key claims directly against live vendor pages and official docs (Microsoft Learn, salesforce.com, odoo.com release notes) — corrections marked inline, details and source lists in [docs/research/](research/).

Products analyzed: Frontu, Microsoft Dynamics 365 Field Service, Salesforce Field Service, IFS FSM / IFS Cloud Service Management, AllDevice, Odoo Field Service, Acumatica Field Service.

## Product capsules

**Frontu** (LT, ex-Tasker) — technician-first FSM for SMBs, closest to our target segment. Work order pool with technician self-assignment, post-completion admin approval, offline Android app, QR/NFC arrival confirmation per customer object (scanning can be made mandatory), customer portal (PWA), recurring work orders from templates, warehouse add-on with per-technician stock, named ERP connectors (Business Central, Odoo, Horizon, Rivile, Directo, HansaWorld…) + open API. Pricing corrected v0.2 from live pricing page: **€39–49/seat/mo annual (€51–64 monthly) + mandatory €999/yr platform fee** and paid add-ons — materially pricier than the €20–30 aggregators still show. Portal scope: request intake with attachments, live status, remote confirmation/rating/signature — but **no invoice visibility and no browsable equipment register with per-asset history**.

**Dynamics 365 Field Service** ($105/user/mo, verified; Contractor $50, scheduling-optimization add-on $30/resource) — the reference enterprise data model: Work Order → Incident Types (templates bundling tasks, products, services, skills) → Resource Requirement → Booking. Fixed 6-state WO lifecycle + custom substatuses + independent booking statuses. Schedule board with assistant and optimization add-in, truck-as-warehouse with full PO/RMA loop, agreements auto-generating WOs and invoices, IoT alert→WO, Copilot. Customer portal (Power Pages template): asset + incident-type self-scheduling, reschedule/cancel, technician tracking — but self-scheduling is *still in preview* (Oct 2025 docs) and the 2025–26 release waves add nothing portal-side; Microsoft's investment is dispatcher AI (Scheduling Operations Agent, preview 06/2025).

**Salesforce Field Service** — now sold as **Agentforce Field Service**; verified pricing: Dispatcher/Technician $175, Field Service Plus $230, Agentforce 1 edition $650/user/mo (contractor tiers $55–80). Cleanest separation of *what* (WorkOrder) from *when/who* (ServiceAppointment); configurable status state machine; scheduling = hard rules + weighted objectives; strongest packaged preventive maintenance (calendar, criteria, and usage/meter-based rules); offline-first mobile with "briefcase" data priming; Appointment Assistant — Uber-style live tracking + no-login self-scheduling — is a **$25/user/mo add-on**, not baseline; Agentforce chat booking/rescheduling GA since mid-2025 ($125/user add-on).

**IFS FSM** — enterprise best-of-breed for complex service: Request → Scope → Task → Assignment with separate status machines; always-on continuous schedule optimization (PSO); van + 3PL stock, loan/exchange, full RMA/depot repair; contract/SLA entitlement engine; component-level and supplier warranties. Designed to sync standalone to foreign ERPs — validates our peer-system sync approach.

**AllDevice** (EE) — simplicity-focused CMMS, not FSM. Hierarchical device tree, PM by interval / runtime counters / sensor data (via integrations such as GlobalReader, not native ingest) with average-usage forecasting of next-service dates, QR label → asset history, min-stock → auto purchase orders; pricing verified: user-count tiers €200/mo (5 users) to €1250/mo unlimited, "all plans include full functionality". Gaps: no dispatch, portal, signatures, invoicing — shows where CMMS ends and FSM begins.

**Odoo Field Service** — FSM as a thin extension of Project; **discontinued as a separate app in 19.2, absorbed into Planning** (verified, release notes). Intake from sale order/helpdesk/email, Gantt/map views, worksheet templates, signature → instant invoice, van stock as default-warehouse-per-user. Offline: **corrected v0.2** — no offline through Odoo 18; Odoo 19 added a generic cache-based offline mode (view previously opened records; 19.3 adds offline edit/create for records previously opened online, hard refresh wipes cache). Still not offline-first: a technician's *new* day of work must be opened online first — our edge narrows but holds. Customer portal: tasks, quotations, invoices, signed reports — but **no native customer-visible equipment registry** (OCA/third-party modules only). Single-database "integration": invoice built directly from the linked sale order.

**Acumatica Field Service** — FSM embedded in cloud ERP. Service Order → Appointment(s); order *types* configure workflow and billing target; equipment with component-level warranties; contracts auto-generating PM orders; **billing cycles** per customer (per appointment / per order / grouped — verified, form FS206000). Corrected v0.2: route optimization is a WorkWave *connector* whose support is frozen at 2023 R2 and no longer advertised; and the native mobile app has **no field-service offline mode at all** — offline entry exists only via third-party ISV apps (OrangeKloud, Jigx).

## Feature matrix (condensed)

| Domain | Frontu | D365 | SFS | IFS | AllDevice | Odoo | Acumatica | herbe.service |
|---|---|---|---|---|---|---|---|---|
| Offline-first mobile | ✔ (Android) | ✔ | ✔ | ✔ | partial | cache-based (19.3) | ✖ (ISV only) | **✔ core requirement** |
| Order vs assignment separation | partial | ✔ | ✔✔ | ✔✔ | ✖ | ✖ | ✔ | ✔ (ServiceOrder/Worksheet/Booking) |
| Dispatch board + map | ✔ | ✔✔ | ✔✔ | ✔✔ | ✖ | ✔ | ✔ | ✔ Phase 2 |
| Route/schedule optimization | ✖ | add-in | ✔✔ | ✔✔ | ✖ | ✖ | legacy connector | Phase 4 |
| Van/tech stock | add-on | ✔✔ | ✔ | ✔✔ | ✔ | ✔ | ✔ | ✔ Phase 2 (ERP-backed) |
| Checklists/inspections | ✔ | ✔✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ Phase 1 basic → 2 builder |
| Signature + service report PDF | ✔ | ✔ | ✔✔ | ✔ | ✖ | ✔ | ✔ | ✔ Phase 1 |
| QR/NFC on assets | ✔✔ | ✔ | ✔ | ✔ | ✔✔ | ✖ | ✖ | ✔ Phase 2 |
| Asset/serial service history | ✔ | ✔ | ✔ | ✔✔ | ✔✔ | ✖ | ✔ | ✔ Phase 1, incl. ERP-era history |
| Contracts + recurring PM | ✔ | ✔✔ | ✔✔✔ | ✔✔ | ✔✔ | workaround | ✔✔ | Phase 3 (calendar) → 4 (meter) |
| Customer portal + tracking | ✔ (no invoices/assets) | ✔✔ (self-sched. in preview) | ✔✔✔ ($25 add-on) | ✔ | ✖ | ✔ (no assets) | ✔ | Phase 3 via herbe.portal |
| Invoicing | via ERP | built-in | built-in | built-in | ✖ | built-in | built-in ✔✔ | **always in ERP** |
| Two-way sync to foreign ERP | connectors | BC-native | ✖ | ✔✔ | ✖ | ✖ | n/a | **✔✔ core differentiator** |
| AI assist | ✖ | ✔✔ | ✔✔ | ✔✔ | ✖ | ✖ | ✔ | Phase 4 |

## Design decisions taken from this analysis

1. **Adopt the three-document spine** (Salesforce/D365 pattern): ServiceOrder (what), Worksheet (done facts), Booking (when/who). Products that conflate them (Odoo, AllDevice) can't re-plan without corrupting work records.
2. **Incident-type-style templates later, checklist templates first.** D365 Incident Types (bundled tasks+parts+skills per fault type) are powerful but heavy; start with checklist templates per item/work type (Phase 1–2), grow toward work templates (Phase 3).
3. **Configurable status machine, fixed core states** (Salesforce lesson): keep our canonical states and pause reasons (both in the spec, `02-data-model.md`) — not free-form workflows. Tenant substatuses are **deferred, not adopted** (corrected 2026-07-07): a Phase-4 candidate alongside the workflow-configuration/automation-hooks era (`06-roadmap.md`), currently specced nowhere.
4. **Technician self-assignment pool** (Frontu) — cheap to build, loved by small teams that don't have a dispatcher.
5. **QR labels on service items** (Frontu + AllDevice): scan → item card, history, start work. Doubles as arrival confirmation. High value/effort ratio.
6. **Offline "briefcase" priming** (Salesforce): explicit "download my work" scope, not lazy caching.
7. **Approval step before invoicing** (Frontu, and our own flow): worksheet Approved is the sync trigger to ERP — matches Acumatica/Odoo's finding that field docs and billing docs must stay separate documents.
8. **Billing cycles stay out**: Acumatica's per-customer billing grouping is exactly the kind of logic that belongs in the ERP, not in us. We only guarantee clean, itemized worksheet data.
9. **PM in three tiers** (Salesforce taxonomy): calendar-based (Phase 3) → criteria/usage-meter (Phase 4, with AllDevice-style predictive drift) → IoT (out of scope until real demand).
10. **Uber-style tracking + self-scheduling** are the current customer-experience bar (SFS Appointment Assistant, D365 portal) — but both charge for it ($25/user add-on at Salesforce) and D365's portal has stalled in preview while vendor investment shifts to dispatcher-side AI agents. Phase 3 delivers the 80%: status notifications, "technician on the way" with ETA, confirm/reschedule links — without live map tracking initially.
11. **Where we win**: the only technician-first, offline-first app with *native, two-way, register-level* Standard ERP / Excellent Books sync. Odoo's offline is a cache bolt-on (19.3). Frontu does list a HansaWorld connector — but as a paid integration layer on top of a €39–64/seat + €999/yr platform, not a data model designed around the ERP's registers, and with no suite calendar/portal around it. Enterprise suites cost 2–10× more per user and assume their own ERP.
12. **Customer experience: suite-composed, not a new monolith portal** (see `08-suite-integration.md`): herbe.portal grows the service modules (equipment + history, requests, order tracking, ETA view, report signoff, feedback — herbe.service ships no customer-facing pages of its own, decided 2026-07-05) on herbe.service’s API; herbe.portal already covers invoices, card/bank-link payments, contextual messaging and Mobile-ID/Smart-ID signing; herbe.calendar's Smart Booking already does availability-checked, no-login self-scheduling into an ERP activity. A full customer window (assets + booking + invoices + documents + qualified e-signature) exists today only in enterprise suites — Frontu's portal has no invoices and no asset register with history, Odoo's has no native asset registry — so at SMB pricing this is a category differentiator, and Baltic-native Smart-ID/Mobile-ID signing is one no global vendor matches.
