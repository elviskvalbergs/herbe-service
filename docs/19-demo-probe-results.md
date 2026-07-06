# herbe.service — demo-ERP probe results

Status: v0.1 (2026-07-06). Executed against the live demo Standard ERP install per the
work order in `18-demo-probe-handoff.md`. All requests used the `ERP_DEMO_*`
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

**Conclusion: partially resolved.** `ItemType` is the strongest charge-type
candidate and appears ERP-computed rather than client-set — this needs
confirmation against a warranty-covered service item (a `SVOSerVc` unit with
active `WarrantyStatus`/`LaborCovered`/`PartCovered`) to see the contrasting
value, which this demo tenant's available data didn't have. **Follow-up probe
needed** once a warranty-covered test unit exists on the demo system, or ask
halocron/Excellent directly for the `WSIVVc.ItemType` (`M4Int`) enum's full
value list — `list_registers` returns type/size but not enum members, and
`query_rag` didn't surface the enum body in this session's queries.

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

**Conclusion: open item for the owner, not a confirmation.** Two real
possibilities, and we can't distinguish them from the demo system alone:

- (a) This demo tenant has a "Work Orders" module/setting enabled that a real
  launch tenant might not have — in which case this is a demo-specific
  artifact, not a general finding.
- (b) The Standard ERP service module genuinely requires **Service Order →
  Work Order → Work Sheet** as a three-step chain when the Work Orders
  feature is on, and `04-erp-sync.md`'s current two-step
  `SVOVc → WSVc` push design would hard-fail on any tenant configured this
  way.

**Recommendation:** ask Excellent (or check via halocron/HAL source) whether
"Work Orders required before Work Sheet" is a per-tenant module setting, and
if so, whether the launch tenant(s) have it on. If any do, the push-queue
design needs an additional `WOVc`-creation step between order and worksheet,
which is not currently planned anywhere in `04-erp-sync.md`.

**Secondary finding, independent of the above:** a `POST` that returns
**HTTP 200 with no `<error>`/`error` field is not proof the record was
persisted** — the `SVOVc` attempts prove this concretely (200, plausible-looking
echoed data, silent no-op). The adapter's create-push logic must verify
persistence (e.g., a real `SerNr`/non-empty `@url` id in the response, or a
follow-up read-back) before marking a push-queue step as succeeded, in
addition to checking for an explicit `<error>` tag. This should be added to
the "Write mechanics & normalization" rules in `04-erp-sync.md`.

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
| `04-erp-sync.md` | Back-link mechanism decided (WebExcellentAPI `getrecordlinks`, not `RLinkVc` REST parsing); WebExcellentAPI document-missing failure shape documented; create-push must verify persistence, not just absence of `<error>`; **new open item**: Work Order (`WOVc`) chain question for the owner |
| `17-erp-register-reference.md` | `RLinkVc` record-id format description corrected (opaque binary, not `RegisterName:SerNr`); `WSVc.WONr` corrected from "unused by us" to "required on create on at least one install — confirm per tenant"; `COVc` added as the confirmed service-contracts register |
| `06-roadmap.md` | Phase 0 "remaining for the demo-system probe" list shrinks: register codes, `RLinkVc` readability, `updates_after` assumption, `UserVc` convention, WebExcellentAPI presence, contracts register code, `ActVc` types are all resolved (fully or as "confirmed per-tenant, not universal"); charge-type field and the Work Order chain question carry forward as open items |
