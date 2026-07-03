# Competitive research: Frontu (FSM) and AllDevice (CMMS)

Date: 2026-07-03
Method note: frontu.com, help.frontu.com, alldevice.com and wiki.alldevice.com are all unreachable from this environment (proxy gateway rejects CONNECT; WebFetch returns 403 for all hosts). Findings were assembled from web search results, which include indexed content from the vendors' own sites, help centers, wikis and third-party review sites (Capterra, GetApp, SourceForge, ITQlick, SoftwareAdvice, G2). Items marked "unverified" come only from third-party aggregators and should be re-checked against the live sites before publishing externally.

---

## 1. Frontu

### Company background
- Founded 2013 in Kaunas, Lithuania; originally named **Tasker**, rebranded to Frontu in 2021. Legal entity Frontu, UAB.
- Acquired by **Everfield** (European software holding, buy-and-hold) in Oct 2023/2024 (sources differ on exact year; Everfield's first Lithuanian acquisition, third in the Baltics).
- Positioning: "technician-first" field service management. Hundreds of customers in ~16 countries. Notable segment: dealers/service organizations of heavy machinery brands (John Deere, JCB, Manitou, Linde, Hitachi, New Holland).
- Platform available in 18–20+ languages.
- Architecture: web app for admins/managers + mobile app for field technicians. Sold standalone or as an "ERP add-on".

### Core entities / data model
- **Customers (clients)** with contact persons.
- **Objects** — the serviced location/asset site; each object gets a unique auto-generated QR/NFC code. Objects have responsible persons.
- **Equipment** — separate equipment level (add-on): create/edit/reassign equipment, attach jobs/materials, move equipment between object and warehouse, full equipment action history. Equipment can be referenced inside work orders ("Equipment in Work Orders").
- **Work orders** — central unit of work; typed (work order types), linked to customer + object, with jobs and materials lines (with prices and quantities).
- **Client requests** — inbound customer tickets that convert into work orders.
- **Jobs & materials** — catalog items added to work orders; feed warehouse balances and pricing.
- **Warehouse / inventory** — stock, materials, tools; object-and-warehouse linkage.
- **Templates** — work order templates, reusable for periodic work orders.
- **Custom fields** (add-on).
- **Users/roles**: web Admin/User, mobile technician users, Customer role (portal), plus add-ons for **contractors** and **shift workers**.

### Work order lifecycle
- Statuses observed in help docs: **Unassigned → (assigned/inactive) → In progress → Stopped → Completed → Approved**, with an **Overdue** flag that combines with other statuses when planned completion time is exceeded.
- Status transitions are constrained by current status; completed/approved work orders can't have status changed. Admin-side status changes sync live to the technician app.
- **Unassigned pool**: admins can create work orders without an assignee; technicians can self-assign via "Request work order" (order disappears from the unassigned list once claimed).
- **Reassignment** from mobile or web ("Reassign Work Order").
- **Approval step**: after completion, a web Admin/User reviews and approves ("Approving Work Orders"). Reports can be sliced by work order status.
- **Reopen work order** supported.
- Work order preview, summary, copying, adding jobs/materials to existing orders.
- **Client request → work order** flow: request needs only client + object + title; when converting, all active requests/work orders on that object are shown to avoid duplicates; requests can be previewed, edited, archived, or converted. System measures request→work-order and work-order→start lead times.

### Mobile app
- Primary field UI. Frontline app is **Android-first** (phones/tablets); a separate **Frontu FSM Customer Portal** app exists on iOS App Store and Google Play (and the portal is also a PWA). (Whether the technician app has a full iOS version: unverified; marketing mentions "Android operating system for frontline workers".)
- **Offline mode**: full work order access and completion offline; data stored locally, auto-sync when connectivity returns.
- Capabilities: log working hours (time tracking), capture photos, fill **checklists**, collect **digital signatures** on device (plus a "remote signature" add-on), view work order history and documents on site, see customer job history/materials/equipment/task requirements, instant report sending.
- **NFC / QR / barcodes**: scanning to identify objects/equipment; contactless arrival confirmation; barcode/ticket scanning listed on Capterra.
- Real-time task updates: new tasks, status changes, and schedule updates push to the app automatically.
- Route planning / navigation to task locations mentioned as features (GetApp/Capterra: route planning, navigation, job alerts).

### Scheduling & dispatch
- Managers create and assign tasks in real time and track execution through pipelines.
- Dynamic dispatching: adjust workloads by urgency, technician availability, location.
- Calendar/schedule views in web app; automatic schedule updates to mobile. (Named "drag-and-drop dispatch board" or map-based dispatch: not confirmed in accessible sources.)
- Route planning/optimization discussed heavily in Frontu's own blog as part of the offering.
- No evidence of automated skills-based auto-assignment engine; assignment is manual/dispatcher-driven plus technician self-assignment from the unassigned pool.

### Inventory / spare parts
- Live stock updates of materials, tools, inventory; low-stock awareness ("always know when to put orders in").
- Materials used in tasks are automatically deducted from warehouse balances; responsible employees notified when something is missing/out of stock.
- Stock can be allocated across technicians (per-technician allocation ≈ van stock, described as "allocate them equally across technicians").
- **Warehouse management** is an add-on module; "Object and Warehouse" concept links serviced sites and stock.

### Maintenance-specific features
- **Periodic / recurring work orders**: repetition rules (specific days, weekly, monthly with month counts and day-of-month/day-of-week selection), end dates, generated nightly at 04:00 UTC; can be based on saved work order templates; each generated order is independently editable.
- Equipment service history at object/equipment level.
- Capterra lists preventive maintenance, predictive maintenance, calibration management, service history for Frontu (aggregator claims — treat the "predictive/calibration" ones as unverified).
- No meter-reading/counter-based scheduling found (contrast with AllDevice).

### Customer-facing features
- **Customer Portal** (PWA + iOS/Android app, branded): customers manage contact persons, create/edit objects, generate QR/NFC codes, submit **client requests**, monitor work order completion statuses. Separate Customer role login.
- **Notifications**: browser push for new requests/work orders, completion, reassignment, cancellation, overdue; **SMS/email** to work order clients or object-responsible persons on creation; email to work order creator on completion.
- On-site customer confirmation via digital signature; documents stored in electronic archive.
- Questionnaires/surveys add-on (customer feedback).
- Billing & invoicing listed by Capterra; work order data includes jobs/materials with prices, feeding invoicing via ERP integrations (no evidence of native invoice generation).

### Integrations & API
- **Frontu API**: documented public API for push/pull data exchange (fully-documented API tied to the Pro plan per ITQlick).
- Integration page lists **Odoo** (field ops, inventory, scheduling sync incl. offline), **MS Dynamics NAV / AX / Business Central**, Epicor, Scoro, Hanna CRM, Zapier; fleet management/GPS telematics integrations; general CRM/accounting/WMS integration claims.
- Power BI add-on for custom dashboards/reports.
- Marketed explicitly as a mobile front-end add-on to existing ERP/CRM.

### Reporting / analytics
- Reports section over accumulated work order data; **Total report**: work orders, objects, customers, jobs, materials, routes with prices and quantities.
- Reports by work order status; lead-time analytics (request→order, order→start); conversion time by work order type.
- General dashboard for business overview; **Microsoft Power BI add-on** for custom visual dashboards at larger companies.
- Working time reports from technician time logs.

### Pricing
- Official pricing page exists (frontu.com/pricing) but figures are not public in search results; monthly subscription, quote-driven.
- Third-party (ITQlick, dated): from ~$29/user/mo; tiers reported as free **Starter** (chat support, cloud hosting), **Growing** ~$20/user/mo (1GB storage/user), **Pro** ~$25/user/mo (fully-documented API). Unverified/dated.
- A **platform fee** covers unlimited cloud storage, initial setup & onboarding, and **€1M business risk insurance** (distinctive).
- Add-ons priced separately: questionnaires/surveys, remote signature, custom fields, contractors, shift workers, equipment management, warehouse management, Power BI.

### Distinctive points
- Technician-first design philosophy; strong offline Android app.
- Heavy machinery dealer niche (John Deere/JCB/etc. service networks).
- €1M business risk insurance bundled into platform fee — unusual in FSM.
- QR/NFC per object with contactless arrival confirmation.
- Client request intake with duplicate-avoidance and lead-time analytics.
- Modular add-on pricing (contractors, shift workers, equipment, warehouse, Power BI).
- 18–20+ languages; Baltic/Nordic + European footprint; positioned as ERP mobile front-end rather than ERP replacement.

Key source URLs (for re-verification):
- https://frontu.com/field-service-management, https://frontu.com/features, https://frontu.com/pricing, https://frontu.com/integrations, https://frontu.com/integrations/frontu-api, https://frontu.com/integrations/odoo, https://frontu.com/about-us
- help.frontu.com articles: 7959016 (Mobile App), 7958836 (Web App), 8039848 (Reports and Analytics), 8039871 (Periodic/Recurring WO), 8057599 (Approving WOs), 8050860 (Unassigned WO), 8036721 (Reassign), 8036805 (Reopen), 8135560 (Equipment in WOs), 8050912 (QR/NFC), 3994039 (Object and Warehouse), 8053821 (Managing Client Requests), 12459073 (Customer Portal), 8039981 (Reports by WO Status)
- Aggregators: capterra.in/software/151441/tasker, getapp.com/operations-management-software/a/tasker/, itqlick.com/tasker/pricing, softwareadvice.com/crm/tasker-profile/, g2.com/products/frontu/reviews, everfield.com/our-ecosystem/frontu

---

## 2. AllDevice

### Company background
- **Alldevice OÜ**, Estonia; registered 09.04.2014 (Peetri, Rae municipality, near Tallinn). Founders have 20+ years in equipment supply and maintenance services; product born from their own need for a simple maintenance tool.
- Browser-based CMMS aimed at **small and medium industrial organizations**, also used by enterprises. Customers include Unilever, AkzoNobel, Ericsson, Neste, Fender Musical Instruments, Kliimakaubamaja; strong base in Estonia, Latvia, Lithuania, Finland, Poland. Local support teams in FI/EE/LV/LT; marketed toward UK and Europe.
- **ISO 27001:2022 certified**.
- Industry pages: manufacturing, utilities, recycling/waste, chemical, electronics, cranes, packaging, property management, etc.

### Core entities / data model
- **Devices/assets** organized in a **devices tree** (hierarchical asset registry); device cards with **custom fields** (email, date, number, dropdown; visibility and print options).
- **Tasks / work orders** — maintenance tasks generated from schedules or entered ad hoc; **Task Orders** = undated work orders held in a separate view until scheduled.
- **Counters** — meter readings (runtime hours, production counts, sensor readings) attached to devices.
- **Spare parts & stock** — main stock plus **user (personal) stock**; parts linked to devices and consumed on work orders.
- **Companies** — multi-company licensing for separate data sets (service providers managing multiple clients / plants).
- Documents/warranty info attached to device cards; failure/fault records.

### Work order lifecycle
- Work orders created three ways: automatically from preventive schedules/rules, manually by planners, or from **fault reporting** by any user on-site (mobile).
- Undated "task orders" → scheduled task with date → assigned technician → in-progress updates (photos, notes) → completion/confirmation. Technicians can "create or confirm work orders while standing next to the serviced device".
- Automatic **reminders for overdue work**; "early warnings" panel in the desktop UI.
- Task numbering configurable; work order generation periods and task postponement rules in general settings.
- Real-time work order status visibility for the team.

### Mobile app
- Mobile apps for **iPhone, iPad and Android**, plus fully browser-based access from any smart device ("no user limit tied to devices"; deliberately simplified — "removes unnecessary features").
- **QR code scanning**: scan a device label to open asset status, past repairs, changed parts, warranty info; create/confirm work orders at the machine.
- Photo capture on work orders; fault reporting from the shop floor.
- Offline mode: not documented in accessible sources (browser-based architecture suggests connectivity required — verify).
- No signature capture, navigation, or route features found (not a field-service dispatch tool).

### Scheduling & dispatch
- Preventive maintenance calendar/schedule views; task lists filtered by team/technician.
- Assignment of tasks to technicians with completion-status tracking.
- No dispatch board, map view, route optimization, or skills-based assignment — plant-centric CMMS, not mobile-workforce FSM.

### Inventory / spare parts
- Spare parts inventory with automatic adjustment when parts are consumed on work orders.
- **Minimum-stock triggers generate purchase orders** automatically.
- **Main stock vs user stock**: consumption can prefer the technician's personal stock and fall back to main stock (approximation of van/personal stock).
- Reporting on inventory value and usage patterns; spare-parts expenditure analysis over time.

### Maintenance-specific features (core strength)
- **Preventive maintenance plans**: recurring tasks by time interval, **runtime hours/counter readings, or sensor readings**.
- **Predictive interval adjustment**: with counter-based intervals the system monitors average counter growth and shifts the predicted next-task date earlier/later automatically — lightweight predictive scheduling.
- Copy regular task schedules between devices (fast rollout across similar equipment).
- Full **device maintenance history**: past repairs, changed parts, costs, warranty.
- **Failure/fault analysis**: pinpoint problematic devices, top-10 problem devices by MTBF/MTTR.
- Configurable maintenance intervals, postponement rules, generation horizons.

### Customer-facing features
- Essentially none in the FSM sense: no customer portal, notifications to end customers, or invoicing links found. "Companies" multi-licensing lets a service provider keep separate client datasets, which is the closest analogue.
- Fault reporting is open to any internal user (operators as internal "customers").

### Integrations & API
- **API available** (optional/paid add-on; key activation via credentials; full API docs in resources; data typically synced daily).
- ERP/MRP integration use case: push spares usage, hours, and costs for inventory/billing.
- **OEE/production integrations**: documented integration with **Evocon** (OEE) for production counts and proactive maintenance triggers; sensor/SCADA-driven task creation supported via preset rules.
- No public catalog of named ERP connectors (unlike Frontu) — integration is API-based/custom.

### Reporting / analytics
- Dashboard: problematic devices, **MTTR, MTBF**, costs, actual vs planned working times.
- Top-10 problematic devices with MTBF/MTTR; spare-parts and additional-cost expenditure over time.
- Personalized/custom work order reports; configurable printouts; maintenance history reports suitable for audits (ISO-style evidence of timely maintenance).

### Pricing
- Public, flat, capacity-based (not per-user-feature-gated): from **200€/month for 5 users** up to **1250€/month for unlimited users**. **All plans include full functionality** (spare parts, fault analysis, reports). Free trial/demo offered via site.

### Distinctive points
- Simplicity as the core pitch: "really easy maintenance management", built by maintenance engineers.
- Counter/sensor-based scheduling with automatic predictive drift of next-service dates.
- All-features-in-every-plan flat pricing; cheap unlimited-user tier vs per-user FSM pricing.
- QR-label-driven asset lookup on the shop floor.
- Multi-company licensing for maintenance service providers.
- Estonian company, ISO 27001:2022, local Baltic/Finnish support — relevant for Baltic ERP ecosystems.
- Weaknesses vs FSM tools: no customer portal, no dispatch/route/map, no signatures, offline unclear, no native invoicing.

Key source URLs (for re-verification):
- https://alldevice.com/, /product/, /product/work-order/, /product/asset-maintenance/, /product/parts-inventory/, /product/mobile-cmms/, /product/reporting/, /product/integrations/, /industries/, /about/
- wiki.alldevice.com: /d/functionality, /d/faq-configuring-counter-based-maintenance-intervals, /d/faq-tasks-task-numbering, /d/api, /d/reports, /d/general-settings, /d/desktop, /d/companies, /dc/mobile, /d/settings-device-card-custom-fields
- Third party: sourceforge.net/software/product/Alldevice/, evocon.com/articles/evocon-alldevice-integration-cmms/, ariregister.rik.ee (company 12642583), filter.eu/service/alldevice-cmmc-solution/

---

## 3. Head-to-head observations (for the feature matrix)

| Dimension | Frontu | AllDevice |
|---|---|---|
| Category | FSM (mobile workforce) | CMMS (in-plant maintenance) |
| Central object | Work order on customer's object | Task on own device/asset |
| Customer entity | First-class (clients, portal, requests) | Absent (multi-company licensing only) |
| Mobile | Offline Android technician app + customer portal app | iOS/Android/browser, QR-centric, offline unclear |
| Recurring work | Calendar-based periodic WOs | Time + counter + sensor-based, predictive drift |
| Inventory | Warehouse add-on, technician allocation | Built-in, min-stock → purchase orders, user stock |
| Approval flow | Complete → Approve step, reopen | Confirm-at-device, overdue reminders |
| Customer comms | SMS/email/push, signatures, portal | None |
| Integrations | Named ERP connectors + open API + Power BI | Open API + OEE (Evocon), custom |
| Analytics | WO/lead-time/route/price reports, Power BI | MTTR/MTBF, fault analysis, cost trends |
| Pricing | Per-user + platform fee + paid add-ons (quote) | Flat public tiers 200€–1250€/mo, all features |
