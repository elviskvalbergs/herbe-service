# herbe.service — Service Item Hierarchy & Spare Parts Compatibility

Status: draft v0.3 (2026-07-07). Service-item hierarchy and spare-parts compatibility model, solving two scale problems: customers with very many service items (a retail chain: stores × HVAC systems × machines; a building: fire sprinklers, pumps, detectors, extinguishers per object) and catalogs with very many spare parts (which part fits which machine, what substitutes what). ERP-boundary rule: the tree structure never syncs — a group path crosses the API only as free text on pushed worksheet rows. Prior art deliberately reused: SAP PM functional locations, IFS installed base, D365 customer asset hierarchy, AllDevice's device tree.

## Part 1 — The service item hierarchy

### Two dimensions, kept separate

Every physical thing lives in exactly one place in a **location tree** (where it is) and points at one **model** (what it is). Conflating these is what makes flat serial lists unusable at scale.

```
Customer ── Site ── ServiceItem tree (unlimited depth, parent link)
                     "Store 14" ─ "HVAC" ─ "AHU-2 (roof)" ─ "Compressor #C-0142"
                                ─ "Fire safety" ─ "Sprinkler zone 1"
                                                ─ "Detectors, floor 1" (lot of 84)
                                                ─ "Extinguisher FE-031" … "FE-076"
ItemModel registry (make/model/category)  ←──  every node references one
```

### Node kinds

`ServiceItem.kind` distinguishes three cases — all are ServiceItems, all can appear on orders and worksheets, all accumulate history:

1. **`system`** — a grouping/system node ("HVAC", "Sprinkler zone 2"). May be serviceable as a whole (a sprinkler zone gets its annual test as a unit). No serial; identity is its path.
2. **`unit`** — an individually identified asset: serial number (or tenant asset code), the QR-label target, warranty and meter values live here. What syncs to the ERP serial register.
3. **`lot`** — a **counted group** of like items that are not (yet) individually tracked: "84 smoke detectors, floor 1" = one node, `quantity: 84`, one model. This is the pragmatic answer to "we're not going to serial-number every detector." A lot can later be **exploded** into units (e.g. when a labeling project happens): quantity decrements as serialized units are born under the same parent, history carries over.

Node fields (beyond `02-data-model.md` ServiceItem): `parentId`, `kind`, `quantity` (lots), `modelId`, materialized `path` (for display/search: "Store 14 / Fire safety / Detectors, floor 1"), `positionCode` (tenant's own numbering, e.g. sprinkler plan codes), free-form attributes per model category (defined on ItemModel, e.g. refrigerant type, tank size).

### Servicing at group level: coverage

The requirement "we serviced *all the fire detectors in this object*" is a first-class write, not a workaround:

- A **ServiceOrderRow / WorksheetRow may target any node** — unit, lot, or system.
- Rows targeting a lot or system carry a **coverage** record: `all` | `count n of m` | explicit list | `all except [list]`. "Inspected 79 of 84, 5 failed → replaced" is one group row + 5 exception entries, not 84 rows.
- **History propagation**: the event is stored once on the target node and *projected* downward — every covered descendant's history shows "covered by group service ⟨worksheet⟩"; exceptions get their own individual events (failed, replaced, missing). Upward, ancestors' histories show rollup entries. The technician at the machine and the manager at the object level both see truthful history without double entry.
- Checklists attach per covered model: a group row for 84 detectors can require one measured checklist per *sampled* unit (tenant-configurable sampling rule) or one for the whole lot.

### Entering and maintaining thousands of items

Manual tree-building doesn't survive contact with a 200-store chain. Three mechanisms, all Phase 1:

1. **Structure templates.** A reusable subtree ("standard store": HVAC(2× AHU) + Fire safety(zones, detector lots, extinguishers)) stamped onto a site, then edited. Templates reference models, checklist templates and default PM rules — a new store is minutes, not hours.
2. **Spreadsheet import** (the realistic mass path): CSV/Excel with path columns (`Site / L1 / L2 / name`), kind, quantity, model, serial, position code. Dry-run preview with diff (creates/updates/moves), then commit. Export in the same shape → edit → re-import is also the **bulk-edit** escape hatch.
3. **Bulk operations in the UI**: filter (subtree × model/category × status × contract), multi-select, then: move, assign contract, set attributes, change status, print QR labels, **create a service order for the selection** (one order, group rows per lot / rows per unit).

### Finding things

- **Search is path + serial + position code + model + QR**, one box, ranked; scoped by customer/site when launched from context.
- Two views everywhere: **tree browser** (drill down, rollup badges) and **flat filtered list** (sort/select/bulk) — same filter state toggles between them.
- Technician: QR scan is primary (opens the unit card); otherwise site → tree preloaded offline in the briefcase for assigned work.

### Reporting rollups

Any subtree rolls up: open orders, last/next service per PM rule, **coverage %** ("42/46 extinguishers inspected in the last 12 months" — computed from coverage records vs lot quantities/unit counts), failure rate by model, cost per node (ERP-priced, role-gated). The contract view (`06-roadmap.md` Phase 2) uses the same rollup: covered nodes vs actually-serviced.

## Part 2 — Spare parts: compatibility and alternatives

### Model registry is the join point

Compatibility is defined **model ↔ part**, never serial ↔ part — per-serial compatibility is unmaintainable and unnecessary. The **ItemModel** registry (make, model, category, attributes, documents, default checklist) is referenced by both service items ("this AHU-2 is a Daikin D-AHU-400") and part compatibility rows.

- **PartCompatibility**: `modelId × itemId (catalog part) × role (wear part / filter / consumable / repair kit …) × qty per service × note`. Editable from both directions: model card ("parts for this model") and part card ("fits these models").
- **Alternatives**: two forms, both app-owned:
  - **Equivalence group** — mutually interchangeable parts (OEM ↔ aftermarket), with preference rank.
  - **Supersession** — directed "A is replaced by B" (old part numbers chain forward).
- **Automatic offering**: everywhere a part is looked up (worksheet row, stock check), out-of-stock or superseded parts show their alternatives inline, ordered by: van stock → warehouse stock → preference rank. This is a lookup-time projection, no user action needed.

### Technician UX (the point of all this)

Opening "add part" on a worksheet for a given service item shows, in order:
1. **Fits this model** — compatibility list for the item's model, with live van/warehouse stock badges;
2. **Used before on this model** — usage history ranking (see below);
3. full catalog search (barcode scan included), each result badged *fits / unknown / superseded → B*.
Picking an out-of-stock part offers its in-stock alternatives in one tap. All of it offline: compatibility, alternatives and cached stock are in the briefcase.

### Learning from usage

Every approved worksheet row is a (model, part) observation. A nightly job proposes compatibility rows for repeated unlisted pairs ("D-AHU-400 + filter F-2231 used 12×, not in the matrix — add?") to an admin review queue. The matrix converges toward reality without anyone maintaining it by hand. (Phase 3.)

### Maintaining the matrix

Admin: model registry CRUD (merge duplicate models — import hygiene), compatibility editor both directions, alternative-group editor, and the same **spreadsheet import/dry-run/export** pattern as the item tree (compatibility matrices usually already exist somewhere in Excel). Included in settings export/import (`04-erp-sync.md`) minus nothing — no secrets here.

## What is stored where (ERP vs app)

| Data | Master | Notes |
|---|---|---|
| Item catalog (parts, services) | **ERP** | as before (`INVc`); barcodes, prices, classifiers |
| Serialized units (`kind: unit`) | **shared** | sync to the ERP serial/serviced-item register — flat, serial-keyed; ERP invoices and pre-app history reference serials |
| Tree structure, `system`/`lot` nodes, quantities, paths, position codes | **app** | HansaWorld registers are flat; the hierarchy is app value-add. Group nodes are never pushed; worksheet rows pushed to ERP carry the serial when targeting a unit, otherwise item lines + a text reference to the group path |
| Coverage records, history projection | **app** | ERP receives the billing-relevant rows only |
| ItemModel registry | **app** | optionally seeded from ERP item classifiers (`DIVc`) at initial load |
| PartCompatibility, alternatives | **app** | if a tenant's ERP holds alternative-item data, the adapter imports it as seed (capability flag); the app remains master |
| Structure templates | **app** | tenant config; in settings export/import |

Adapter note: none of this changes the `04-erp-sync.md` contract — serialized units ride the existing serviced-item register mapping. **The tree structure itself never syncs**: a group's path crosses the API only as the free-text reference on pushed worksheet rows (table above), never as structure — no node, hierarchy, coverage or quantity data is ever written to or read from an ERP register.

## Roadmap placement (updates `06-roadmap.md`)

- **Phase 1**: tree with `system`/`unit` nodes (parent link, path search), model registry minimal (make/model/category), unit cards + history; `lot` nodes + coverage rows, structure templates, spreadsheet import/export + dry-run, bulk operations, QR labels per unit *and per lot/system node* (a zone plaque is scannable too), PartCompatibility + alternatives + fits-first technician lookup. Flat is a degenerate tree — no migration later.
- **Phase 2**: rollup reporting + contract coverage view; lot explosion; checklist sampling rules.
- **Phase 3**: compatibility suggestions from usage; meter-based PM per node (already planned) rides the same tree.
