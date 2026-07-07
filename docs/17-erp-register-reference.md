# herbe.service — ERP Register Reference (service module)

Status: v0.3 (2026-07-07). Cross-checked against the halocron register dictionary: `SVOVc` at 111 fields, `WSVc` header/row split annotated, row `ItemType` documented as the charge-type enum (string set 31, pushed as integer `1`–`4`), `WSVc` row fields marked HAL-source-verified vs unconfirmed; `ActStateVc` added (activity workflow states behind the shadow-Kanban). Previous: v0.2 (2026-07-06). Sources: owner-provided Standard ERP export structures (`SVOVc`, `WSVc`, printed 2026-07-06 from a live system), the halocron register dictionary (`list_registers`), and a live demo-system probe (`19-demo-probe-results.md`) that corrected two field-behavior assumptions (`RLinkVc` record-id format, `WSVc.WONr` requiredness) and added the `COVc` and `WSIVVc` sections below. This is the developer reference behind the mapping table in `04-erp-sync.md`; for registers not listed here (CUVc, INVc, IVVc, ActVc, …) the portal/calendar codebases and halocron are the reference.

Types are HAL M4 types: `M4Str`/`M4UStr` string (UStr = uppercase), `M4Code` code string, `M4Long`/`M4Int` integers, `M4Val`/`M423Val`/`M4Qty`/`M4Rate` decimals, `M4Date`/`M4Time`, `M4Mark` checkbox bool, `M4Set` enum. Size = max length (0 for numeric/date).

## `SVOVc` — Service Orders

No `UUID`/`ServerSequence` fields → not a "base register": assume no `updates_after`/`deletes_after`; sync via `TransDate`-windowed scans + `SerNr` key-sweep (`04-erp-sync.md`).

**Header — fields we map** (full register per the halocron dictionary: **111 fields** — ≈83–84 header fields before the `stp` row-type marker, ~27 row fields; the "82" previously stated here undercounted):

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
| `DoneMark`, `InvFlag`, `InvMark`, `WOMark`, `WSMark` | flags | processing state, all poll-read only. `DoneMark = 1` = **order closed** (the app's ERP-sync-set `Closed` state — also the flag `PasteSVOInWS` checks to refuse new worksheets); `WSMark = 1` = a Work Sheet exists. `InvFlag`/`InvMark` are **not** reliable "invoiced" flags — they read `1` on a fresh warranty order (which needs no invoice), so the app derives `Invoiced` from an actual linked `IVVc` (`getrecordlinks`), not these flags. `SVOVc` has **no `OKFlag`** |
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
| `MotherNr` (+ secondary/alternate variants) | M4Str 30 (`MotherSecondarySerialNr` is M4Str **60**; `MotherAlternateDeviceID` 30) | parent unit |
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

**Header — fields we map** (halocron dictionary discrepancy, noted 2026-07-07: the dictionary's `WSVc` entry is exactly **54 fields**, but — unlike its `SVOVc` entry — it does **not** include the row matrix, and it lists `ArtCode`/`SerialNr`/`Spec`/`MaxCost`, which this doc classifies as row fields; HAL source (`row WSVc WSrw`) confirms a real row block exists. So "54" is the dictionary-entry size, not a clean header count — treat the owner export as authoritative for the header/row split):

| Field | Type | Maps to |
|---|---|---|
| `SerNr` | M4Long | worksheet's `erpRef` |
| `WONr` | M4Long | work-order no. — **set `-1` on create**, the "no Work Order" sentinel the ERP itself writes in `PasteSVOInWS` when creating a Work Sheet from a Service Order. With `-1` no `WOVc` record is needed; the app never creates or requires a Work Order (avoid the `WOVc` chain). Omitting it triggers mandatory-field error 1058; `WONr=0` resolves to a real, completed `WOVc` row (error 1971). Real production rows show it blank because `-1` reads back as blank/none. |
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

**Rows** (parts + services). Verification status (2026-07-07): fields marked ✓ are confirmed real `WSVc` row fields in HAL source (`PrintWSRows` in `WordWSForm.hal`; `WSDClassSwitchRow`/`WSVc_ExplodeRecepy` for `BasePrice`/`Recepy`) — the halocron dictionary entry omits the row block (see header note). Fields **without** ✓ are **unconfirmed pending the owner export** — explicitly: `ovst`, `Returned`, `PosCode`, `QtyInvbl`, row-level `CostAcc`/`TaxTemplateCode`.

| Field | Type | Maps to |
|---|---|---|
| `ArtCode` ✓, `Spec` ✓ | — | item + description |
| `Quant` ✓, `Price` ✓, `Sum` ✓, `vRebate` ✓, `BasePrice` ✓ | decimals | our WorksheetRow quantities/prices (REST tier: filled by us from `INVc`/`PLVc`) |
| `SerialNr` ✓ | M4Str 60 | serial of used/replaced part |
| `Invd` ✓ | — | invoiced quantity |
| `ovst`, `Returned` | — | processing quantities — unconfirmed; on the demo system both were `0`/blank on every available sample |
| `ItemType` ✓ | M4Int, on the `WSVc` row itself (`WSIVVc` carries its own copy — see below; `SVOVc` rows carry it too) | **The charge-type discriminator, app-owned in herbe.service and mapped 1:1 to this enum.** String set 31 (`SetBegin(31)`): `0` = "-", `1` = Invoiceable, `2` = Warranty, `3` = Contract, `4` = Goodwill. Editable in the ERP UI pre-OK (`WSDClassItemTypeEFAfter` → `WSVc_PasteItemType` recalculates the row on change), with an ERP-computed context-derived default. REST reads return the **localized label string** (e.g. Latvian `"Jāizr.rēķ."` = Invoiceable); the push **writes the integer** `1`–`4` (confirmed live: `ItemType=2` read back as `Warranty`). Print labels: `USetStr` 7761/7762/7763/7768 (`PrintWSRows`, `WordWSForm.hal`). **Name collision**: `INVc.ItemType` (item classification Plain/Stocked/Structured/Service; the `kItemType*` constants) is a different field — do not conflate. Warranty/contract *context* lives on the service-order item (`SVOSerVc`) |
| `Recepy` ✓ | M4Code 20 | recipe/BOM |
| `SalesAcc` ✓, `CostAcc`, `VATCode` ✓, `Objects` ✓, `TaxTemplateCode` | codes | accounting |
| `PosCode` | M4Code 20 | position code — unconfirmed |
| `QtyInvbl` | — | unconfirmed row field; **not used by herbe.service's charge-type mechanism** — `ItemType` is the charge-type field. May matter only in ERP-side corner cases |
| `MotherNr` ✓, FIFO fields | — | ERP-internal |

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

Discovered 2026-07-06 via halocron while investigating `WSVc` row charge-type fields (referenced from HAL source as the row type behind `WSVc`'s invoicing/processing state). Key fields: `SerNr`, `WSNr` (parent `WSVc`), `SVONr`, `ArtCode`, `UsedQty`, `Price`, `Discount`, `Sum`, `InvQty`, `InvNr`, `ItemType` (M4Int — its own copy of the charge-type enum, string set 31; the `WSVc` row carries one too, see `WSVc` rows above), `ContractNr`, `SerialNr`, `EMCode`, `CUCode`. Not yet probed directly over REST as its own register; encountered while tracing `WSVc`'s row-level `ItemType` (which, corrected 2026-07-07, lives on **both** the `WSVc` row and here — not only on this sub-record as v0.2 stated).

## `COVc` — Contracts (service/recurring agreements, 100 fields)

**Added 2026-07-06 (demo probe, `19-demo-probe-results.md` §9)** — the service-contracts register referenced from `04-erp-sync.md`'s register mapping. Found via halocron; distinct from the HR/payroll contract registers (`ContractVc`, `EPContractVc`, `EmplContractVc`), which are a different module. Key: `CustCode` + `SerNr`. Notable fields: `CODate`, `startDate`/`endDate`, `perType`/`perLength`/`invDtype`/`invDays`/`lastInvDate` (recurring billing period), `OKFlag`, `ContractClass`, `PriceList`, `SalesMan`, `TotQuant`, `InvoiceNr`, `CancelDate`. Confirmed REST-readable with real data (`GET /api/<company>/COVc` → 200, real contracts with dates and `OKFlag` set).

## `UserVc` — relevant fields only (124 total)

`Code` (M4Code 10 — the technician person code used in `WSVc.EMCode` and `ActVc` persons; **owner-confirmed as our identity-link target**), `Name`, `emailAddr` / `LoginEmailAddr` (identity matching), `Location` (M4UStr 10 — **default stock location = van stock**, owner), `ServLocation` (M4UStr 10 — service-module variant; confirm tenant convention), `ReservLocation`/`ReservLocAccess`, `JobGroup`, `Department`, `SalesGroup`, `CostPrHour`/`PricePrHour` (labor cost/price — Phase 2 payroll-side reporting candidate), `Closed`, `TerminatedFlag`. Has `UUID`/`ServerSequence` → base register.

**Live-probe finding (2026-07-06, `19-demo-probe-results.md` §7)**: on the demo system, neither `Location` nor `ServLocation` is populated on any of the 40 users, including the two technicians actually referenced by real `WSVc.EMCode` values. `UserVc.Code` matching `WSVc.EMCode` exactly was confirmed for both. The van-stock convention cannot be assumed from this (or any single) tenant — confirm per real launch tenant during onboarding.

## `ActStateVc` — activity workflow states (3 fields)

Verified via halocron 2026-07-07. The register behind `ActVc.ActState` — the workflow-state codes the shadow-activity Kanban uses (`04-erp-sync.md` shadow-Kanban; `08-suite-integration.md` §3).

| Field | Type | Maps to |
|---|---|---|
| `Code` | M4Code 5 | the state code (`ActVc.ActState` references it) |
| `Comment` | M4Str 100 | display name |
| `PipelineColNr` | M4Set 46 | the Kanban column this state maps to (the calendar's `lib/pipeline` reads it) |

herbe.service maps each worksheet/order status → an `ActState` code (per-connection A4 setting) and can **seed these records over the API** (a one-click setup tool POSTs `Code` + `Comment` + `PipelineColNr`), so no manual ERP setup is required to stand up the manager Kanban.
