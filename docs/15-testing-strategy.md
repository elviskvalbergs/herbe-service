# herbe.service — Testing Strategy (TDD)

Status: v1.1 (2026-07-07) — consistency pass: crew suites rewritten for the one-worksheet-per-technician model (round 6), scoped-replication suite added (`03-architecture.md` v0.4 design), phase hooks corrected (ActVc mapping, write mechanics and auth suites claimed by their real phases), provisioning-ADR reference aligned with the roadmap's Phase 0 list. Previous: v1.0 (2026-07-05, product owner directive: TDD everywhere; everything automatable is automated; the rest listed explicitly for the owner to arrange — §6).

## 1. Policy

- **TDD is the default working mode.** Every behavior named in docs 02–12 lands as a failing test before its implementation: red → green → refactor. A task is not "done" without its tests; a bug fix starts with the regression test that reproduces it.
- **Spec rules are executable.** The tables and rules in the spec map 1:1 to named test suites (traceability below, §3). When the spec changes, the corresponding suite changes in the same PR.
- **CI blocks on red.** Unit + integration + E2E smoke run on every PR; merge is blocked on failure. Coverage gates: ≥90 % lines/branches on the core-logic packages (state machines, mappers, sync engine, transformation sandbox, projector, coverage/rollups), ≥80 % overall. Coverage is a floor, not a target — the real gate is "every spec rule has a suite".
- Performance budgets (`03-architecture.md`) are CI assertions (Lighthouse CI + scripted timings on throttled CPU), re-verified on real devices per release (§6.3).
- Tooling: **Vitest** (unit/integration, portal convention), **Playwright** (E2E, incl. offline emulation and PWA install), **Testcontainers Postgres** (integration DB), **Gotenberg container** (PDF render smoke, Phase 2), **Mailpit** (email capture). All run headless in CI.

## 2. The architecture is test-shaped — keep it that way

The hard parts of this product are deliberately pure logic with injected I/O; that is what makes TDD viable. Design rule (enforced in review): **no business rule may live inside an HTTP handler, cron route, or React component** — handlers translate, modules decide.

Three pieces of test infrastructure are Phase 0 deliverables, built before the features that need them:

1. **Fake ERP server** — an HTTP test double of the HansaWorld register API, driven by **recorded fixtures from the real test ERP** (§6.1): register list/paging, `updates_after`/`@sequence`, sequence-reset replay, `filter` unreliability mode, HSESSION lifecycle, WebExcellentAPI's HTTP/1.1-only + Basic-only behavior, control characters and locale decimals in payloads, form-encoded write echo. Every adapter behavior in `04-erp-sync.md` is tested against this double in CI — fast and deterministic. A **nightly live-contract job** replays the same suite against the real test ERP and alerts on drift (fixtures stale, ERP version changed); it never blocks PRs.
2. **Sync simulation harness** — N virtual devices (in-process clients with their own local store + outbox) against a real server + Postgres. Scenarios are scripts: work offline for a day, replay; two technicians on one crew job work their own worksheets offline (`crewGroupId` grouping stays consistent, no cross-worksheet interference); office edits a worksheet's order while its technician is offline; a job reassigned away while the old device is offline (scope-exit purge applied on reconnect — access instructions gone); manager rejects while technician is offline; duplicate merge while a device holds the old UUID; sequence reset mid-poll; push-group partial failure with DLQ retry. This harness is how every conflict/idempotency rule in `03`/`04` is proven, and it runs in CI on every PR touching sync.
3. **Golden-fixture library** — anonymized recorded ERP payloads per register (see §5.1 data rules) used by mapper tests portal-style (`tests/unit/erp/.../mappers`), plus DOCX template fixtures and expected merge outputs for the document engine.

## 3. Traceability: spec rule → suite

| Spec source | Suite (examples of cases) |
|---|---|
| `02` order-status derivation table | table-driven: every rule + rollback-on-new-worksheet + recompute-on-transition |
| `02` worksheet status flow + signature revision rule | state machine: legal/illegal transitions; signed-revision immutability; re-sign only on customer-visible change |
| `02` crew model | members follow crew bookings; one worksheet per technician under a shared `crewGroupId` (queue/list grouping); each technician owns their own worksheet's transitions; lead worksheet alone carries the signature (`signatureRef` on the rest); team-lead approval only where the tenant flag allows (`05`); per-worksheet time/distance ownership |
| `02` record merges | alias re-point, tombstone-redirect delta, outbox-op rewrite, projector re-attach |
| `02` field policies | required-blocks-transition per role × work type; server-side enforcement equals client |
| `02` HistoryEvent projector | idempotent re-run (deterministic keys), rebuild equals incremental, group-event projection/rollup |
| `03` conflict rules | harness scenarios: server-wins master data, technician-wins facts, LWW-per-field with audit, bounced transitions → inbox |
| `03` delta pull / outbox | high-water-mark correctness, tombstones, replay idempotency (duplicate ops, reordered batches) |
| `03` scoped replication | per-user scope membership feed (assignment scope + reference closure + tenant-wide small registers); scope-entry backfill emits a full upsert regardless of record seq; scope-exit purge round-trip (record incl. access instructions leaves the device store); outbox ops on records that left scope still accepted server-side; enforcement lives in the feed query — the client never filters for security |
| `04` store topology | ingest preserves app-owned fields, bumps changeSeq, conflict on same-field; trustworthy-vs-fresh never conflated (portal's CR rules as tests) |
| `04` push-queue saga | FIFO per order, dependency blocking, resume-from-failed-step, no re-post of succeeded steps, DLQ retry repairs `erpRef` |
| `04` ActVc mapping | N crew bookings ↔ 1 activity collapse/split; echo suppression (own write ignored, stale inbound never rolls back); intake-type auto-convert; unlinked-activity → inbox; purpose map routing; UTC↔ERP-local tz conversion |
| `04` quote flow | QTVc push group, status read-back → events; never auto-cancel |
| `04` write mechanics | form-encoding, row chunking/reassembly, `parsePersons`, control-char sanitize, charset fallback (against the fake ERP) |
| `08` `/api/ext/v1` | token scoping (company + customerCodes intersection), `after=` deltas, idempotent requests, confirm/feedback writes, 401/403 shapes |
| `11` coverage/rollups | `n of m` + exceptions arithmetic, coverage %, lot explosion history carry-over; spreadsheet import dry-run diff |
| `12` document engine | merge context snapshots, loops over covered units incl. exceptions, computed-field sandbox (deterministic, capped, failing function fails render cleanly), selection rules first-match, number series immutability, re-render = new version |
| `05` auth/sessions | absolute-cap JWT, `session_version` revocation, PIN rate-limit + wipe counter, enrolment one-time links |
| `07` screens | Playwright E2E: the eight workflow contracts (`07` §Core workflows) as journeys; offline execution of F1–F7 with network cut (Playwright offline + SW); briefcase download → airplane mode → full day → replay |
| Cron | dispatcher-route fan-out by due-times, advisory-lock overlap prevention, `CRON_SECRET` auth |

## 4. What automation covers honestly vs. not

Playwright's offline emulation, throttled-CPU timings and the fake ERP get us ~90 % of the risk surface deterministically. The remainder is physics and third parties — listed in §6 for the owner. Interim rule: anything in §6 that isn't arranged yet gets a **manual test script** in `docs/testing/manual/` (numbered steps, expected results, run per release and recorded), so the gap is visible, not silent.

## 5. UI/UX test enablement — seeded data, personas, test login (built into the engine)

UI tests need three things the product must provide, not the test suite improvise: known data, known users, and a fast way past login. All three ship as **product code** (owner directive 2026-07-05) — they also power sales demos, staging, and tenant onboarding examples.

### 5.1 Seed engine (`lib/seed/` + CLI + admin action)

Deterministic, scenario-based data generation — seeded faker, so **every run produces byte-identical data**: stable IDs, names, order numbers. That is what makes Playwright selectors, screenshot baselines and acceptance scripts reproducible.

Scenario packs, composable per tenant:
- `baseline` — 2 companies in one tenant (isolation tests need both), customers + sites + a service-item tree (systems/units/lots), item catalog with compatibility rows, orders/worksheets/bookings in **every status** the spec defines (incl. a signed worksheet, a rejected one, a crew job, a DLQ'd push, a conflict task), contracts, checklist templates, document templates.
- `sync-edge` — unlinked inbound activities, pending merge duplicates, sequence-reset state, half-completed push groups — the sync-admin screens (O11) get real content to test against.
- `volume` — production-scale row counts for perf budgets.
- `empty` — fresh-tenant onboarding flows.

The seed packs and the **fake ERP fixtures are generated from one source definition**, so seeded records carry matching `erpRef`s — a seeded tenant looks authentically mid-sync, and inbound/outbound flows can be exercised end-to-end without a real ERP. Seeds are versioned with the schema: CI fails if a migration lands without its seed update. A staging/demo deployment re-seeds nightly (admin "reset demo tenant" action, A8).

### 5.2 Personas (fixed test users, one per role)

Stable users with fixed UUIDs/emails across every environment: `tech.anna@…` (technician), `lead.bruno@…` (team lead), `dispatch.dace@…` (dispatcher/manager), `office.eva@…` (back office), `admin.karlis@…` (admin) — plus a second-tenant persona and a no-company-access persona for negative tests. Because personas are fixed, the **access-rights matrix becomes a generated test**: every route/action × persona → expected allow/deny, run as fast integration tests on every PR, with a thin Playwright smoke on top. Field policies get the same treatment (persona × work type × required-field matrix).

### 5.3 Test login (guarded, never in production)

- A **test-auth provider + `/api/test/login` endpoint**, registered only when `TEST_AUTH=1` **and** the deployment is not production (double guard: env flag + hard check against production domains/`NODE_ENV`; the module is excluded from production builds). It mints a real Auth.js session for a persona in one call.
- Playwright logs in **once per persona per run** via that endpoint and saves `storageState` — every test starts already authenticated as the right role; a full run costs five login calls, not five hundred.
- The auth flows themselves (magic link via Mailpit capture, PIN enrolment + unlock, TOTP, session revocation) are tested through the **real UI** in a dedicated auth suite — the bypass is for everything that isn't testing login.
- Device/PIN: a test enrolment endpoint pairs a virtual device per persona so field-shell tests run against a device-bound session like a real phone.

### 5.4 How the three test purposes use it

| Purpose | Runs | Against | Data |
|---|---|---|---|
| **Feature development** | Playwright (watch/headed) + unit, on every change | local docker compose: app + Postgres + Mailpit + fake ERP | `baseline` (+ scenario pack for the feature) |
| **Regression** | full Playwright + integration suite, every PR (smoke) and nightly (full, incl. visual snapshots on seeded screens per locale) | CI, ephemeral | re-seeded per run — deterministic |
| **Acceptance** | `@acceptance`-tagged happy-path journeys (the eight `07` workflow contracts) + human UAT with the same personas | staging deployment, nightly re-seed | `baseline` + `sync-edge` |

### 5.5 Environments via Vercel provisioning (owner directive 2026-07-05)

Test environments ride the same Vercel machinery as production — no parallel infrastructure:

- **Per-PR preview deployments** (Vercel's native behavior, same as the portal's `preview` branch flow): every PR auto-deploys to a preview URL with the **Preview environment's** env vars — `TEST_AUTH=1` lives there and in staging only, never in Production (this is the environment half of the §5.3 double guard). CI seeds the preview's database on deploy and runs the Playwright regression suite against the preview URL — UI tests hit real Vercel infrastructure (edge, headers, cron routes), not just local docker. Database per preview: Supabase branching, or schema-per-preview on a shared test project — pick in the Phase 0 provisioning ADR (on the roadmap's Phase 0 ADR list, `06-roadmap.md`).
- **Staging/demo** is a first-class entry in the fleet inventory, stamped out by the **same provisioning CLI** as customer deployments (`03-architecture.md` fleet ops) — which means provisioning itself is exercised on every re-provision, not only when a customer signs. Nightly re-seed; acceptance suite + human UAT run here.
- **The fake ERP deploys as its own small Vercel project** (it is just an HTTP app serving fixtures + scripted behaviors, state in a test DB), so previews and staging reach it like a real ERP endpoint; locally it runs in docker compose.
- Local development keeps the docker compose (app + Postgres + Mailpit + fake ERP) for the fast inner loop; previews are the shared, reviewable variant of the same thing.

Portal-side bonus: the seeded staging deployment's `/api/ext/v1` serves the same deterministic dataset — the portal team tests its service modules against it without needing our codebase (noted in their design-spec addendum).

## 6. What I need arranged (owner action list)

1. **A dedicated test ERP** — the single most important item. An Excellent Books / Standard ERP **test company** (never production) with: REST API credentials; Service Orders module enabled; **two configurations reachable** — one with WebExcellentAPI, one without (or a toggle); permission to freely create/modify/delete records; a known seed dataset we script. Used for fixture recording, the nightly live-contract job, register-code verification (Phase 0), and `updates_after`/filter capability probing. Ideally also: a copy with **realistic production-scale data (anonymized)** for full-sync/history-import performance tests — per data policy, we record structure + volumes, and only anonymized samples ever leave the instance.
2. **One planned ERP version upgrade** on that test instance during Phase 0/1, announced in advance — the only way to observe real sequence-reset behavior and validate the recovery path.
3. **Physical device set** for the per-release manual pass and real performance numbers: one mid-range Android (the <3 s cold-start reference device — fix the exact model so numbers are comparable), one recent iPhone (installed-PWA push on iOS ≥16.4, Safari quirks, camera/QR in daylight). Later (Phase 2): an NFC-capable Android and a printed QR label batch.
4. **Field-condition pass**: someone with the reference phone doing the scripted airplane-mode/flaky-network day (real radio behavior, iOS background eviction, glove/sunlight usability) once per release candidate. Can be the pilot company from Phase 1 exit onward.
5. **Test instances of herbe.calendar and herbe.portal** pointed at the same test ERP (coordination with the sibling owners) — needed for the suite round-trips: booking ↔ calendar view/Kanban drag, QTVc quote ↔ portal confirmation, document activity-vessel, and later the `/api/ext` modules. Plus the portal team's **Dokobit/Smart-ID sandbox credentials** when Phase 3 signoff E2E lands.
6. **A Microsoft Graph test tenant/mailbox** (or approval to run SMTP-only in test) for the real email-sender path — day-to-day email tests run against Mailpit locally.
7. **Pilot tenant commitment** (already the Phase 1 exit criterion): 2+ weeks of real work is also the acceptance test; we'll bring the checklist.

Items 1–2 are Phase 0 blockers for the adapter workstream; 3–4 are needed from mid-Phase 1; 5–7 from Phase 2/3.

## 7. Roadmap hooks

- **Phase 0**: fake ERP + fixture recorder, sync simulation harness (incl. the scoped-replication scenarios), CI pipeline with coverage gates, manual-script skeleton, first golden fixtures from the test ERP (item §6.1); the `05` auth/sessions suite lands with the walking-skeleton login. TDD from the first walking-skeleton commit.
- **Phase 1**: full suites for the field loop — every `02` and `03` row of the §3 table, plus `04` store topology, push-queue saga, **ActVc mapping** and **write mechanics** (both ship in Phase 1: bookings sync two-way from the MVP); Playwright offline journeys (`07` row); perf budgets in CI; manual device pass per release.
- **Phase 2+**: document-engine suites (Gotenberg in CI), `11` coverage/rollups suites, `/api/ext` contract tests published as fixtures the portal team can test against (re-cut to the reduced portal-integration surface — `06-roadmap.md` open item 2), `04` quote-flow suites (Phase 3), suite round-trip tests on the shared test ERP.
