# herbe.service — ERP Register Reference (service module)

Status: v0.2 (2026-07-06). Sources: owner-provided Standard ERP export structures (`SVOVc`, `WSVc`, printed 2026-07-06 from a live system), the halocron register dictionary (`list_registers`), and a live demo-system probe (`19-demo-probe-results.md`) that corrected two field-behavior assumptions (`RLinkVc` record-id format, `WSVc.WONr` requiredness) and added the `COVc` and `WSIVVc` sections below. This is the developer reference behind the mapping table in `04-erp-sync.md`; for registers not listed here (CUVc, INVc, IVVc, ActVc, …) the portal/calendar codebases and halocron are the reference.

Types are HAL M4 types: `M4Str`/`M4UStr` string (UStr = uppercase), `M4Code` code string, `M4Long`/`M4Int` integers, `M4Val`/`M423Val`/`M4Qty`/`M4Rate` decimals, `M4Date`/`M4Time`, `M4Mark` checkbox bool, `M4Set` enum. Size = max length (0 for numeric/date).

## `SVOVc` — Service Orders

No `UUID`/`ServerSequence` fields → not a "base register": assume no `updates_after`/`deletes_after`; sync via `TransDate`-windowed scans + `SerNr` key-sweep (`04-erp-sync.md`).

**Header — fields we map** (full list: 82 fields, see export/halocron):

| Field | Type | Maps to |
|---|---|---|
| `SerNr` | M4Long | order's `erpRef` |
| `TransDate`, `RegDate`, `RegTime` | date/time | created/registered timestamps |
| `CustCode` | M4Code 20 | customer |
| `DelAddrCode` | M4Code 20 | **Site** (→ `DelAddrVc.DelCode`) |
| `Addr0–3`, `ShipAddr0–3`, `InvAddr3–4`, `DelAddr3–4` | M4Str 60 | address snapshots |
| `OurContact`, `CustContact`, `Phone` | str | contacts |
| `SalesMan` | M4Code 10 | manager/salesperson (`UserVc` code) |
| `TechnicianID` | M4Str 20 | assigned technician |
| `ServLocation` | M4UStr 10 | service stock location |
| `CustComplaint1–4` | M4Str 100 | fault/request description (4×100 chars) |
| `TechComment1–4`, `Note1–4`, `Comment1–4` | M4Str 100 | technician comments / internal notes |
| `DoneMark`, `InvFlag`, `InvMark`, `WOMark`, `WSMark` | flags | processing state (done, invoiced, work-ordered, work-sheeted) |
| `PlanShip`, `PlanShipDate` | str/date | promised/planned dates |
| `ConfirmationNo` | M4Str 20 | confirmation reference |
| `CustOrdNr` | M4Str 60 | customer's own order no. |
| `PriceList`, `CustCat`, `RebCode`, `PayDeal` | codes | pricing/terms context (read-only for us) |
| `OrderClass`, `Objects`, `Region`, `BranchID`, `SalesGroup` | codes | classification |
| `TotCost`, `TotPrice`, `InclVAT`, `CurncyCode` + rate fields | decimals | totals (ERP-owned) |

**Rows** (repeat to blank; one row per serviced item):

| Field | Type | Maps to |
|---|---|---|
| `ArtCode` | M4Code 20 | item code |
| `SerialNr`, `SecondarySerialNr`, `AlternateDeviceID` | str | the serviced unit (→ `SVOSerVc` / our `unit` node) |
| `MotherNr` (+ secondary/alternate variants) | M4Str 30 | parent unit |
| `Spec` | M4Str 100 | description |
| `Quant`, `Cost`, `Price`, `MaxCost` | decimals | quantities/amounts |
| `StandProblem`, `StdProblemMod` | M4Code 20 | standard problem codes (→ work templates, Phase 3) |
| `DiagnosticCode` | M4Str 100 | diagnosis |
| `ContractNr` | M4Long | service contract link |
| `WOSerNr`, `WOEnum`, `WOMade` | numbers | downstream work-order tracking |
| `Invd` | M4UVal | invoiced quantity |
| `ItemType`, `ItemKind` | M4Set | item classification |
| `SalesAcc`, `VATCode`, `Objects`, `TaxTemplateCode` | codes | accounting |

## `WSVc` — Work Sheets

No `UUID`/`ServerSequence` → same sync rule as `SVOVc`. **Posting does not touch stock; `OKFlag=1` triggers write-off (manager does this in the ERP for v1)** — see `04-erp-sync.md` findings.

**Header — fields we map** (full list: 54 fields):

| Field | Type | Maps to |
|---|---|---|
| `SerNr` | M4Long | worksheet's `erpRef` |
| `WONr` | M4Long | work-order no. — **live-probe finding (2026-07-06, `19-demo-probe-results.md` §10): required on REST create on the demo system** (`0` is rejected as "work order already completed" — it's validated as a foreign key into a separate Work Order register, not treated as "none"). Real production rows on the same install have it blank, so existing records were created through a path (ERP UI "paste from order") that doesn't hit this validation. Open question for the owner: per-tenant module setting, or a genuine mandatory Service Order → Work Order → Work Sheet chain that the push design doesn't currently handle |
| `SVONr` | M4Long | **service order link** (we set it on POST) |
| `TransDate` | M4Date | work date |
| `EMCode`, `EMName` | code/str | **technician** (`UserVc` code via identity link) |
| `CustCode`, `Addr0`, `CustContact`, `Phone` | — | customer snapshot |
| `OKFlag` | M4Mark | ERP processing trigger (stock + invoice basis); **read-only for us in v1** |
| `PrelOK` | M4Mark | preliminary OK |
| `InvFlag` | M4Mark | invoiced |
| `UpdStockFlag` | M4Int | whether OK consumes stock — set correctly at POST; immutable after OK (`AllowWSUpdateStockChange` gated) |
| `Location` | M4Code 10 | stock location consumption draws from |
| `Invalid`, `InvalidDate` | int/date | voided worksheet |
| `Sum0–4` | M4Val | totals (ERP-computed at invoicing; REST tier stores ours as sent) |
| `Comment1–4` | M4Str 100 | comments |
| `PriceList`, `CustCat`, `RebCode`, `CostAcc`, `ACShort`, `Objects` | codes | pricing/accounting context |

**Rows** (parts + services):

| Field | Type | Maps to |
|---|---|---|
| `ArtCode`, `Spec` | — | item + description |
| `Quant`, `Price`, `Sum`, `vRebate`, `BasePrice` | decimals | our WorksheetRow quantities/prices (REST tier: filled by us from `INVc`/`PLVc`) |
| `SerialNr` | M4Str 60 | serial of used/replaced part |
| `Invd`, `ovst`, `Returned` | — | processing quantities — **charge-type candidates**; on the demo system `ovst`/`Returned` were `0`/blank on every available sample (no warranty/goodwill row to contrast against) |
| `ItemType` | M4Int (row-level; lives on the `WSIVVc` sub-record, see below) | **live-probe finding (2026-07-06, `19-demo-probe-results.md` §6): ERP-computed, not client-set** — the strongest charge-type candidate. Every sample seen, including one the ERP generated itself on a bare create, came back `"Jāizr.rēķ."` ("to invoice"); the full enum (warranty/goodwill/contract values) is not yet confirmed — halocron's `list_registers` returns type/size but not enum members |
| `Recepy` | M4Code 20 | recipe/BOM |
| `SalesAcc`, `CostAcc`, `VATCode`, `Objects`, `TaxTemplateCode` | codes | accounting |
| `PosCode` | M4Code 20 | position code |
| `ItemType`, `QtyInvbl`, `MotherNr`, FIFO fields | — | ERP-internal |

## `SVOSerVc` — serviced items / serial registry (61 fields)

Key fields: `SerialNr` (60), `ItemCode`/`ItemName`, `CustCode`/`CustName`, `SoldDate`, `WarrantyUntil`, `WarrantyStatus`, `CoverageStartDate`/`CoverageEndDate`, `ContractCoverageStart/EndDate`, `ContractType`, `LaborCovered`/`PartCovered`/`LimitedWarranty`/`GlobalWarranty` marks, `Contract` (M4Long), `MotherNr` (parent unit), `SecondarySerialNr`, `AlternateDeviceID`, `ImageURL`/`ManualURL`/`ExplodedViewURL`, `xInStock`, `SalesPrice`/`CostPrice`. Maps our `unit` nodes; the warranty/coverage detail feeds the item card and contract badges.

## `DelAddrVc` — delivery addresses = Sites (45 fields)

Has `UUID` + `ServerSequence` → base register, incremental-sync capable. Key fields: `CustCode`, `DelCode` (the code `SVOVc.DelAddrCode` references), `Name`, `Comment`, `DelAddr0–4`, `Contact`, `Phone`, `Email`, `Region`, `Closed`, `DelCountry`. The invoice-routing config fields (`InvoiceBase`, `GroupInvoice`, …) are ERP-internal.

## `ItemStatusVc` — stock levels per item × location (18 fields)

`Code` (item), `Location`, `Instock`, `Instock2`, `RsrvQty` (reserved), `StockRsrvQty`, `OrddOut` (on sales orders), `POQty`/`POUnOKQty` (on purchase orders), `InShipment`, `InWSheet` (**on work sheets** — shows parts already consumed on un-OK'd worksheets), `WOrd` (on work orders), `ProdOrd`, `WeighedAvPrice`, `LeadDate`, `NoDataBefore`, `Variety`. Read-only in the app: display + van-stock lookups only, never computed or written (owner decision).

## `RLinkVc` — record links (5 fields)

`FromRecidStr` / `ToRecidStr` (M4RLink 200), `Comment`, `DepType`, `LinkType`. The portal-proven cross-reference mechanism; primary invoice↔worksheet↔order back-link.

**Corrected 2026-07-06 (live demo probe, `19-demo-probe-results.md` §5)**: `FromRecidStr`/`ToRecidStr` are **not** the `RegisterName:SerNr` string this doc previously described. They're REST-readable (confirmed: real rows returned, including links to `IVVc`), but the actual value is an internal, partially-binary record pointer — an ASCII register-name fragment followed by an opaque binary tail that does not decode to the visible `SerNr`. A wider scan hit a raw control character embedded in one of these fields, breaking strict JSON parsing. **Treat `RLinkVc` REST rows as opaque; use WebExcellentAPI `getrecordlinks` for any back-link resolution the app actually needs to act on.**

## `WSIVVc` — Work Sheet processed-item ledger rows (33 fields)

Discovered 2026-07-06 via halocron while investigating `WSVc` row charge-type fields (referenced from HAL source as the row type behind `WSVc`'s invoicing/processing state). Key fields: `SerNr`, `WSNr` (parent `WSVc`), `SVONr`, `ArtCode`, `UsedQty`, `Price`, `Discount`, `Sum`, `InvQty`, `InvNr`, `ItemType` (M4Int — see `WSVc` rows above), `ContractNr`, `SerialNr`, `EMCode`, `CUCode`. Not yet probed directly over REST as its own register; encountered as the field owner of `WSVc`'s row-level `ItemType`.

## `COVc` — Contracts (service/recurring agreements, 100 fields)

**Added 2026-07-06 (demo probe, `19-demo-probe-results.md` §9)** — the service-contracts register referenced from `04-erp-sync.md`'s register mapping. Found via halocron; distinct from the HR/payroll contract registers (`ContractVc`, `EPContractVc`, `EmplContractVc`), which are a different module. Key: `CustCode` + `SerNr`. Notable fields: `CODate`, `startDate`/`endDate`, `perType`/`perLength`/`invDtype`/`invDays`/`lastInvDate` (recurring billing period), `OKFlag`, `ContractClass`, `PriceList`, `SalesMan`, `TotQuant`, `InvoiceNr`, `CancelDate`. Confirmed REST-readable with real data (`GET /api/<company>/COVc` → 200, real contracts with dates and `OKFlag` set).

## `UserVc` — relevant fields only (124 total)

`Code` (M4Code 10 — the technician person code used in `WSVc.EMCode` and `ActVc` persons; **owner-confirmed as our identity-link target**), `Name`, `emailAddr` / `LoginEmailAddr` (identity matching), `Location` (M4UStr 10 — **default stock location = van stock**, owner), `ServLocation` (M4UStr 10 — service-module variant; confirm tenant convention), `ReservLocation`/`ReservLocAccess`, `JobGroup`, `Department`, `SalesGroup`, `CostPrHour`/`PricePrHour` (labor cost/price — Phase 2 payroll-side reporting candidate), `Closed`, `TerminatedFlag`. Has `UUID`/`ServerSequence` → base register.

**Live-probe finding (2026-07-06, `19-demo-probe-results.md` §7)**: on the demo system, neither `Location` nor `ServLocation` is populated on any of the 40 users, including the two technicians actually referenced by real `WSVc.EMCode` values. `UserVc.Code` matching `WSVc.EMCode` exactly was confirmed for both. The van-stock convention cannot be assumed from this (or any single) tenant — confirm per real launch tenant during onboarding.
