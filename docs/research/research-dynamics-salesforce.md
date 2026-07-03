# FSM Competitive Research: Microsoft Dynamics 365 Field Service vs Salesforce Field Service

Research date: 2026-07-03. Sources: microsoft.com product page, learn.microsoft.com docs (via search excerpts — direct fetch blocked by proxy), developer.salesforce.com / help.salesforce.com (via search excerpts), Trailhead, Salesforce Ben, vendor blogs, 2025–2026 release notes. Direct doc-site fetches returned 403 through the session proxy, so doc content was gathered through search result synthesis plus corroborating third-party sources; exact status values and entity names below are stable, well-documented facts.

---

# 1. Microsoft Dynamics 365 Field Service

Built on Dataverse (Power Platform). Everything is a Dataverse table with `msdyn_` prefix; the app is a model-driven Power App. Scheduling comes from the shared **Universal Resource Scheduling (URS)** solution (also used by Project Operations and Customer Service).

## 1.1 Core entities / data model

| Entity (logical name) | Role |
|---|---|
| Account | Service Account (where work happens) and Billing Account (who pays) — both lookups on work order |
| Work Order (`msdyn_workorder`) | Central transaction record: type, status, substatus, priority, duration, price list, service/billing account, functional location, primary incident |
| Work Order Type (`msdyn_workordertype`) | Classification (e.g. inspection vs break-fix); drives defaults |
| Incident Type (`msdyn_incidenttype`) | Work order **template**: bundles service tasks, products, services, skill requirements, estimated duration. Multiple incidents per WO (primary + additional). Builds service history per asset |
| Work Order Incident | Junction: incident type applied to a WO |
| Work Order Product (`msdyn_workorderproduct`) | Part line item; Line Status Estimated/Used drives inventory decrement and billing |
| Work Order Service (`msdyn_workorderservice`) | Labor line item (billable service) |
| Work Order Service Task (`msdyn_workorderservicetask`) | Checklist step; can carry an inspection |
| Customer Asset (`msdyn_customerasset`) | Serviceable equipment at customer; **hierarchical** (parent/child assets); full service history; can link to IoT device; product lookup |
| Functional Location | Hierarchical "where" (campus > building > floor > room); assets sit at functional locations; WO carries functional location |
| Agreement (`msdyn_agreement`) | Contract frame for recurring work + invoicing |
| Agreement Booking Setup / Agreement Booking Date / Agreement Booking Incident | Recurrence definition → generated dates → incident templates for auto-generated WOs |
| Agreement Invoice Setup / Invoice Date / Invoice Product | Recurring invoice generation |
| Entitlement | Discounts/pricing terms applied to WOs (per account, incident type, asset category); entitlement application rules |
| SLA / SLA KPI Instance | First-response / resolution KPIs on work orders (reuses Dynamics SLA engine) |
| Bookable Resource (`bookableresource`) | Person (user/contact), equipment, facility, crew, or pool; has skills (characteristics), territory, work hours, start/end location |
| Bookable Resource Booking (`bookableresourcebooking`) | The scheduled visit: resource + time slot + booking status; own lifecycle separate from WO |
| Resource Requirement (`msdyn_resourcerequirement`) | Auto-generated scheduling demand record kept in sync with the WO (skills, territory, time window, duration); what the schedule board/RSO actually schedules |
| Requirement Group | Multi-resource / crew requirements (e.g. 2 techs + crane) |
| Characteristic / Rating | Skills and proficiency levels on resources; skill requirements on incident types/requirements |
| Territory | Geographic grouping of resources and accounts for dispatch filtering |
| Booking Status / Work Order Substatus | Configurable status entities mapping to system states |
| Warehouse (`msdyn_warehouse`), Product Inventory | Stock locations incl. truck warehouses; qty available/allocated/on hand/on order |
| Purchase Order (+ PO Product, PO Receipt, PO Bill) | Procurement flow, can be tied to a WO |
| Inventory Transfer / Inventory Adjustment (+ products) | Warehouse-to-truck moves, shrinkage corrections |
| RMA / RMA Product / RMA Receipt, RTV | Returns: to warehouse, to vendor (RTV), or change of equipment ownership |
| Invoice | Auto-generated when WO is Posted (products Used + services) |
| IoT Device, IoT Alert, IoT Device Command | Connected Field Service entities |
| Time Off Request, Resource Pay Type, Time Entry | Workforce admin |
| Geofence, Geolocation tracking records | Location/geofencing |

Key relationship spine: **Account → Work Order → (Incidents → Service Tasks / Products / Services) → Resource Requirement → Booking(s) → Bookable Resource**, with Agreement generating WOs and Customer Asset + Functional Location hanging off the WO.

## 1.2 Work order lifecycle

- **System status** (fixed, 6): Unscheduled → Scheduled → In Progress → Completed → **Posted** (billed/closed) | Canceled.
- **Substatus**: unlimited org-defined values, each mapped to a system status (e.g. "Completed – awaiting review").
- **Booking status** (default): Scheduled → Traveling → In Progress → On Break → Completed | Canceled; orgs add custom booking statuses mapped to these. Technicians drive booking status from mobile; booking status changes roll up to WO system status (multiple bookings supported — one booking In Progress ⇒ WO In Progress).
- WO and booking have **independent but linked lifecycles**; Posted stage triggers invoice generation and locks the record.

## 1.3 Scheduling & dispatch

- **Schedule Board**: dispatcher Gantt (hourly/daily/weekly), map panel with routes, unscheduled requirements list, drag-and-drop booking, board tabs with filters, multi-resource view. Hourly requirements grouped by territory.
- **Schedule Assistant**: single-job recommendation engine — ranks slots by availability, skills/characteristics, territory, promised time windows, travel.
- **Resource Scheduling Optimization (RSO)**: paid add-in; bulk optimization of many WOs/resources. Optimization **scopes** (which resources/requirements/timeframe) + **goals** (weighted objectives: minimize travel, maximize utilization, high priority first, locked bookings honored). Runs on schedule, on demand, or single-resource re-optimization ("optimize technician's day"). 2025-wave releases add AI/agentic real-time re-optimization (traffic, cancellations, overruns).
- **Skills**: Characteristics with rating values; matched from incident type requirements.
- **Territories**: filter resources on board and in assistant.
- **Crews**: Bookable Resource of type Crew; members booked together (crew leader model). Requirement Groups for multi-resource jobs with different skill mixes.
- Also: fulfillment preferences (time windows, intervals), booking rules (custom JS validation), geofencing with arrival detection, travel time calculation with map routing, resource start/end at home or company address, facility scheduling, resource pools.

## 1.4 Mobile app

- Single Power Apps-based **Field Service mobile app** (iOS/Android/Windows); model-driven, fully configurable via app designer/forms/views.
- **Offline-first**: mobile offline profiles define which tables/rows sync; background delta sync; works fully disconnected; conflict handling; offline JS/business rules run client-side (Dataverse plugins don't).
- Booking agenda view, work order details, service task checklists.
- **Inspections**: digital forms builder (drag-drop question types: text, number, dropdown, radio, checkbox, entity lookup, barcode input, photo, signature, date/time), versioning, branching logic, works offline, results stored as JSON with PDF export; attached to service tasks per asset.
- Photos/videos/notes attached to WO or asset timeline; **customer signature** capture; customer report generation.
- **Barcode scanning**: search any record type (asset, WO, product) or populate fields.
- Knowledge articles surfaced on work orders; **Dynamics 365 Guides** (step-by-step mixed reality/holographic instructions) and **Remote Assist** (expert video call with AR annotations, HoloLens support) — note: Guides & Remote Assist retire after Dec 31, 2026.
- **Copilot in mobile**: work order recap (voice/chat), natural-language work order updates (speech-to-text field updates), flag risky jobs.
- Location sharing → powers technician tracking; geofence auto status suggestions; push notifications; Teams chat embedded in WO context.

## 1.5 Inventory

- Warehouse = any stock location, **including technician trucks** (mobile warehouses).
- Product Inventory per warehouse: Qty Available, Allocated, On Hand, On Order.
- WO Product with Line Status = Used decrements the source warehouse automatically.
- **Purchase Orders**: request → approval → receipt (to warehouse or direct to WO) → bill.
- **Inventory Transfers** (warehouse → truck), **Adjustments** (shrinkage, cycle counts).
- **Returns**: RMA with three processing types — return to warehouse, **RTV** (return to vendor), change of equipment ownership; RMA receipts confirm.
- Deliberately "lightweight ERP" — for advanced costing/reservations Microsoft points to Business Central / Supply Chain Management integration.

## 1.6 Agreements / preventive maintenance

- Agreement = frame with dates, price list, service territory.
- **Agreement Booking Setup**: recurrence (e.g. monthly), WO type, incident types, products/services/tasks, preferred resource, pre-booking flag → system generates **Agreement Booking Dates** and creates WOs X days in advance; can auto-book to preferred resource.
- **Agreement Invoice Setup**: recurring fixed invoices independent of WOs.
- Entitlements apply contract pricing/discounts to WO products/services automatically (by account, asset category, incident type). SLAs (KPI instances) track response/resolution deadlines on WOs.
- Asset-centric PM via incident types tied to assets + agreements per asset.

## 1.7 IoT / Connected Field Service & AI

- **Connected Field Service**: Azure IoT Hub (or IoT Central) → Stream Analytics rules → IoT Alert records in Dataverse (via Logic Apps/Functions/Power Automate). Alert → case → work order conversion via business process flow; alert auto-parenting/aggregation per device/asset; device commands (e.g. remote restart) from within D365; device registration tied to Customer Assets. Goal: fix before customer notices, or fix remotely without a truck roll.
- **Copilot features** (2025–26): work order **recap/summary** (lifecycle-aware: unscheduled shows requirements, in-progress shows current state), booking recap; Copilot side pane in web app (natural-language WO queries, find/create/update); AI-powered work order creation from emails in Outlook; **Scheduling Operations Agent** (autonomous agent that continuously re-optimizes schedules as conditions change — preview); AI scheduling vs traditional RSO positioning; Copilot Studio for custom agents; data insights on inspections.

## 1.8 Customer engagement

- **Field Service portal** (Power Pages template): customer **self-scheduling** of appointments (suggested slots from Dataverse scheduling API), reschedule/cancel, view history. Limitation: user resources only, no crews/multi-resource incidents.
- **Track my technician**: live map with technician location + ETA once booking status = Traveling; technician name/photo, call/text icon. Requires location sharing from mobile app.
- Automated **notifications** (email/SMS via Power Automate templates): booking reminders, day-of, traveling-with-map.
- Post-completion **surveys** (Customer Voice / portal feedback).

## 1.9 Integrations & extensibility

- **Dataverse-native**: every entity extensible, Power Automate flows, Power Apps, Power BI, plugins, Web API (OData), business process flows, Copilot Studio agents.
- **Microsoft 365**: work orders in **Teams** (create/view/manage, contextual chat) and **Outlook** (create WO from email with Copilot drafting).
- **Business Central**: native bidirectional integration (items, invoices posting, inventory) — SMB ERP story. **Finance & Operations / Supply Chain** integration retires Feb 28, 2027, transitioning to Project Operations integration. **Project Operations** integration for project-based service.
- Mixed reality (Guides, Remote Assist) — retiring end of 2026.
- ISV ecosystem on AppSource.
- **Pricing**: $105/user/mo (full), $50/user/mo Field Service Contractor. RSO an add-on priced per optimized resource.

## 1.10 Distinctive traits

1. Deep, prescriptive out-of-box data model (incident types as WO templates, functional locations, agreements with dual booking/invoice setups, full RMA/RTV loop).
2. Posted stage + invoice generation = built-in billing loop.
3. URS shared scheduling engine + RSO with explicit scopes/goals.
4. Power Platform as the extensibility layer — low-code everywhere, same platform as the rest of Dynamics.
5. M365 gravity: Teams/Outlook embedded workflows, Copilot across web+mobile.
6. Connected Field Service reference architecture on Azure IoT.
7. Cheaper list price than Salesforce; contractor license tier.

---

# 2. Salesforce Field Service

Formerly Field Service Lightning (FSL). Three layers: (1) **core standard objects** in Service Cloud (free schema once FS enabled), (2) the **Field Service managed package** (FSL namespace: dispatcher console, scheduling engine, optimization, guided setup), (3) the **Field Service mobile app**. Requires Service Cloud; scheduling engine now **Enhanced Scheduling and Optimization (ESO)** running on Hyperforce.

## 2.1 Core objects / data model

| Object | Role |
|---|---|
| Account / Contact | Customer + person on site |
| Case | Optional origin of work (entitlement/milestone driven) |
| **WorkOrder** | What work is needed; links Account, Contact, Case, Asset, Entitlement, ServiceContract, WorkType, Location; price book support |
| **WorkOrderLineItem** | Child tasks/steps of a WO; own status, asset, work type; hierarchical (parent line items) |
| **WorkType** | Template: duration, required skills, products, standard line items, auto-create Service Appointment flag |
| **ServiceAppointment** | The schedulable visit (the "when/where"); polymorphic parent (WorkOrder, WOLI, Asset, Account, Lead); Earliest Start / Arrival Window Start-End / Due Date; scheduled start/end; actuals |
| **AssignedResource** | Junction SA ↔ ServiceResource (supports multiple assigned resources) |
| **ServiceResource** | Mobile worker, crew, or contractor; type Technician/Crew/Agent; linked to User; efficiency score, capacity-based option |
| **ServiceTerritory** | Hierarchical territories; operating hours; typical in-territory travel |
| ServiceTerritoryMember | Resource↔territory with primary/secondary/relocation + date ranges |
| **OperatingHours + TimeSlot** | Availability calendars for territories, resources, accounts (arrival windows) |
| **Shift** (+ ShiftPattern) | Variable/rotating schedules overriding operating hours |
| **Skill / ServiceResourceSkill / SkillRequirement** | Skills with levels 0–99.99, time-bounded; requirements on work type/WO/WOLI |
| **ServiceCrew / ServiceCrewMember** | Crew as schedulable unit with member date ranges |
| ResourceAbsence | Time off / non-availability |
| ResourcePreference | Preferred/required/excluded resource per account or WO |
| **Asset** | Standard object, hierarchical; milestones; linked to maintenance |
| **MaintenancePlan / MaintenanceAsset / MaintenanceWorkRule** | PM: plan → covered assets → recurrence rules (calendar, criteria, usage-based) generating WO batches |
| **Entitlement / ServiceContract / ContractLineItem** | What service customer is entitled to; per-asset contract lines; milestones (SLA countdowns) on cases/WOs |
| **ProductItem** | Stock of a Product2 at a **Location** (incl. van/mobile locations); serialized or quantity |
| ProductItemTransaction | Audit of stock movements |
| **ProductRequest / ProductRequestLineItem** | Part orders (e.g. tech requests part to van) |
| **ProductTransfer** | Movement between locations; received via ProductReceipt |
| **Shipment** | In-transit tracking |
| **ReturnOrder / ReturnOrderLineItem** | RMA for products/inventory back to warehouse/vendor |
| **ProductConsumed / ProductRequired** | Parts used on WO/WOLI (decrements ProductItem) vs parts needed |
| **Location / Address** | Warehouses, vans, sites, plants; hierarchical |
| TimeSheet / TimeSheetEntry | Technician time tracking |
| **ServiceReport / ServiceReportTemplate** | PDF report incl. signatures, per WO/SA |
| **DigitalSignature** | Captured signatures typed by role (customer, technician) — multiple per report |
| LinkedArticle | Knowledge article attached to WO/WOLI |
| Expense, WorkPlan / WorkPlanTemplate / WorkStep / WorkStepTemplate | Expenses; work plans = ordered step checklists on WO/WOLI |
| OptimizationRequest, SchedulingPolicy (FSL__ custom objects), TravelMode | Managed package scheduling config |

Relationship spine: **Account → WorkOrder → WorkOrderLineItems → ServiceAppointment(s) → AssignedResource → ServiceResource (→ Territory, Skills, Shifts)**, with WorkType templating, MaintenancePlan generating WOs, and Entitlement/ServiceContract governing them.

## 2.2 Work order & appointment lifecycle

- **WorkOrder status** (default picklist, customizable): New, In Progress, On Hold, Completed, Cannot Complete, Closed, Canceled. Status categories keep custom values mapped.
- **ServiceAppointment status** (default): **None → Scheduled → Dispatched → In Progress → Completed | Cannot Complete | Canceled**.
- **Status transitions are configurable as a state machine** (allowed from→to pairs) in Field Service Settings; auto-dispatch job flips Scheduled→Dispatched; "pinned" statuses lock appointments against optimizer moves (e.g. Dispatched onward).
- Separation of concerns is explicit: WO = commercial/what, SA = execution/when; one WO can have many SAs (return visits), each with own lifecycle.

## 2.3 Scheduling & dispatch

- **Dispatcher Console** (managed package): appointment list + **Gantt** + map with live routes and traffic; policy picker; mass schedule/dispatch/optimize; Gantt color rules; appointment chatter; long-term view; crew management UI. Summer '26 adds modernized **Scheduling Console** with AI layer (live updates, gap visualization, Agentforce surfacing nearest qualified tech for emergencies).
- **Scheduling engine = policies**: a **Scheduling Policy** bundles **Work Rules** (hard pass/fail filters: skills match, territory, availability, timeframe, required resources, max travel, service objectives-excluded resources) + **Service Objectives** (weighted soft scores: minimize travel, ASAP, preferred resource, skill level, minimize overtime, resource utilization/priority). Out-of-box policies: Customer First, High Intensity Utilization, Soft Boundaries, Emergency.
- **Enhanced Scheduling and Optimization (ESO)**: Hyperforce-based optimizer; global optimization (nightly/bulk), **in-day optimization** (react to cancellations/delays), **resource schedule optimization** (one tech's day), appointment insertion, "fill-in schedule", automatic rescheduling on overlap/emergency. **Emergency dispatch** ("last-mile") finds nearest qualified tech now.
- **Skills** with numeric levels and validity dates; **territories hierarchical** with primary/relocation membership; **crews** schedulable with min crew size on work type; **complex work**: scheduling dependencies between SAs (start-after-finish, same-start, same resource, same day), multiday appointments.
- **Travel modes**: per-resource transport (car/van/bike/walk), toll/hazmat avoidance; predictive travel with street-level routing; offsite/no-travel appointments.
- Capacity-based scheduling for contractors (hours/jobs per period rather than slots).

## 2.4 Mobile app

- Field Service mobile app (iOS/Android), **offline-first**: briefcase/offline priming (admin-defined record sets), delta sync, thousands of records offline, deep-link actions. Caveat: server-side automation (Apex triggers, validation rules, flows) doesn't run until sync.
- Customizable via layouts, quick actions, **Lightning Web Components offline** (LWC-based tailored UIs, low-code form builder), mobile **app extensions** (launch other apps with context), branding.
- **Service Reports** with **multiple digital signatures** (typed by role), generated offline.
- **Work Plans / Work Steps**: templated checklists; **Data Capture forms** (dynamic offline forms built in Flow Builder — newer replacement for third-party forms); **Voice-to-Form** hands-free completion (Winter '26).
- Photos/attachments to WO; barcode scanning for asset/product lookup; knowledge articles attached to WOs readable offline; Visual Remote Assistant session launch; timesheets, expenses, inventory (van stock view, product consumption, product requests) in app.
- Push notifications, appointment agenda, offline maps; **quick status change** on the go; Einstein/Agentforce **pre-work brief** (audio summary of the job — listen while driving).

## 2.5 Inventory

- **Location** records model warehouses, sites, and **vans (mobile locations)**; hierarchical.
- **ProductItem** = stock of a product at a location (serialized or qty); ProductItemTransaction audit trail.
- Flow: **ProductRequest** (tech needs part) → **ProductTransfer** (+ **Shipment** in transit) → ProductReceipt → van stock; **ProductRequired** on WO (planned) vs **ProductConsumed** (used — decrements van stock).
- **ReturnOrder / ReturnOrderLineItem** for RMAs (customer returns, defective parts back to warehouse/supplier).
- Like Dynamics: intentionally light ERP; deeper inventory usually integrated (e.g. with an ERP via MuleSoft).

## 2.6 Maintenance plans / entitlements

- **MaintenancePlan** (often tied to ServiceContract): covered **MaintenanceAssets**; generation horizon/batch; one WO per asset per cycle option.
- **MaintenanceWorkRules**, three types: **calendar-based** (every N days/weeks/months, advanced recurrence RRULE), **criteria-based** (record conditions/thresholds trigger next WO — e.g. asset status change), **usage-based** (meter/usage counters via Asset Attributes — e.g. every 1,000 operating hours). Multiple rules per asset (e.g. minor monthly + major yearly) with sequencing.
- **Entitlements + Milestones**: SLA countdowns on cases and work orders (first response, resolution); ServiceContract/ContractLineItem per asset; entitlement verification on WO creation.

## 2.7 IoT / AI (Einstein → Agentforce)

- No first-party IoT ingestion product anymore (Salesforce IoT Cloud discontinued); pattern is: external IoT platform (AWS/Azure) → Platform Events / APIs → Flow creates Case/WO. Criteria-based maintenance rules can react to asset attribute updates from telemetry.
- **Agentforce for Field Service** (current AI umbrella; Einstein features folded in):
  - Dispatcher: Agentforce fills schedule gaps, recommends + books appointments per policy; emergency "nearest qualified tech" actions; natural-language Gantt queries.
  - Technician/mobile: **pre-work brief** (audio AI summary), post-work summarization into service reports, knowledge answers, **Voice-to-Form** data capture, on-device Agentforce assistant.
  - **Work Summaries** for wrap-up; asset service prediction (Einstein) for pre-emptive maintenance scoring.
- **Visual Remote Assistant** (add-on, Streem-based): two-way video see-what-customer-sees, AR annotations, OCR/barcode recognition, session recordings into records; virtual appointments as SA type.

## 2.8 Customer engagement

- **Appointment Assistant** (add-on): "Uber-style" last-mile — SMS/WhatsApp/email real-time status, technician name/photo/logo, **live map tracking en route** (temporary location sharing), ETA updates; **self-service scheduling/rescheduling/cancellation** page (no login, link-based; simplified single-day slot view); works on Experience Cloud.
- Experience Cloud portals for full self-service (create WOs, book via GetSlots API-driven flows).
- Salesforce Scheduler (separate product) for appointment booking scenarios; surveys via Salesforce Feedback Management.

## 2.9 Integrations & extensibility

- Full platform: Apex, Flow, LWC, Platform Events, REST/SOAP APIs; **Field Service REST APIs** and **FSL Apex namespace** (programmatic scheduling, optimization calls, GetSlots/book from custom UIs); AppExchange ISVs (Axsy, Youreka, ProntoForms etc. for advanced forms/offline).
- MuleSoft for ERP integration; Data Cloud for unified customer data; Slack for swarming/collaboration; Maps/ Salesforce Maps for territory design.
- Native fit with Sales/Service Cloud objects (Case→WO→Asset→Opportunity loops: "service to sales").
- **Licensing**: Enterprise/Unlimited editions; roles priced separately — Technician, Dispatcher (~$165–330/user/mo depending on edition), **Field Service Plus** ($350–380), login-based **Contractor / Contractor+** tiers; requires ≥1 Service Cloud + ≥1 Dispatcher license. Add-ons: Appointment Assistant, Visual Remote Assistant, Agentforce (consumption-based).

## 2.10 Distinctive traits

1. Cleanest WO vs ServiceAppointment separation + configurable status-transition state machine.
2. Scheduling policy model (work rules + weighted service objectives) — the most transparent/tunable optimizer configuration in the market; ESO with in-day and emergency optimization.
3. Maintenance work rules with calendar/criteria/usage types on one plan.
4. Appointment Assistant: polished packaged last-mile customer experience.
5. Platform extensibility (Apex/Flow/LWC offline) and CRM adjacency — service↔sales on one customer record.
6. Agentforce agentic AI direction (dispatcher gap-filling, voice-driven mobile work).
7. Higher price point; more assembly required (managed package + policies), but more scheduling knobs.

---

# 3. Head-to-head takeaways for feature planning

| Dimension | Dynamics 365 FS | Salesforce FS |
|---|---|---|
| Platform | Dataverse / Power Platform | Force.com + FSL managed package |
| WO templating | Incident Types (bundle tasks+products+services+skills) | Work Types + Work Plan/Step templates |
| Schedulable unit | Booking (on Resource Requirement) | Service Appointment (+ AssignedResource) |
| Status model | System status (fixed 6) + substatus + booking status | Customizable picklists + transition state machine + pinned statuses |
| Optimizer | RSO scopes/goals; new agentic scheduling agent | ESO policies = work rules + weighted objectives; in-day + emergency |
| PM engine | Agreement booking setups (calendar recurrence) | Maintenance work rules: calendar, criteria, **usage-based meters** |
| Billing | Built-in: WO → Posted → Invoice; agreement invoices | Price books on WO; invoicing usually external/Revenue Cloud |
| Inventory loop | Warehouse/truck, PO, transfer, adjustment, RMA/RTV | Location/van, ProductRequest/Transfer/Shipment, ReturnOrder |
| IoT | First-party Connected Field Service (Azure IoT Hub) | Bring-your-own IoT → Platform Events/Flow |
| Mixed reality | Guides + Remote Assist (retiring end 2026) | Visual Remote Assistant (video AR, no headset story) |
| Customer last-mile | Power Pages portal + Track My Technician | Appointment Assistant (SMS/WhatsApp live tracking, no-login links) |
| AI | Copilot recap/update, Scheduling Operations Agent, Copilot Studio | Agentforce actions, pre-work brief, Voice-to-Form, work summaries |
| Price anchor | $105 full user, $50 contractor | ~$165–380/user + add-ons, login-based contractor tiers |

Common data-model concepts worth mirroring in any FSM product: account/asset/functional-location hierarchy; WO templates; separate schedulable-visit entity with own status flow; skills with levels; territory + operating-hours model; parts estimated-vs-used distinction; PM plan → generated WOs; entitlement/SLA layer; truck-as-warehouse inventory.

## Sources (primary)

- https://www.microsoft.com/en-us/dynamics-365/products/field-service
- https://learn.microsoft.com/en-us/dynamics365/field-service/overview
- https://learn.microsoft.com/en-us/dynamics365/field-service/field-service-architecture
- https://learn.microsoft.com/en-us/dynamics365/field-service/work-order-status-booking-status
- https://learn.microsoft.com/en-us/dynamics365/field-service/rso-overview
- https://learn.microsoft.com/en-us/dynamics365/field-service/inspections-overview
- https://learn.microsoft.com/en-us/dynamics365/field-service/inventory-purchasing-returns-overview
- https://learn.microsoft.com/en-us/dynamics365/field-service/agreements-overview
- https://learn.microsoft.com/en-us/dynamics365/field-service/connected-field-service-architecture
- https://learn.microsoft.com/en-us/dynamics365/field-service/copilot-overview
- https://learn.microsoft.com/en-us/dynamics365/field-service/customer-portal-overview
- https://learn.microsoft.com/en-us/dynamics365/field-service/field-service-integration-overview
- https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave2/service/dynamics365-field-service/
- https://www.salesforce.com/service/field-service-management/guide/ (blocked; content via search)
- https://developer.salesforce.com/docs/atlas.en-us.field_service_dev.meta/field_service_dev/fsl_dev_soap_core.htm
- https://developer.salesforce.com/docs/atlas.en-us.field_service_dev.meta/field_service_dev/fsl_dev_soap_inventory.htm
- https://developer.salesforce.com/docs/atlas.en-us.field_service_dev.meta/field_service_dev/fsl_dev_soap_maintenance.htm
- https://help.salesforce.com/s/articleView?id=service.pfs_lifecycle.htm
- https://help.salesforce.com/s/articleView?id=service.fs_key_concepts.htm
- https://trailhead.salesforce.com/content/learn/modules/field-service-lightning-scheduling-basics/examine-scheduling-policies
- https://www.salesforce.com/service/field-service-management/pricing/
- https://www.salesforceben.com/salesforce-field-service/
- https://diabsolut.com/salesforce-field-service-features/ (2025–26 release recaps)
