# herbe.service — Users, Auth & Roles

Status: draft v0.2 (2026-07-04) — rewritten after reviewing sibling codebases: the suite runs **Auth.js (next-auth v5)**, not Supabase Auth; Entra ID login exists in neither sibling today.

## Model (verified suite pattern)

Auth runs on **Auth.js v5** — both siblings do (calendar: pg adapter + DB sessions; portal: Drizzle adapter + JWT sessions with a `session_version` revocation counter). The app's own `users` table (tenant, role, profile, status) is what the rest of the schema references. External identities attach as links, not as identity itself: removing a link never deletes the user or their history.

```
User (app table) ── IdentityLink[] ── { provider: entra-id | standard-erp | excellent-books,
                                        externalId, linkedAt, linkedBy }
```

- **Local**: email/password (argon2id) + optional TOTP — the portal's credentials provider, reused. Magic-link as the low-friction fallback (both siblings ship one).
- **Microsoft Entra ID**: an Auth.js OIDC provider, per-tenant configurable. Note: neither sibling has Entra *login* today (calendar uses Graph for mail/directory only), so this is net-new — but it's a standard Auth.js provider, not infrastructure work. Optional Graph-driven provisioning (auto-create from a security group, deactivate on removal) follows the calendar's directory-sync pattern.
- **Strong eID (optional, per tenant)**: Smart-ID / Dokobit / eParaksts providers exist ready-made in the portal (`lib/auth/*-provider.ts`) if a tenant wants them for managers/back office.
- **ERP link**: maps the app user to the ERP employee/person code so worksheets and bookings (`ActVc`) sync with the correct ERP technician/salesperson code. Two proven reference implementations: calendar's `person_codes` (email ↔ ERP `UserVc` code ↔ Azure object id, per account) for the employee side — this is the one herbe.service's model matches — and portal's `identity_links` for the customer/contact side. Fed manually or by email match during initial load, with a periodic re-match job (portal's `identity-rematch` cron pattern).

One user may hold all links. Login methods per tenant are configurable (e.g. "SSO only" policy), stored the portal way (`auth_providers_enabled`-style table).

**Suite SSO — DECIDED 2026-07-04: deferred.** There is no shared identity provider across herbe apps today and none is built now. Near-term: same email + same login methods across apps (low-friction, not SSO). Entra ID is added as a per-tenant Auth.js provider **when a tenant needs it** — no upfront work. Revisit suite-level SSO only if real cross-app friction shows up.

## Roles

| Role | Can |
|---|---|
| **Technician** | see own (and optionally team) bookings/worksheets; execute worksheets: parts, time, checklists, photos, signature; create service orders/customers/service items in the field (tenant-configurable); see own van stock; see service history; prices hidden/shown per tenant policy |
| **Team lead** | technician + see/reassign team's work |
| **Dispatcher / Service manager** | all orders & worksheets; plan board; approve/reject worksheets; manage checklist templates; see sync health; prices & margins |
| **Back office** | read-most; customer/item edits; reports |
| **Admin** | tenant settings, users/roles, ERP adapter config, API keys |

Permissions are capability flags grouped into these default roles (custom roles later, not v1).

## Sessions & devices

- Auth.js session with lifetime extended for field devices (offline work must survive weeks without re-auth). Pattern: portal's JWT strategy (24 h rolling / 30 d absolute) with the absolute window raised for the technician role, **plus** the portal's `session_version` counter so role changes/offboarding invalidate live sessions at next contact. For the native-wrapper path, calendar's `mobile_tokens` (hashed bearer, 90-day sliding expiry) is the reference.
- Device registry per user: named devices, last sync, remote sign-out (session revocation via `session_version` bump / token delete) + local data wipe on next contact (lost phone / offboarding).
- Offline PIN/biometric app-lock re-verifying the cached session locally.

## Multi-tenancy

Tenant = company. Users belong to one tenant (cross-tenant contractor accounts out of scope for v1). All data, adapters, and policies are tenant-scoped; tenancy topology (deployment-per-customer vs shared deployment) per the ADR in `03-architecture.md`. Suite-level SSO is future work — see the reality check above and `08-suite-integration.md`.
