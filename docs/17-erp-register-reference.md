# herbe.service — ERP Register Reference (service module)

Status: v0.1 (2026-07-06). Sources: owner-provided Standard ERP export structures (`SVOVc`, `WSVc`, printed 2026-07-06 from a live system) and the halocron register dictionary (`list_registers`). This is the developer reference behind the mapping table in `04-erp-sync.md`; for registers not listed here (CUVc, INVc, IVVc, ActVc, …) the portal/calendar codebases and halocron are the reference.

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
| `WONr` | M4Long | work-order no. (unused by us; ERP-internal chain) |
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
| `Invd`, `ovst`, `Returned` | — | processing quantities — **charge-type candidates, confirm on demo** |
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

`FromRecidStr` / `ToRecidStr` (M4RLink 200 — record identifiers like `RegisterName:SerNr`), `Comment`, `DepType`, `LinkType`. The portal-proven cross-reference mechanism; primary invoice↔worksheet↔order back-link. Confirm on the demo system whether it reads over plain REST or only via WebExcellentAPI `getrecordlinks`.

## `UserVc` — relevant fields only (124 total)

`Code` (M4Code 10 — the technician person code used in `WSVc.EMCode` and `ActVc` persons; **owner-confirmed as our identity-link target**), `Name`, `emailAddr` / `LoginEmailAddr` (identity matching), `Location` (M4UStr 10 — **default stock location = van stock**, owner), `ServLocation` (M4UStr 10 — service-module variant; confirm tenant convention), `ReservLocation`/`ReservLocAccess`, `JobGroup`, `Department`, `SalesGroup`, `CostPrHour`/`PricePrHour` (labor cost/price — Phase 2 payroll-side reporting candidate), `Closed`, `TerminatedFlag`. Has `UUID`/`ServerSequence` → base register.
