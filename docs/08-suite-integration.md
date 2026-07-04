# herbe.service — Suite Integration & Reuse (herbe.calendar, herbe.portal)

Status: draft v0.1 (2026-07-04). Written from a code-level review of both sibling repos (calendar `main`-merge b57fcbd, portal v1.0.24). Defines the integration contracts and the reuse plan; the corresponding review findings are in `09-spec-review.md`.

## 1. Suite reality (verified, not assumed)

| | herbe.calendar | herbe.portal | herbe.service (this spec) |
|---|---|---|---|
| Role | Employee scheduling over ERP activities + Outlook/Google/Zoom | Customer self-service over ERP registers (invoices, quotations, deliveries, e-sign, payments) | Field service execution (orders → work → approval → ERP invoice) |
| Stack | Next.js 16, React 19, Tailwind 4, Neon + raw `pg`, Auth.js v5 | Next.js 16, React 19, Tailwind 4, Neon + Drizzle, Auth.js v5 | same; Drizzle on **Supabase Postgres** (decided 2026-07-04) |
| Tenancy | one deployment, many `tenant_accounts` | one deployment + one Neon DB **per customer** (provisioning CLI) | ADR in `03-architecture.md`; portal model recommended |
| Auth providers | email magic-link only | password+TOTP, magic link, Google, Smart-ID, Dokobit, eParaksts | portal set + Entra ID OIDC |
| ERP client | `lib/herbe/*`: REST + `updates_after`/`@sequence`, OAuth refresh, two-way `ActVc`, WebExcellentAPI | `lib/erp/*`: `ErpAdapter` contract, register cache + sync runner, WebExcellentAPI (PDF, attachments, activities), write-backs | extends portal contract + calendar's incremental/write mechanics (`04-erp-sync.md`) |
| i18n | none | next-intl, `lv,en,et,lt,fi,sv,no` + per-deployment overrides | portal setup reused |
| Cross-app links | `hansa://{serp_uuid}/v1/{company}/{register}/{id}` deep links | same scheme ("lifted from herbe-calendar so behavior is consistent") | same scheme + web deep links below |
| Shared packages | none — conventions are copied between repos, with attribution comments | none | drive extraction (§6) |

**Key consequence:** there is no suite event bus, no outbound webhooks, no shared identity provider, and no shared library today. Integration designs below use only mechanisms that already exist (ERP `ActVc` as a shared backbone, scoped bearer tokens, deep links) plus one new thing: herbe.service's own typed REST API.

## 2. Integration principles

1. **The ERP is the shared backbone wherever a tenant has one.** Calendar and service both speak two-way `ActVc`; the portal reads/writes the same registers. No point-to-point sync for data the ERP already carries.
2. **For app-owned data (worksheets, pre-approval statuses), the owning app exposes a typed REST API** consumed with scoped bearer tokens (portal's `analytics_tokens` pattern: hashed token, scope enum, optional company scoping).
3. **Deep links over embedded UI.** Each app renders its own domain; cross-app navigation via stable URLs (`https://service.herbe.app/c/{tenant}/orders/{id}`, portal/calendar equivalents) and `hansa://` for the ERP desktop client.
4. **Capability gating everywhere**: a tenant without herbe.calendar, without herbe.portal, or without an ERP simply doesn't see the corresponding affordances (portal's WebExcellentAPI gating discipline, applied suite-wide).

## 3. Calendar ↔ service: booking planning

**ERP-connected tenants (primary path).** Bookings mirror to `ActVc` per `04-erp-sync.md`; herbe.calendar already renders and edits `ActVc` two-way. Result without any calendar code change: a booking planned in herbe.service appears on the technician's calendar (and Outlook, via calendar's own sync), and an activity created/moved in calendar or ERP flows back into service as a booking update on the fast poll cadence. Conflict rule: service accepts inbound moves unless the linked worksheet is `In progress` or later — then the move bounces to the dispatcher's inbox (a booking can't retroactively contradict executed work).

**Service-aware calendar features (new work in herbe-calendar, high level, phased with service Phase 2–3):**
- **C1 — service activity recognition**: per-account config mapping service activity types (the same `ActVc` type codes service writes); recognized activities get a service badge/color class group.
- **C2 — service context on the activity**: `ActivityDrawer`/`ActivityBlock` show order number, site, worksheet status for recognized activities. Transport: service writes these into agreed `ActVc` fields (TextInMatrix rows / customer+item codes it already sets) — no new API needed for read; a deep link **"Open in herbe.service"** button follows the URL scheme in §2.3 (calendar's `serpLink.ts` pattern generalized to sibling web apps).
- **C3 — guarded editing**: recognized service activities that are `OKFlag`-locked or execution-started are read-only in calendar (calendar already honors `okFlag`); free re-planning is allowed while the booking is `planned/confirmed`.
- **C4 (later, service Phase 4)** — availability feed for dispatch assist: service queries calendar's existing availability logic (`lib/availability.ts` / share-link availability API) through a scoped API token, so the dispatch board can see non-service commitments (meetings, holidays).

**Standalone tenants (no ERP):** no `ActVc` backbone. v1 rule: calendar integration is an ERP-tenant feature; standalone tenants live in service's own My-jobs calendar (F2). If demand appears, the fallback is service publishing an ICS feed per technician (calendar already consumes ICS) — cheap, read-only, good enough.

## 4. Portal ↔ service: customer surface, signoff, invoices

**Division of labor (resolves the v0.1 overlap):** herbe.service Phase 3 does **not** build a customer portal. herbe.portal grows **service modules**; herbe.service exposes the API they read. Portal already owns login for customer humans (incl. eIDs), notification prefs, invoice display + payment, e-signing.

**Detailed portal-side design spec (delivered 2026-07-04, portal roadmap slot confirmed):** `herbe-portal/docs/superpowers/specs/2026-07-04-service-modules-design.md` — includes the frozen `/api/ext/v1` contract, `service_connection_config` schema, signing descriptor, and notification keys.

**New portal modules (high level, built portal-side following its register-module playbook):**
- **P1 — Service items**: the customer's equipment registry: serials, sites, warranty/contract status, per-item service history, QR label reprint. Data source: herbe.service API (not ERP registers — the app owns richer item/history data).
- **P2 — Service orders & worksheets**: request intake form (→ service order in service, duplicate-checked), order status tracking, worksheet read-out after approval, service report PDF download, quote confirmation for out-of-contract work.
- **P3 — Worksheet/report signoff**: where a tenant wants formal digital signature instead of/in addition to on-site canvas signature, reuse the portal signing subsystem verbatim — a `SigningModuleDescriptor` for the worksheet report (pdf endpoint = service API; `onAllSigned` = callback to service marking customer-confirmed + attaching the signed file to the ERP activity, exactly like the portal's delivery-confirmation flow).
- **Invoices**: nothing new — the portal's existing invoice module (IVVc + ARVc + payment gateways) already covers invoices created from approved worksheets. Service only needs to make sure the ERP invoice lands with the order reference (`04-erp-sync.md` back-link) so the portal can show "from service order X".

**Technical contract (service side, Phase 2–3):**
- `GET /api/ext/v1/…` — service items, orders, worksheets, history; scoped per ERP customer code(s), mirroring the portal's `getUserScopeForCompany` scoping model so the portal can pass through its identity-link scope directly.
- `POST /api/ext/v1/requests` — request intake → service order (`New`), idempotency key required.
- Auth: hashed scoped bearer tokens (portal `analytics_tokens`/MCP pattern); token minted in service admin (A4/A6), stored in portal module config.
- Webhook-less v1: portal polls status on page view (its normal model — it re-syncs registers on read); a `changeSeq` delta parameter keeps polls cheap.

## 5. Users & SSO across the suite

- Employee identity: service reuses calendar's `person_codes` concept for user↔ERP-employee mapping (`05-users-auth.md`); where a tenant runs both apps against one ERP, the mapping data is the same and should be entered once — Phase 2: import/sync person links from calendar's table (same Neon org) or via a small admin import.
- Customer identity: portal's `identity_links` stays portal-owned; service's customer-facing data is scoped by ERP customer codes, which is the shared key.
- SSO: not built anywhere today (§1). Near term: same email + same auth methods = low friction. Suite SSO (one Auth.js issuer app, or Entra ID as broker for employee-side apps) is a suite-level ADR — recommended to decide before service Phase 2, not blocking Phase 0/1.

## 6. Reuse inventory & mechanics

Ranked by value; "coupling" = what must be untangled to reuse outside the source repo.

| Asset | Source | Coupling | Plan |
|---|---|---|---|
| `ErpAdapter` contract + registry + credential envelope | portal `lib/erp/{types,registry,credentials}.ts` | types.ts is import-clean; registry/creds touch portal DB | **Extract to `@herbe/erp-core`** (Phase 0) |
| Standard Books REST + WebExcellentAPI clients, mappers | portal `lib/erp/standard-books/*` | clients are DB-free; cache stores are Drizzle-bound | Extract clients+mappers; service implements its own cache stores on the shared pattern |
| `updates_after`/`@sequence` incremental sync, OAuth refresh, `ActVc` save (form-encoding, row chunking) | calendar `lib/sync/erp.ts`, `lib/herbe/{client,actVcSave}.ts` | moderate (calendar tables) | Fold the mechanics into `@herbe/erp-core`; calendar migrates opportunistically |
| Email template engine (TemplateKey/TemplateDataMap/CHANNELS, MJML render, admin editor) | portal `lib/email/*` | render layer DB-free; dispatch reads `email_config` | Extract render+types as `@herbe/email-templates`; service owns its dispatch/config tables |
| Signing subsystem (Dokobit/eParaksts/Smart-ID gateways, runners, typed signature pad) | portal `lib/{signing,dokobit,eparaksts,smartid,signature}` | gateways DB-free; runners bound to `signing_*` tables | Phase 3, used portal-side (§4 P3) — no extraction needed initially |
| Auth.js config, credentials/TOTP/magic-link providers, session-version | portal `lib/auth/*` | bound to portal user tables | Copy-first into service schema; extraction later |
| i18n setup + locale files structure + overrides admin | portal `lib/i18n/*`, `locales/` | light | Copy-first |
| Cron conventions (CRON_SECRET, advisory locks, handoff docs) | both | none | Copy-first |
| Migration runner (build-time + admin UI) | portal `scripts/migrate-prod.mjs`, `/admin/run-migrations` | light | Copy-first |
| Provisioning CLI (Neon+Vercel+domain per customer) | portal `lib/provisioning/*` | portal-specific env | Reuse if portal tenancy model chosen (ADR) |
| Admin shell, register list/detail components, status badges, theming | portal `components/*`, `lib/theming` | Tailwind tokens; medium | Copy-first, align via design system when its repo lands |
| Docs wiki loader + DocLink | portal (`DocLink`) / calendar (loader) | light | Copy-first |
| Deep links (`hansa://` builder) | calendar `lib/serpLink.ts` (already copied into portal) | none | Copy (third consumer strengthens the case for `@herbe/erp-core`) |
| Scoped bearer tokens (hashed, company-scoped) | portal `analytics_tokens` + `lib/mcp/auth` / calendar `api_tokens` | light | Copy pattern for `/api/ext` (§4) |
| APNs + native iOS shell + mobile token pairing | calendar `ios/`, `lib/apns.ts`, `lib/mobileAuth.ts` | moderate | Phase 2/3 reference when native wrapper lands |
| AES-GCM credential crypto | calendar `lib/crypto.ts` / portal `lib/security/envelope.ts` | none | Use portal's envelope format (key-id + rotation-friendly) |

**Mechanics — DECIDED 2026-07-04:** extract **only** `@herbe/erp-core` and `@herbe/email-templates` now (highest churn, highest duplication cost — service would be the third copy of the ERP client), copy-first everything else with attribution. Don't block Phase 0 on extraction: if it takes longer than two weeks, copy-first and extract in Phase 2.

## 7. End-to-end workflow across the suite

```
 herbe.calendar          herbe.service                    ERP                    herbe.portal
──────────────          ─────────────                    ───                    ────────────
 plan/move activity ──► booking (ActVc sync) 
                        dispatch → worksheet
                        execute offline, sign on site
                        manager approves ────────────► worksheet + stock txn
                                                        invoice created
                        order → Invoiced  ◄──────────── IVVc read-back ────────► invoice module (pay)
                        service report PDF ───────────────────────────────────► P2 module (view/sign-off P3)
                        history event                                            P1 service item history
```
