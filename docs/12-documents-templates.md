# herbe.service — Document Generation & Templates

Status: v0.2 (2026-07-07). The portal signing descriptor is the primary signing mechanism; the `ActVc` activity-vessel is the no-module fallback. Phase 1 ships the worksheet report only — order confirmation is a Phase-2 DOCX template type. Manual "Generate document…" entry points on `07-ui-screens.md` F4/O2. Previous: draft v0.1 (2026-07-03). Service companies must produce customer- and authority-facing documents that are far richer than a generic "work report": inspection certificates, compliance protocols, per-system test reports, order confirmations — often with a legally prescribed layout and per-service-item/group content. The customer defines the document; the app fills it.

## Decision: Word-based mail-merge templating

Templates are **DOCX files with merge placeholders**, edited by the tenant in Word (or LibreOffice) — no in-app layout editor to build or learn. The engine merges entity data into the template and renders **PDF** (DOCX kept as intermediate where the tenant wants editable output). This is the proven pattern (docxtemplater/Word content-control family): the people who own compliance layouts are office staff who live in Word, and prescribed forms usually already exist as Word files — they get placeholders added, not rebuilt.

The **built-in default documents remain**: Phase 1's worksheet service report PDF works with zero template setup — it carries the worksheet's **photos** (before/after, per covered unit), signature, checklist results, and is **styled by the tenant theme** (logo, colors — the `03-architecture.md` theme tokens). Custom templates override per document type when configured; images are equally supported in DOCX templates (see anatomy below). Both paths share the same merge context and the same computed-field engine.

## Template anatomy

- **Placeholders**: `{customer.name}`, `{order.number}`, `{item.path}`, `{item.serial}`, `{model.attributes.refrigerantType}` — dot-paths into the merge context.
- **Loops**: repeat table rows or sections over collections — worksheet rows, time entries per member, checklist results with measured values + pass/fail, **covered units of a lot/coverage row** (the fire-detector annex: one table row per detector incl. exceptions), child nodes of a subtree.
- **Conditionals**: show/hide blocks (`{#if warranty.active}`…), e.g. warranty clause, out-of-contract pricing block.
- **Images**: tenant logo (theme token, auto-available), photos (filtered: before/after tags, per covered unit), signature image, QR code of the document number for verification.
- **Formatting**: dates/numbers/units localized per tenant language (`06-roadmap.md` i18n); currency role-gated the same way prices are in-app.

## Merge context (what data a template can reach)

Each **document type** has a root entity and a documented **field catalog** (browsable in admin, with copy-to-clipboard placeholders):

| Document type | Root | Context includes |
|---|---|---|
| Worksheet report / protocol | Worksheet | order, customer, site, service item node(s) + paths + models, rows, time, checklist results (values, bounds, pass/fail), coverage incl. exception lists, media, signature (crew jobs: the report can roll up the job's sibling worksheets by `crewGroupId` — one customer-facing report per job, not per technician — round 6, `02-data-model.md`) |
| Service order document (confirmation, quote — Phase 2, with the template engine) | ServiceOrder | rows, requested/promised dates, contract terms reference, price summary (role-gated), booking slots + technicians |
| Compliance certificate | Worksheet **or** ServiceItem node | everything above, plus subtree rollups: covered units table, last/next service dates, coverage % — certificates are often issued per *object* ("fire safety, Building A"), which is exactly a `system` node |
| Contract summary (Phase 3) | Contract | covered nodes tree, PM schedule, response terms |

The context is a **read-only projection built server-side** — the same rollup/coverage machinery as reporting (`11-service-items-and-parts.md`), so a certificate and the dashboard can never disagree.

## Computed fields & display rules

Between the raw context and the template sits a per-tenant **computed-field layer** — implementation-level setup done per customer, not product code. The engine is simple by design: **sandboxed JavaScript functions** that receive the related data (worksheet, order, items, item nodes, checklist results, users, coverage — the full merge context) and return additional properties, which are merged into the context for printing. The same pattern — and the same sandbox — as the REST transformation hooks in `04-erp-sync.md`: one engine, one skill for implementers, two uses.

- A computed field = named JS function: `({worksheet, order, items, users, checklist, coverage}) => ({hasCritical: checklist.values.some(v => v.name === 'insulationResistance' && v.value < 1), …})`.
- Output properties can carry a **display rule**: plain value, a severity (`ok / warning / critical` → styling: e.g. red bold block), or a conditional-section trigger.
- Templates reference them like any other placeholder (`{computed.criticalFindings}`, `{#if computed.hasCritical}`…); the **built-in documents consume the same definitions** — a critical KPI prints as a red warning box on the default report and in the Word template alike, defined once.
- Sandbox rules: deterministic, no network/filesystem, time- and memory-capped, read-only context — a broken function fails the render with a clear error, never corrupts data.
- Definitions live in tenant settings (and settings export/import): a fire-safety implementation ships with its rule set; herbe.service ships with none — deliberately a consultant/implementation surface, mirroring how ERP implementations already work.

## Selection rules & numbering

- **Selection**: per document type, ordered rules pick the template: work type, model category, customer / customer class, contract, site country → first match, else tenant default, else built-in. The fire-inspection certificate fires for detector-lot work; the HVAC test protocol for AHU models — no manual picking, with a manual override at generation time.
- **Numbering**: tenant-defined **number series per document type** (prefix/format/counter, e.g. `FSC-2026-00142`), assigned at first final render, immutable after. Standalone-mode numbering already exists (`04-erp-sync.md`) — same mechanism.
- **Versioning**: templates are versioned; a generated document stores template version + context snapshot. **Re-render** (fix a typo in the template) produces a new document *version*; the signed/delivered original is never mutated — compliance documents are append-only.

## Generation & delivery

- **Triggers**: automatic on worksheet approval (per document type config), manual ("Generate document…" on worksheet/order/node with template override — screen entry points on the worksheet execution and order detail screens, `07-ui-screens.md` F4/O2), and Phase 3 contract-cycle documents (e.g. yearly certificate after the annual inspection completes).
- **Pipeline**: background job (the `03-architecture.md` scheduled/queued pattern — rendering never blocks the approval transition): build context → DOCX merge → PDF conversion → store. PDF conversion needs a real converter (LibreOffice-based service, e.g. Gotenberg, or an equivalent API) — sized/chunked to the Vercel function limits like other jobs; implementation choice is a Phase 2 ADR.
- **Storage**: generated documents are Media records (Supabase Storage, `03-architecture.md`) linked to their root entity *and* to the service item nodes they certify — a certificate is findable from the object's item card and appears in its history.
- **Delivery**: email through the tenant-branded template stack (`03-architecture.md`), surfaced in **herbe.portal** under the customer's documents (`08-suite-integration.md` capability map), attached to the ERP record as a link per the `04-erp-sync.md` attachment rule.
- **Approval & signing — on-site baseline, portal for everything remote** (owner 2026-07-05: all remote customer interaction lives in the portal): the baseline every tenant has is the on-site **canvas signature** for the doorstep case. Remote approval happens in **herbe.portal** — the worksheet-report signoff module (`08-suite-integration.md` §4) for reports; documents needing a *qualified* signature (Smart-ID / Mobile-ID — quote confirmations, compliance certificates) route through the portal's **signing descriptor — the primary mechanism** (POR-2, `13-suite-change-requests.md`; `06-roadmap.md` Phase 3). The **`ActVc` activity-as-vessel path is the no-module fallback**, for tenants whose portal lacks the signing module (`04-erp-sync.md` mapping): the generated document attaches to an activity via record links, the portal presents it like a delivery confirmation, and the outcome (approved / signed / rejected + comment) travels back as the activity's workflow stage + text — landing in herbe.service as a document status change. The fallback works at **tier 0** (through the ERP, no suite-to-suite API), which is its value — but it is the fallback, not the design. Any signature locks the worksheet content the document renders from; a signed PDF becomes a new immutable version.

## Admin UX

Template library per document type: upload DOCX, **field-catalog browser** with copy-placeholder, **test render** against a real (or sample) record with validation report (unknown placeholders, missing images, loop errors — caught at upload, not at midnight), selection-rule editor, version history with diff of placeholders used. Templates and rules are part of **settings export/import** (`04-erp-sync.md`) — a proven fire-safety template set is cloneable to the next tenant in minutes.

## Ownership & roadmap

All app-owned; nothing crosses the ERP API except the finished document as an attachment/link. (ERP-generated documents — invoices — are the ERP's own; where WebExcellentAPI is present the app can *fetch* those PDFs for display, which is the existing capability flag, not this engine.) The WebExcellentAPI-dependent steps here for **service and contracts** documents — attaching the generated document to its `ActVc` vessel, creating/reading the attached activity, fetching the resulting PDFs — follow the per-connection **service/contracts version gate** (`04-erp-sync.md` API tiers): enabled when the installation's `systemversion` matches the configured pattern, hidden otherwise; the emailed-PDF + on-site canvas-signature fallback is unaffected. (Fetching *invoice* PDFs already works on current versions — presence-gated only.)

- **Phase 1**: built-in worksheet report PDF only (tenant-themed, no templates yet). Order confirmation arrives as a Phase-2 DOCX template type (`06-roadmap.md` is authoritative).
- **Phase 2**: DOCX template engine — placeholders, loops, conditionals, images; computed fields & display rules (shared with built-in documents); template library + test render; selection rules; document number series; automatic generation on approval. Rendering-pipeline ADR (converter choice).
- **Phase 3**: compliance certificates per node/coverage with subtree annexes; contract-cycle documents; **approval/signing in herbe.portal — signing descriptor primary, `ActVc` activity-vessel as the no-module fallback** (POR-2; tier-0 fallback path); template set in settings export/import.
- **Phase 4**: AI-assisted drafting of work descriptions feeding the documents (already planned) — templates unchanged, better inputs.
