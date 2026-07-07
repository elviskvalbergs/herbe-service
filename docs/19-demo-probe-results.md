# herbe.service — demo-ERP probe results

Status: v0.3 (2026-07-07, later same day: step 12 **ran** via a live read of finished
order 230015 — the `Closed` field is `SVOVc.DoneMark`, and the read also delivered the
contrasting `ItemType` = Warranty value that resolves Step 6; both sections updated. The
`SVOVc` create no-op is diagnosed as a `SerNr` collision, §10). Previous: v0.2 (2026-07-07,
step 12 recorded as not-yet-run). Previous: v0.1 (2026-07-06).
Executed against the live demo Standard ERP install per the
work order in `18-demo-probe-handoff.md` — **steps 1–11 only; see step 12 below**. All requests used the `ERP_DEMO_*`
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
a freshly-generated `SVOVc` row (from the step 10 write attempt, see below).

Findings:
- `ItemType` (a row field present on both `SVOVc` and `WSVc`/`WSIVVc` rows) carries
  a real, human-readable classification string, not an internal code — every
  sample we saw (including one the ERP itself generated live, un-set by us) came
  back as `"Jāizr.rēķ."` (Latvian, "to be invoiced"). Since the ERP computed
  this value itself even for a bare create attempt where we did not set it, this
  is strong evidence `ItemType` is the charge-type discriminator field, defaulted
  to "invoiceable" for a plain non-contract, non-warranty item/customer
  combination.
- `Invd` (invoiced quantity) matched `Quant` exactly on an already-OK'd/invoiced
  worksheet row, and was blank on a not-yet-OK'd row — consistent with its
  documented meaning.
- `ovst` and `Returned` were `0`/blank on every sample row available on this
  install; we could not observe a contrasting warranty/goodwill/returned-parts
  value in the demo data.

**Conclusion: RESOLVED (updated 2026-07-07).** `ItemType` is the charge-type
discriminator, confirmed two ways: (1) the owner supplied the enum definition —
Standard ERP string set 31: `0` = "-", `1` = Invoiceable, `2` = Warranty, `3` =
Contract, `4` = Goodwill (a 1:1 match to the app's charge types); (2) the Step-12
live read of finished order 230015 returned a **contrasting** value at last —
`<ItemType>Warranty</ItemType>` on the row (the earlier samples only ever showed
"to be invoiced"), proving the field carries the real per-row charge type and that
REST **reads** return the localized label. The push **writes the integer** `1`–`4`
(owner). The `GetCOSAcc` HAL logic corroborates the semantics: `SVOItemType` 1/2/3/4
selects the item's `SVOInvbleCostAcc`/`SVOWarrantyCostAcc`/`SVOContractCostAcc`/
`SVOGoodwillCostAcc`. `Invd` (invoiced qty) behaves as documented; `ovst`/`Returned`
stay unconfirmed (no sample), folded into the one remaining write test (integer
write format + `QtyInvbl`).

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

**Result: both create attempts failed to persist. This surfaced a real,
unresolved gap in the assumed worksheet-push design.**

1. `POST /api/<company>/SVOVc` with a minimal header (`CustCode=1`, `TransDate`,
   a unique `ConfirmationNo` marker) + one row (`ArtCode=00125`, `Quant=1`) →
   **HTTP 200**, with the record echoed back (including an ERP-computed
   `ItemType` on the row — see step 6) and a message `"Jau reģistrēts"`
   ("Already registered"). **No `SerNr` was assigned and no record was
   persisted** — confirmed by an exact-match lookup on the unique
   `ConfirmationNo` marker returning zero rows, tried twice with two different
   markers.
2. A direct `WSVc` create attempt (not linked to a real order, to isolate the
   mechanism) returned a clear, structured error instead of a silent no-op:
   `{"error":{"@code":"1058","@field":"WONr"}}`, message `"Obligāti
   jāaizpilda-1"` ("Mandatory to fill"). **`WONr` (work-order number) is a
   required field for `WSVc` creation on this install** — despite
   `17-erp-register-reference.md` currently describing it as "unused by us;
   ERP-internal chain."
3. Retrying with `WONr=0` explicitly set produced a *different* error:
   `{"error":{"@code":"1971","@field":"WONr"}}`, message `"Darba uzdevumu
   nevar sākt, ja tas jau ir pabeigts"` ("The work order cannot be started if
   it is already completed") — i.e. `WONr` is validated as a real foreign key
   into a **separate Work Order register**, and `0` resolves to something the
   ERP considers an already-completed work order, not "no work order."

Real production `WSVc` rows on this same install have `WONr` blank — so
existing records were created through a path that doesn't hit this
validation (almost certainly the ERP's own UI "paste from order" action,
which the existing spec already names as `RecordAction_raPasteSVOInWS`).
That path evidently populates or bypasses `WONr` in a way a bare REST POST
does not.

**This did not touch stock or create any persisted test data** — both create
attempts genuinely failed, so there was nothing to check in `ItemStatusVc`
before/after, and nothing to ask the owner to OK. The rest of the step-10
chain (POST worksheet row, confirm no stock change, owner OK's it, re-read
`OKFlag=1`/stock decrease/`RLinkVc` links) could not run.

**Conclusion — RESOLVED 2026-07-07 (owner + ERP source `PasteSVOInWS`): set `WONr = -1` on create.** The `WONr` failures were a wrong-value problem, not a mandatory `WOVc` chain. When the ERP creates a Work Sheet from a Service Order, `PasteSVOInWS` sets `WSp.WONr = -1` — the "no Work Order" sentinel. Our probe used `0`, which the ERP validated as a real, already-completed Work Order (error 1971); omitting it hit the mandatory-field error (1058). With `-1`, no `WOVc` record is required. Real production rows read back blank because `-1` presents as none. **Owner decision: avoid the `WOVc` chain** — the app never creates or requires a Work Order; the two-step `SVOVc → WSVc` design stands. The full `WSVc` field-set is now documented in `04-erp-sync.md` (Work Sheet creation — field mapping), derived from `PasteSVOInWS`/`WSSumup`/`GetCOSAcc`. (The earlier (a)/(b) "is Work Orders a mandatory module" framing is moot: it's optional and we opt out.)

**Secondary finding, independent of the above:** a `POST` that returns
**HTTP 200 with no `<error>`/`error` field is not proof the record was
persisted** — the `SVOVc` attempts prove this concretely (200, plausible-looking
echoed data, silent no-op). The adapter's create-push logic must verify
persistence (e.g., a real `SerNr`/non-empty `@url` id in the response, or a
follow-up read-back) before marking a push-queue step as succeeded, in
addition to checking for an explicit `<error>` tag. This should be added to
the "Write mechanics & normalization" rules in `04-erp-sync.md`.

**`SVOVc` no-op — diagnosed 2026-07-07 (halocron HAL source).** The
"Jau reģistrēts" ("already registered") no-op is a **`SerNr` collision**, not
a missing field. The ERP's own creates allocate the number via
`SerNr = NextSerNr("<Reg>", TransDate, -1, false, "")` after `RecordNew`, and
the serial guard (cf. `FindNewProperIVSerNr`) refuses a store when a supplied
`SerNr` already exists ("record already exists") but allocates the next number
when it is blank. So the create must POST with **no `SerNr`** and let
`NextSerNr` assign it. Recorded in `04-erp-sync.md`.

**Live retest 2026-07-07 (owner ran it) — payload fully validated; failure is number-series, not payload.** A clean `POST /api/1/SVOVc` with **no `SerNr`** (`CustCode=100024`, `TransDate=2025-08-19`, one row: `ArtCode=024`, `Quant=1`, `SerialNr=1111`, `ItemType=2`) returned:
- `<message description='Already registered'>` and `url='/api/1/SVOVc/'` (**empty `SerNr`**) — still not persisted, and **no `SerNr` was supplied**, so the collision is `NextSerNr` handing out an already-used (or blank) number, i.e. the `SVOVc` number series for the period is misconfigured/behind the data — **not** a payload issue.
- **Everything else worked.** From just the codes, the ERP **derived** the customer block (`Addr0`/`Addr1`/`CustContact`/`PayDeal`/`Objects`/`LangCode`/`CustVATCode`/`Phone`/`CustCat`) and the row (`Price=468.18`/`SalesAcc=6110`/`Spec`/`VATCode`) — i.e. `PasteCUInSVO`/`PasteItemInSVO` **run on a plain REST create** (see the scoping note this adds to Step 6 / the REST-tier limitation). The adapter can POST minimal and let the ERP fill identity + pricing.
- **`ItemType` integer write CONFIRMED**: `set_row_field.0.ItemType=2` read back as `<ItemType>Warranty</ItemType>`. The push writes the integer `1`–`4`; done.

**Remaining (numbering only):** repair/confirm the `SVOVc` number series so `NextSerNr` yields a free number, or have the adapter supply the `SerNr`. Decisive follow-up (retry with an explicit unused `SerNr=230999`) pending; that distinguishes "series misconfigured" from "API doesn't auto-assign, client must supply the number."

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

## Step 12 — `SVOVc` completion/"closed" field: RESOLVED 2026-07-07

Ran as a single live read of a finished order (`GET /api/1/SVOVc/230015`). The
non-empty completion flags on that fully-processed order:

- `DoneMark = 1` — **the "closed" field** (owner-confirmed). This is the ERP's
  "order done, no more activity expected" marker, and the same flag `PasteSVOInWS`
  checks to refuse new worksheets. → maps to the app's ERP-sync-set **`Closed`**.
- `InvFlag = 1` — invoiced (the flag the ERP's own `SVOToInv` action gates on).
  → maps to the app's **`Invoiced`**. `InvMark = 1` is the paired display mark.
- `WSMark = 1` — a Work Sheet exists for the order (ERP-side cross-check).
- **No `OKFlag`** on `SVOVc` — its terminal state is `DoneMark`/`InvFlag`, not an OK flag.

All are poll-read only, never app-written. This **closes** the round-6 "Closed is
ERP-sync-set, field TBC" item: the field is `SVOVc.DoneMark`. Applied to
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
| `04-erp-sync.md` | Back-link mechanism decided (WebExcellentAPI `getrecordlinks`, not `RLinkVc` REST parsing); WebExcellentAPI document-missing failure shape documented; create-push must verify persistence, not just absence of `<error>`; **`WONr` resolved 2026-07-07** (`= -1` on create, no `WOVc` chain — owner + `PasteSVOInWS`); full `WSVc` creation field-mapping added; **remaining open item**: the `SVOVc` create no-op (§10 — HTTP 200, `"Jau reģistrēts"`, nothing persisted; fix by replicating the ERP's own `SVOVc` creation field-set) |
| `17-erp-register-reference.md` | `RLinkVc` record-id format description corrected (opaque binary, not `RegisterName:SerNr`); `WSVc.WONr` **resolved to `-1` on create** (no `WOVc` chain); `COVc` added as the confirmed service-contracts register |
| `06-roadmap.md` | Phase 0 "remaining for the demo-system probe" list shrinks: register codes, `RLinkVc` readability, `updates_after` assumption, `UserVc` convention, WebExcellentAPI presence, contracts register code, `ActVc` types all resolved; `WONr`/`WOVc` chain resolved (`= -1`, chain avoided); **step 12 resolved** (`Closed` = `DoneMark`) and **`ItemType` confirmed live** (Warranty value); carrying forward only: the `SVOVc` create no-op confirming write test (§10, diagnosed as a `SerNr` collision) and the `ItemType` integer-write / `QtyInvbl` check |
