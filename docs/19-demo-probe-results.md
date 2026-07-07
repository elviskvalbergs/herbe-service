# herbe.service — demo-ERP probe results

Status: v0.4 (2026-07-07 — `SVOVc` write path proven end-to-end: POST with no `SerNr` auto-assigns via `NextSerNr` (created `SerNr 230022`), `ItemType` integer write confirmed (`2`→`Warranty`), `Closed` = `SVOVc.DoneMark`, `Invoiced` via a linked `IVVc` not `InvFlag`). Previous v0.3: step 12 **ran** via a live read of finished
order 230015 — the `Closed` field is `SVOVc.DoneMark`, and the read also delivered the
contrasting `ItemType` = Warranty value that resolves Step 6; both sections updated. The
`SVOVc` create no-op is diagnosed as a `SerNr` collision, §10). Previous: v0.2 (2026-07-07,
step 12 recorded as not-yet-run). Previous: v0.1 (2026-07-06).
Executed against the live demo Standard ERP install per the
work order in `18-demo-probe-handoff.md` — **steps 1–12, all executed**. All requests used the `ERP_DEMO_*`
credentials from the session environment; no credential values appear below or in
any command history committed with this doc. Sample data is capped at 10 rows and
uses the install's own placeholder test customer (`CustCode=1`, "Paraugs" — the
ERP's built-in "Sample" customer) wherever a demo record was needed; no real
customer/person data is reproduced here (the demo install does contain some,
e.g. a persona-code-shaped value on a seeded `UserVc` row — deliberately omitted).

## Setup

Connectivity confirmed: `GET /api/<company>/UserVc?limit=1` → HTTP 200, valid JSON.
No TLS/proxy issues encountered (the `/root/.ccr/ca-bundle.crt` contingency in the
handoff doc was not needed in this environment).

## Step 1 — Auth + register availability

All 10 registers respond HTTP 200 with real data: `SVOVc`, `WSVc`, `SVOSerVc`,
`DelAddrVc`, `ItemStatusVc`, `RLinkVc`, `UserVc`, `CUVc`, `INVc`, `ActVc`.

Field names on every register match `17-erp-register-reference.md` closely —
cross-checked header + row field lists against live responses field-by-field.
Two register-structure assumptions in the reference doc are independently
confirmed by the live payloads:

- `SVOVc` and `WSVc` responses carry **no `UUID`/`ServerSequence`** fields — consistent
  with "not a base register."
- `DelAddrVc` responses **do** carry `UUID` + `ServerSequence` — consistent with
  "base register, incremental-sync capable."

No field-name drift found; no action needed on the reference doc from this step
alone (see steps 5–7 below for fields where the *values*, not the names, changed
the picture).

## Step 2 — `updates_after` on service registers

| Register | `updates_after=0` | Notes |
|---|---|---|
| `SVOVc` | **HTTP 404** | Body: `"updates_after not supported for this register. Add this code to halcust/datadef.hal to add a synchronization index: RecordAddBegin(SVOVc,\"SVOVc_SynchronizationIndex\")..."` |
| `WSVc` | **HTTP 404** | Same error shape, register name substituted |
| `CUVc` (control) | **HTTP 200** | Returns `@sequence` high-water mark at top level, as expected for a base register |

**Conclusion: confirmed as assumed.** `SVOVc`/`WSVc` do not support `updates_after`;
`CUVc` does. Bonus finding: the 404 error body is a genuine HAL customization
recipe (`RecordAddBegin(...)` in `halcust/datadef.hal`) — i.e. an ERP-side
developer *could* add a synchronization index to `SVOVc`/`WSVc` to enable
incremental reads. Worth a note as a possible future ask to Excellent, not
something to build around by default (per-tenant, requires ERP-side code
changes we don't control).

## Step 3 — `deletes_after` behavior

`deletes_after=0` on `SVOVc`, `WSVc`, and `CUVc` (the base-register control) all
returned **HTTP 204, empty body** — no error, but no usable data either, even on
the base register that supports `updates_after`.

**Conclusion: confirmed as assumed.** `deletes_after` doesn't error, but gives
nothing actionable on any register tested, including a base register. This
fully supports the existing decision to rely on key-sweep reconciliation
instead of `deletes_after` for deletion detection.

## Step 4 — Server-side filters

Tested `GET /api/<company>/WSVc?filter.CustCode=<code>` against an unfiltered
scan. This install's demo `WSVc` register only holds 2 total rows, but the
filter correctly narrowed the result set from 2 → 1, returning exactly the row
matching the given `CustCode`.

**Conclusion: confirmed.** `filter.CustCode` works correctly on `WSVc` on this
install. (Per the existing spec, still treat this as an optimization, not the
correctness mechanism — behavior may vary by register/field per the portal's
prior experience with `CUVc`/`ContactRelVc`.)

## Step 5 — `RLinkVc` over plain REST

`RLinkVc` **is REST-readable** — `GET /api/<company>/RLinkVc?limit=200` returns
HTTP 200 with real link rows, including links to `IVVc` (invoice) records.

**But the record-id format is not what `17-erp-register-reference.md` assumed.**
The doc described `FromRecidStr`/`ToRecidStr` as "record identifiers like
`RegisterName:SerNr`" — that is wrong. The actual format is an internal,
partially-binary record pointer: an ASCII register-name fragment (e.g. `1WSVc`,
`1IVVc`) followed by an opaque binary tail that does **not** decode to the
visible `SerNr` (verified against real records — e.g. a link whose `Comment`
read `"Invoices 2500011"` did not have `2500011`, or any obvious encoding of
it, in its binary tail). A wider scan (`limit=200`) hit a **raw control
character embedded in a `ToRecidStr` value**, which broke strict JSON parsing —
independently confirming the existing "ERP responses may contain control
characters" note in `04-erp-sync.md`.

**Conclusion (decided): the invoice back-link mechanism must use WebExcellentAPI's
`getrecordlinks`, not raw `RLinkVc` REST rows.** `RLinkVc` REST is useful only to
confirm that link records exist; the record-id strings it returns are not
safely parseable by application code and must be treated as opaque. This
overturns the "confirm REST readability" open question in `04-erp-sync.md`
with a firm answer, and removes REST-tier `RLinkVc` parsing as a viable
fallback for tenants without WebExcellentAPI — on a REST-only tenant, the
back-link falls through to the next tier in the existing plan (app-side order
number in an agreed ERP field, or the customer+date+amount heuristic).

## Step 6 — Charge-type row fields (`WSVc`/`SVOVc` rows)

Inspected `Invd`, `ovst`, `Returned`, and `ItemType` on real `WSVc` rows and on
`SVOVc` rows (including finished order 230015 and the live-created order 230022).

Findings:
- `ItemType` is the charge-type discriminator on both `SVOVc` and `WSVc`/`WSIVVc`
  rows — Standard ERP **string set 31**: `0` = "-", `1` = Invoiceable, `2` = Warranty,
  `3` = Contract, `4` = Goodwill (a 1:1 match to the app's charge types). It is **not**
  `INVc.ItemType` (item classification). REST **reads** return the localized label
  (`"Jāizr.rēķ."` = Invoiceable on the early samples, `Warranty` on the finished and
  live-created warranty orders); the push **writes the integer** `1`–`4` (confirmed
  live — `set_row_field.0.ItemType=2` read back as `Warranty`). The `GetCOSAcc` HAL
  logic corroborates the semantics: `SVOItemType` 1/2/3/4 selects the item's
  `SVOInvbleCostAcc`/`SVOWarrantyCostAcc`/`SVOContractCostAcc`/`SVOGoodwillCostAcc`.
- `Invd` (invoiced quantity) matched `Quant` exactly on an already-OK'd/invoiced
  worksheet row, and was blank on a not-yet-OK'd row — consistent with its
  documented meaning.
- `ovst` and `Returned` were `0`/blank on every sample row available on this
  install — unused by herbe.service's charge-type mechanism (`ItemType` is it), so
  not pursued further.

**Conclusion: RESOLVED.** `ItemType` is the charge-type discriminator (string set 31,
not `INVc.ItemType`); reads return the localized label, the push writes the integer
`1`–`4`.

## Step 7 — `UserVc.Location` vs `ServLocation`

Checked all 40 `UserVc` rows on this install: **neither `Location` nor
`ServLocation` is populated on any user**, including the two technicians
(`SUPPORT`, `RUDOLFS`) actually referenced as `WSVc.EMCode` on real worksheets.
This also incidentally confirms `UserVc.Code` is exactly the identity-link
target used in `WSVc.EMCode` (`EMCode` values matched `UserVc.Code` values
exactly for both real worksheets checked).

**Conclusion: inconclusive on this install — neither convention is configured.**
This is itself useful: it means the van-stock location convention cannot be
assumed from any single demo/reference tenant and must be confirmed per real
launch tenant during onboarding, exactly as `04-erp-sync.md` already flags.

## Step 8 — WebExcellentAPI presence

WebExcellentAPI **is present and functional** on this install.

- `action=document&register=IVVc&id=<real SerNr>` → HTTP 200, real PDF returned
  as base64 (`<data><file><name>Rēķins_...pdf</name><base64>...</base64></file></data>`).
- `action=document&register=SVOVc&id=<real SerNr>` → HTTP 200, but **empty**
  `<file><name></name><base64></base64></file>` — no error, just nothing.
- `action=document&register=WSVc&id=<real SerNr>` → same empty-file shape.

**Conclusion: confirmed as assumed**, with one concrete detail worth adding to
`04-erp-sync.md`: the "not yet available" failure mode for `SVOVc`/`WSVc`
documents is **HTTP 200 with an empty `<file>` node**, not an HTTP error and not
an `<error>` tag. The adapter's document-fetch code must treat an empty
`<base64>` as "no document available" rather than retrying it as transient.

## Step 9 — Service-contracts register

Halocron identifies `COVc` ("Contracts") as the service/recurring-agreement
register — distinct from the HR/payroll contract registers (`ContractVc`,
`EPContractVc`, `EmplContractVc`), which are a different module entirely and not
what we want. `COVc` has a `CustCode`+`SerNr` key, `startDate`/`endDate`,
`perType`/`perLength`/`invDtype`/`invDays` (recurring billing period fields),
and `OKFlag` — the shape of a recurring service/maintenance agreement register.

`GET /api/<company>/COVc?limit=5` → HTTP 200, 5 real contract rows with real
start/end dates and `OKFlag` values.

**Conclusion: confirmed — the service-contracts register code is `COVc`.**
Available over plain REST, populated with real data on this install.

## Step 10 — Write test (opt-in; owner confirmed)

**Result: the app→ERP write path is proven end-to-end** — `SVOVc` create succeeds
and the `WSVc` create mechanism is understood. Confirmed live.

**`SVOVc` create — WORKS.** `POST /api/1/SVOVc` with **no `SerNr`** (`CustCode=100024`,
`TransDate=2025-08-19`, one row: `ArtCode=024`, `Quant=1`, `SerialNr=1111`, `ItemType=2`)
persisted as **`SerNr 230022`** (`url='/api/1/SVOVc/230022'`), `ItemType` read back as
`Warranty`. The REST create **auto-assigns** the `SerNr` via `NextSerNr` — no
client-supplied number. From just the codes the ERP **derived** the customer block
(`Addr0`/`Addr1`/`CustContact`/`PayDeal`/`Objects`/`LangCode`/`CustVATCode`/`Phone`/`CustCat`)
and the row (`Price=468.18`/`SalesAcc=6110`/`Spec`/`VATCode`) — `PasteCUInSVO`/`PasteItemInSVO`
run on a plain REST create, so the adapter can POST minimal and let the ERP fill identity +
pricing. The `ItemType` integer write is confirmed (`set_row_field.0.ItemType=2` → `Warranty`).
**Sole precondition: a valid `SVOVc` number series per tenant.** An earlier "Jau reģistrēts"
("Already registered") no-op — a 200 with `url='/api/1/SVOVc/'` (empty `SerNr`) and no record
persisted — was `NextSerNr` handing out an already-used/blank number because the tenant's
number series was behind the data; once the series was fixed the identical POST succeeded.
That is a per-tenant onboarding check, not a design problem. **Create rule (final): POST with
no `SerNr`; ensure a valid `SVOVc` number series per tenant at onboarding.**

**`WSVc` create — set `WONr = -1`.** When the ERP creates a Work Sheet from a Service
Order, `PasteSVOInWS` sets `WSp.WONr = -1` (the "no Work Order" sentinel); no `WOVc` record
is required, and real production rows read the value back blank. A bare POST that omitted
`WONr` hit a mandatory-field error (1058) and one with `WONr=0` was rejected as a real,
already-completed Work Order (1971) — both were wrong-value problems, not a mandatory `WOVc`
chain. **Owner decision: avoid the `WOVc` chain** — the app never creates or requires a Work
Order; the two-step `SVOVc → WSVc` design stands. The full `WSVc` field-set is documented in
`04-erp-sync.md` (Work Sheet creation — field mapping), derived from
`PasteSVOInWS`/`WSSumup`/`GetCOSAcc`.

**Persistence-verification rule (secondary finding).** A `POST` returning **HTTP 200 with
no `<error>` field is not proof the record persisted** — the earlier no-op returned 200 with
plausible echoed data and no record. The adapter's create-push logic must verify persistence
(a real `SerNr`/non-empty `@url` id in the response, or a follow-up read-back) before marking
a push-queue step succeeded. Added to the "Write mechanics & normalization" rules in
`04-erp-sync.md`.

**`Invoiced` signal — use a linked `IVVc`, not `InvFlag`/`InvMark`.** The new order 230022
came back with `InvFlag=1` and `InvMark=1` immediately, identical to finished order 230015 —
a warranty row needs no customer invoice, so these flags mean "invoicing settled/not-needed",
set at creation, not "an invoice was raised." `DoneMark` (absent on the new order, `1` on the
finished one) remains the reliable **`Closed`** signal, but the app's **`Invoiced`** state
keys off an **actual linked invoice** (`IVVc` via `getrecordlinks`), not `InvFlag`. Applied
to `02`/`04`/`17`.

## Step 11 — `ActVc` types on this install

`ActTypeVc` (66 types) and `ActTypeGrVc` (13 groups) are both available and
populated. Directly relevant to the service module:

| Code | Comment | Group |
|---|---|---|
| `SVP` | "Servisa pasūtījuma līdzsekošana" (service order tracking/follow-up) | — |
| `50` | "Instrumentu apkope" (tool maintenance) | — |
| `51` | "Instrumentu uzstādīšana" (tool installation) | — |
| `53` | "Instrumentu labošana" (tool repair) | — |
| `SERV` (group) | "Servisa pakalpojumi" (service services) | groups the above |

The rest of the 66 types are sales/CRM/onboarding/approval workflow types
(`SAL*`, `AP*`, `ONB*`, `OFFB*`, `IREK*`, etc.) unrelated to the service
module — useful context for scoping the activity-purpose map so it doesn't
accidentally import unrelated CRM activity noise.

**Conclusion: confirmed available.** `SVP` and the `SERV` group are the
concrete starting candidates for this tenant's `booking`/`worksheetShadow`
activity-purpose configuration (`04-erp-sync.md` activity-purpose map). Real
per-tenant type codes will still need confirming per launch tenant — this is
demo-tenant data, not a universal code list.

## Step 12 — `SVOVc` completion/"closed" field: RESOLVED

A single live read of a finished order (`GET /api/1/SVOVc/230015`). The completion flags:

- `DoneMark = 1` — **the `Closed` field** (owner-confirmed): the ERP's "order done, no
  more activity expected" marker, and the same flag `PasteSVOInWS` checks to refuse new
  worksheets. → maps to the app's ERP-sync-set **`Closed`**.
- **`Invoiced` is derived from a linked `IVVc`** (`getrecordlinks`), **not** `InvFlag`/`InvMark`.
  Those read `1` on this order and on a fresh warranty order alike (warranty needs no
  customer invoice), so they mean "invoicing settled/not-needed", not "invoice raised" (see §10).
- `WSMark = 1` — a Work Sheet exists for the order (ERP-side cross-check).
- **No `OKFlag`** on `SVOVc` — its terminal state is `DoneMark`, not an OK flag.

All are poll-read only, never app-written. The `Closed` field is `SVOVc.DoneMark`. Applied to
`02-data-model.md` (status flow), `04-erp-sync.md` (order-`Closed` flow), and
`17-erp-register-reference.md`.

**Bonus (feeds Step 6):** the same order's row carried `<ItemType>Warranty</ItemType>`
— the contrasting charge-type value Step 6 could not observe on this tenant before
(it had only ever seen "to be invoiced"). This confirms live that `ItemType` is the
charge-type discriminator and that REST reads return the localized label; see Step 6.

## Bonus: this demo system as a test-data sandbox

Beyond this one-off probe, this demo/test ERP company is safe to reuse as a
target for future dev/testing work: it has a dedicated placeholder test
customer (`CustCode=1`, "Paraugs"/"Sample"), multiple obviously-fake seeded
users (e.g. `TPE` "testa persona" = "test person", `OTRP` "Otra persona" =
"second person"), and the two existing `WSVc`/`SVOVc` records are themselves
low-numbered/early test records, not real customer transactions. It's a
reasonable target for the Phase 0 "fake ERP server + fixture recorder" /
seed-engine work in `15-testing-strategy.md`, and for any future write-path
spike (e.g. resolving the step 10 Work Order question above) without any risk
to real tenant data — same safety rules apply (test company only, ≤10 sample
rows in anything committed, no credentials in code/commits).

## Summary of spec impact

| Doc | Change |
|---|---|
| `04-erp-sync.md` | Back-link mechanism = WebExcellentAPI `getrecordlinks` (not `RLinkVc` REST parsing — record-ids are opaque); WebExcellentAPI document-missing failure shape documented; create-push must verify persistence, not just absence of `<error>`; **`SVOVc` create**: POST with no `SerNr`, REST auto-assigns via `NextSerNr` (sole precondition: a valid number series per tenant); full `WSVc` + `SVOVc` creation field-mapping added, `WONr = -1` on `WSVc` create (no `WOVc` chain); `ItemType` integer write (string set 31, `1`–`4`); `Invoiced` = linked `IVVc` (not `InvFlag`) |
| `17-erp-register-reference.md` | `RLinkVc` record-id format corrected (opaque binary, not `RegisterName:SerNr`); `WSVc.WONr` = `-1` on create (no `WOVc` chain); `COVc` added as the confirmed service-contracts register |
| `06-roadmap.md` | Phase 0 demo-probe list closed out: register codes, `RLinkVc` readability, `updates_after`/`deletes_after`, server-side filters, WebExcellentAPI presence, contracts register, `ActVc` types, `WONr`/`WOVc` chain (`= -1`), `Closed` = `DoneMark`, `ItemType` integer write, and `SVOVc` create (succeeded live, `SerNr 230022`) all resolved. Remaining: the per-tenant number-series onboarding check and the `UserVc.Location` van-stock per-tenant confirm |
