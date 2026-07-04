# herbe.service

Field service management app in the **herbe** suite (herbe.app). Standalone-capable, with two-way sync to **Standard ERP** and **Excellent Books** over their REST APIs.

For service companies: service orders in, planned work on a board, technicians executing worksheets offline in the field (parts, time, checklists, photos, signatures), manager approval, invoicing in the ERP.

## Documents

| Doc | Content |
|---|---|
| [01-competitive-analysis.md](docs/01-competitive-analysis.md) | Feature analysis of Frontu, Dynamics 365 FS, Salesforce FS, IFS FSM, AllDevice, Odoo FS, Acumatica FS — and what herbe.service adopts |
| [02-data-model.md](docs/02-data-model.md) | Entities, statuses, ownership rules |
| [03-architecture.md](docs/03-architecture.md) | Offline-first PWA, sync engine, backend |
| [04-erp-sync.md](docs/04-erp-sync.md) | Two-way Standard ERP / Excellent Books integration |
| [05-users-auth.md](docs/05-users-auth.md) | Separate user store, Entra ID SSO, ERP identity links, roles |
| [06-roadmap.md](docs/06-roadmap.md) | Features split by development phases |
| [07-ui-screens.md](docs/07-ui-screens.md) | Screen inventory per role, navigation, workflows, UX standards |
| [08-suite-integration.md](docs/08-suite-integration.md) | herbe.calendar + herbe.portal integration and code-reuse plan |
| [09-spec-review.md](docs/09-spec-review.md) | Spec review 2026-07-04: findings, fixes applied, open decisions |
| [docs/research/](docs/research/) | Raw competitor research notes (appendix) |

## Product principles

1. **Technician first.** Every field-facing screen works offline, in sunlight, with gloves-on tap targets. Call, navigate, photograph, scan — one tap each.
2. **Standalone by default, integrated by configuration.** No ERP required to run; adapters are per-tenant add-ons.
3. **The ERP owns money.** Prices, VAT, invoices are ERP truth; the app owns the work facts.
4. **History is the product.** Full service history per serial number, offline, including pre-app ERP history.
5. **Suite-consistent.** Design system, UX patterns, and technical components shared with the other herbe apps. The calendar and portal codebases were reviewed 2026-07-04; the reuse plan lives in `docs/08-suite-integration.md` (the design-system repo itself is still pending access).
