# Phase 0 ERP demo-system probe — session handoff

Status: v0.1 (2026-07-06). This is a **work order for a Claude Code session** running in an environment where the demo-ERP env vars are set. Execute the checklist, record results, and deliver them as spec updates via a PR to `preview`.

## Context

The register verification round (`16-spec-review-round-3.md` §6, findings in `04-erp-sync.md` + `17-erp-register-reference.md`) resolved the service-register unknowns from documents and the halocron dictionary. What remains needs a **live system**: this probe. Everything here is read-only except step 10, which is opt-in.

## Setup

1. **Find the credentials**: check `env` for the ERP connection variables (expected names like `ERP_DEMO_BASE_URL`, `ERP_DEMO_COMPANY`, `ERP_DEMO_USER`, `ERP_DEMO_PASSWORD` — but take whatever ERP-ish names are present). Never print values; never write them to any file or commit.
2. **Connectivity**: `curl -sS -u "$USER:$PASS" "$BASE_URL/api/$COMPANY/UserVc?limit=1" -H "Accept: application/json"` — expect 200 + JSON. If TLS/proxy errors: the environment routes HTTPS through an agent proxy (CA bundle `/root/.ccr/ca-bundle.crt`); do not disable TLS verification.
3. **Tools**: the halocron MCP (register dictionary, HAL source) answers field-semantics questions — use it before guessing.
4. Work on a branch off `origin/preview`; PR back to `preview` when done (do not push to `preview` directly).

## Probe checklist

Record per step: request made (sans credentials), HTTP status, relevant response fragment (≤10 sample rows, mask any real personal data — org data-classification rules apply even on demo systems).

| # | Probe | How | What to record |
|---|---|---|---|
| 1 | Auth + register availability | `GET /api/$COMPANY/<reg>?limit=2` for `SVOVc`, `WSVc`, `SVOSerVc`, `DelAddrVc`, `ItemStatusVc`, `RLinkVc`, `UserVc`, `CUVc`, `INVc`, `ActVc` | which respond, field names vs `17-erp-register-reference.md` |
| 2 | `updates_after` on service registers | `GET /api/$COMPANY/SVOVc?updates_after=0` and same for `WSVc`; compare with `CUVc` (base register, should work) | supported/ignored/error; `@sequence` presence in responses |
| 3 | `deletes_after` behavior | same shape as #2 | supported at all (spec assumes unreliable) |
| 4 | Server-side filters | `GET /api/$COMPANY/WSVc?filter.CustCode=<existing code>` vs unfiltered scan | does the filter actually filter (spec treats it as optimization only) |
| 5 | `RLinkVc` over plain REST | `GET /api/$COMPANY/RLinkVc?limit=5`; then find links of a real invoice (`FromRecidStr`/`ToRecidStr` format) | REST-readable? record-id string format; **decides the invoice back-link implementation** (`04-erp-sync.md`) |
| 6 | Charge-type row fields | read a real `WSVc` record with rows; inspect `Invd`, `ovst`, `Returned` + ask halocron what marks a row warranty/non-chargeable | which field(s) carry invoiceable/warranty per row |
| 7 | `UserVc.Location` vs `ServLocation` | read a few `UserVc` rows | which is populated on this install (van-stock convention) |
| 8 | WebExcellentAPI presence | `GET $BASE_URL/WebExcellentAPI.hal?...` probe (Basic auth, force HTTP/1.1); try `action=document` for an `IVVc` record (known-good) and for `SVOVc`/`WSVc` (expected missing — ERP-side work in progress) | tier available? which documents printable |
| 9 | Service-contracts register | ask halocron for the contracts register code (service agreements), then `GET` it | code + availability (last unverified register) |
| 10 | **Write test — opt-in, test company only** (skip unless the owner explicitly confirmed writes are OK) | `POST /api/$COMPANY/SVOVc` minimal order → `POST WSVc` with `SVONr` + one item row (`UpdStockFlag`, `Location` set); read `ItemStatusVc` for that item×location before/after → confirm **no stock change**; leave the record un-OK'd and ask the owner to OK it in the ERP, then re-read: `OKFlag=1`, stock decreased, `RLinkVc` links created | end-to-end confirmation of the worksheet flow in `04-erp-sync.md` |
| 11 | `ActVc` types on this install | `GET /api/$COMPANY/ActTypeVc?limit=…` + `ActTypeGrVc` | available type/class-group codes (candidates for the activity-purpose map) |
| 12 | `SVOVc` completion/"closed" field | Read a handful of finished (invoiced) orders; inspect `DoneMark`, `InvMark`, and any of the remaining ~29 unmapped fields (full field list via halocron `list_registers SVOVc`) for a boolean/date that means "this order is closed, no more activity expected" | which field(s) the app should read to set the app's `Closed` order state — round-6 decision in `02-data-model.md`/`04-erp-sync.md` is ERP-sync-set, field TBC |

## Deliverables

1. `docs/19-demo-probe-results.md` — the findings, one section per step, conclusion per open question.
2. Updates where results decide something: `04-erp-sync.md` (back-link mechanism, charge-type fields, updates_after assumption → confirmed/corrected), `17-erp-register-reference.md` (corrections), `06-roadmap.md` (shrink the Phase 0 remaining list).
3. Regenerate the spec viewer (`node scripts/build-spec-viewer.mjs`), commit, push the branch, **open a PR to `preview`**.

## Safety rules

- Read-only by default; step 10 only with explicit owner go-ahead, only against the test company.
- No credentials in files, commits, logs, or chat output.
- Sample data: ≤10 rows per register in any committed artifact; anonymize anything that looks like real customer/person data.
