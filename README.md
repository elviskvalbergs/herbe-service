# herbe.service

Field service management app in the **herbe** suite (herbe.app). Standalone-capable, with two-way sync to **Standard ERP / Excellent Books** (one product family, one adapter) over their REST APIs — behind an **ERP-agnostic adapter framework** (herbe.portal's model): other ERPs plug into the same contract later.

For service companies: service orders in, planned work on a board, technicians executing worksheets offline in the field (parts, time, checklists, photos, signatures), manager approval, invoicing in the ERP.

## Documents

| Doc | Content |
|---|---|
| [01-competitive-analysis.md](docs/01-competitive-analysis.md) | Feature analysis of Frontu, Dynamics 365 FS, Salesforce FS, IFS FSM, AllDevice, Odoo FS, Acumatica FS — verified pricing, and what herbe.service adopts |
| [02-data-model.md](docs/02-data-model.md) | Entities, statuses, team jobs, field policies, ownership rules |
| [03-architecture.md](docs/03-architecture.md) | Offline-first PWA, sync engine, platform blueprint, backend |
| [04-erp-sync.md](docs/04-erp-sync.md) | Two-way ERP sync: store topology, adapter framework, ActVc mapping, transformations |
| [05-users-auth.md](docs/05-users-auth.md) | Separate user store, role-shaped login (magic link office, PIN + biometrics field), ERP identity links, roles |
| [06-roadmap.md](docs/06-roadmap.md) | Features split by development phases |
| [07-ui-screens.md](docs/07-ui-screens.md) | Screen inventory per role, navigation, workflows, UX standards |
| [08-suite-integration.md](docs/08-suite-integration.md) | herbe.calendar + herbe.portal integration and code-reuse plan |
| [09-spec-review.md](docs/09-spec-review.md) | Spec review 2026-07-04: findings, fixes applied, decisions |
| [10-spec-review-gaps.md](docs/10-spec-review-gaps.md) | Review round 2 + spec-line merge record: resolutions and **open questions** |
| [11-service-items-and-parts.md](docs/11-service-items-and-parts.md) | Service item hierarchy (systems/units/lots, group servicing with coverage, bulk management) and spare-parts compatibility |
| [12-documents-templates.md](docs/12-documents-templates.md) | Document generation: DOCX mail-merge templates, compliance certificates, numbering, delivery & signing |
| [13-suite-change-requests.md](docs/13-suite-change-requests.md) | Concrete asks on the herbe.calendar / herbe.portal teams, each with a fallback |
| [14-design-handoff.md](docs/14-design-handoff.md) | Design-system handoff: what's missing for a field-service app |
| [15-testing-strategy.md](docs/15-testing-strategy.md) | TDD policy, test infrastructure, spec-rule traceability, and what the owner must arrange |
| [docs/research/](docs/research/) | Raw competitor + suite research notes (appendix) |

## Product principles

1. **Technician first.** Every field-facing screen works offline, in sunlight, with gloves-on tap targets. Call, navigate, photograph, scan — one tap each.
2. **Standalone by default, integrated by configuration.** No ERP required to run; adapters are per-tenant add-ons.
3. **The ERP owns money.** Prices, VAT, invoices are ERP truth; the app owns the work facts.
4. **History is the product.** Full service history per serial number and per tree node, offline, including pre-app ERP history.
5. **Suite-consistent.** Design system, UX patterns, and technical components shared with the other herbe apps — both sibling codebases reviewed and the stack matched to them ([03-architecture.md](docs/03-architecture.md)); the design system still needs the field-app additions in [14-design-handoff.md](docs/14-design-handoff.md).
6. **Integrate, don't duplicate — but stay a standalone app.** herbe.calendar owns time (team calendars, Kanban boards, Smart Booking); **herbe.portal owns everything customer-facing** — the service modules are the customer's only window into service data (owner decision 2026-07-05); herbe.service owns field work and exposes the service API the portal reads ([08-suite-integration.md](docs/08-suite-integration.md); asks on the sibling teams in [13-suite-change-requests.md](docs/13-suite-change-requests.md)).
