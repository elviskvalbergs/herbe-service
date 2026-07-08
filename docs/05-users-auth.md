# herbe.service — Users, Auth & Roles

Status: v0.7 (2026-07-07). Role-shaped login (magic link for office, PIN + biometrics on paired field devices) on an Auth.js v5 baseline (Entra ID login exists in neither sibling today). Field-device biometric unlock is a WebAuthn platform authenticator (Face ID / Touch ID / Android biometric) that works inside the installed PWA and refreshes the session token on the same path as the PIN — no native wrapper needed; PIN/biometric unlock extends the device session token rather than forcing a full re-auth, and token revocation on scope-exit/device-deprovision purges local scoped data (`03-architecture.md`). ERP link target is the `UserVc` person code (`04-erp-sync.md`).

## Model (verified suite pattern)

Auth runs on **Auth.js v5** — both siblings do (calendar: pg adapter + DB sessions, magic link only; portal: Drizzle adapter + JWT sessions with a `session_version` revocation counter, password+TOTP, magic link, Google, Smart-ID, Dokobit, eParaksts). Each suite app runs its own independent auth instance; there is no shared auth tenant. The app's own `users` table (tenant, role, profile, status) is what the rest of the schema references. External identities attach as links, not as identity itself: removing a link never deletes the user or their history.

```
User (app table) ── IdentityLink[] ── { provider: standard-erp | excellent-books | entra-id | eid | ...,
                                        externalId, linkedAt, linkedBy }
```

## Login methods are role-shaped

- **Admins / managers / back office**: **email magic link** (the suite's shared flow — calendar's only provider, present in the portal too; reuse the known-user gating + Graph/SMTP sender pattern). Optional per tenant: password (argon2) + **TOTP** for admin roles (portal's proven implementation: `otpauth`, envelope-encrypted secret, hashed recovery codes, replay guard), Baltic eID (Smart-ID / Dokobit / eParaksts providers exist ready-made in the portal), and **Microsoft Entra ID** OIDC (net-new for the suite — a standard Auth.js provider, added per tenant when needed; optionally Graph/SCIM provisioning: auto-create from a security group, deactivate on removal).
- **Technicians**: **PIN-code login on a paired device** — a phone is enrolled once via a one-time link/QR issued by an admin (or the technician's own magic link); after that, daily field-device unlock is a **local PIN and/or a WebAuthn platform-authenticator biometric (Face ID / Touch ID / Android biometric)**, validated locally against the device-bound session. The biometric gate is the browser's WebAuthn platform authenticator (passkeys — Safari/iOS 16+, Chrome/Android), not a native FaceID API, so it works **inside the installed PWA** with no native wrapper. No email round-trip in the field: no connectivity, no inbox, gloves — a magic link can't be the daily field path.

The PIN/biometric unlock is the technician's *login*, but security-wise it is a local re-verification of a long-lived device session: the server still sees the same Auth.js session token, and each successful unlock **extends/refreshes that token's lifetime rather than forcing a full re-authentication**. Biometric follows the same token-refresh path as the PIN — it is just a nicer local gate on the identical device-bound session, not a separate server credential. A technician who unlocks with PIN or biometric keeps working offline against the same token; a full re-auth (magic link / pairing) is only needed on first enrolment, on token expiry past the extension window, or on explicit revocation. The device registry governs the token's lifetime, and PIN attempts are rate-limited with wipe-on-N-failures (tenant policy). The device-paired token is also what scoped replication rides on, so revoking it on scope-exit or device deprovision purges the local scoped data (`03-architecture.md` scoped-replication purge).

- **ERP link**: maps the app user to the ERP person code (**`UserVc`**, the verified link target — `04-erp-sync.md` register table; `EmplVc` exists in the ERP but is not what we link to) so worksheets and bookings (`ActVc`) sync with the correct ERP technician/salesperson code. Two proven reference implementations: calendar's `person_codes` (email ↔ ERP `UserVc` code, per account) for the employee side — the one herbe.service's model matches — and portal's `identity_links` for the customer/contact side. Fed manually or by email match during initial load, with a periodic re-match job (portal's `identity-rematch` cron pattern). Enforcement rules for unlinked users: `04-erp-sync.md` (booking write queues with a warning; worksheet approval blocks).

One user may hold all links. Login methods per tenant are configurable (e.g. "SSO only" policy), stored the portal way (`auth_providers_enabled`-style table). A **test-auth provider** (persona login for UI tests) exists behind a double guard — env flag + non-production check, excluded from production builds; see `15-testing-strategy.md` §5.3.

**Suite SSO — DECIDED 2026-07-04: deferred.** There is no shared identity provider across herbe apps today and none is built now. Near-term: same email + same login methods across apps. Entra ID is added as a per-tenant Auth.js provider when a tenant needs it. Revisit suite-level SSO only if real cross-app friction shows up (`13-suite-change-requests.md` SUITE-1).

## Roles

Two levels, deliberately separate: the **tenant role** (what a person may do in general) and the **per-job lead** (elevation within a crew job — round 6: each crew member has their own worksheet, `02-data-model.md`). Any technician can be made *lead of a job* — that makes their worksheet the crew's **lead worksheet**: it alone collects the customer signature for the whole job, and its `Done` transition is normally what prompts the order's manual "job done" action. It is not a role change, and it grants no authority over other members' own worksheets — each technician still owns their own status transitions.

| Role | Can |
|---|---|
| **Technician** | see own (and optionally team) bookings/worksheets; execute their own worksheet: parts from own van, own time/distance, checklists, photos; as **job lead**: also collects the customer signature for the whole crew job; create service orders/customers/service items in the field (tenant-configurable); see own van stock; see service history; prices hidden/shown per tenant policy |
| **Team lead / crew manager** | technician + see and reassign the team's bookings/worksheets, edit crew composition on the team's jobs, review the team's time entries; optionally (tenant flag) approve the team's worksheets |
| **Dispatcher / Service manager** | all orders & worksheets; dispatch board incl. crew scheduling; approve/reject worksheets; bulk operations on the service item tree (`11`); manage checklist templates; trigger/override document generation (`12`); see sync health; prices & margins |
| **Back office** | read-most; customer/item edits; reports; document delivery follow-up |
| **Admin** | tenant settings incl. theme/whitelabel; users/roles; device enrolment links + registry; ERP connections & transformations, settings import/export (`04`); document templates, computed fields, number series (`12`); structure templates (`11`); API tokens (incl. the `/api/ext` tokens for herbe.portal) |

Role activation is phased (`06-roadmap.md`): technician, dispatcher/service manager, back office, admin and team lead all activate in Phase 1. **Dispatcher and service manager are one role** — the docs use both words for the same table row above.

Permissions are capability flags grouped into these default roles (custom roles later, not v1); the flags let a tenant tune the edges — e.g. whether team leads approve worksheets, whether technicians see prices, who may issue device enrolments. Field-level visibility and mandatoriness are the separate, role-aware **field policies** in `02-data-model.md` — rights say *what you may do*, field policies say *what a form demands of you*.

## Sessions & devices

- Auth.js JWT session with a rolling window plus a hard absolute cap enforced in the `jwt` callback against the token's `iat` (portal's pattern: 24 h rolling / 30 d absolute — Auth.js has no native absolute-cap setting), **plus** the portal's `session_version` counter so role changes/offboarding invalidate live sessions at next contact. Both windows extended well beyond office defaults for the technician role: offline work must survive weeks without re-auth. A successful PIN/biometric unlock refreshes the rolling window (extends the token up to the absolute cap); a full re-auth is forced only at the absolute cap, on revocation, or at first enrolment. For the native-wrapper path, calendar's `mobile_tokens` (hashed bearer, 90-day sliding expiry) is the reference.
- Device registry per user: named devices, enrolment date, last sync, remote sign-out (session revocation via `session_version` bump / token delete) + local data wipe on next contact (lost phone / offboarding). Device-at-rest security scope: `03-architecture.md` "Device data at rest".
- Office roles get standard web sessions; the technician PIN/biometric login above is the device session's local unlock.

## Multi-tenancy

Tenant = one customer of ours, on the shared SaaS deployment or a dedicated whitelabel deployment (resolved 2026-07-05, `03-architecture.md`); `tenant_id` scopes every domain table. Within a tenant there can be **several ERP company connections**, each a fully separate data scope (`02-data-model.md` "Company scoping"); users are tenant-level, get access per company, and switch the active company in the UI — technicians typically live in one company, back office may span several. Cross-tenant contractor accounts are out of scope for v1.

Portal users (the *customer's* people) are a different population entirely — they live in herbe.portal, keyed to Contacts/identity links, and never appear in this user store. herbe.service has **no customer-facing surface of its own** (owner decision 2026-07-05, `08-suite-integration.md` §4): every customer interaction happens in the portal or on the technician's device.
