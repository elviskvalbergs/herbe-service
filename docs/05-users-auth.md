# herbe.service — Users, Auth & Roles

Status: draft v0.1 (2026-07-03)

## Model (same pattern as herbe.calendar)

Auth runs on **Supabase Auth**; `auth.users` is the login record, but the app's own `users` table (tenant, role, profile, status) is what the rest of the schema references — the app-local user is data we own, not just a mirror of the auth row. External identities attach as links, not as identity itself: removing an SSO link never deletes the user or their history.

```
User (app table, FK → auth.users) ── IdentityLink[] ── { provider: entra-id | standard-erp | excellent-books,
                                                          externalId, linkedAt, linkedBy }
```

- **Local**: Supabase Auth email/password, optional TOTP 2FA. Always available as fallback.
- **Microsoft Entra ID (Azure)**: configured as an OIDC provider in Supabase Auth; optional SCIM/Graph-driven provisioning (auto-create users from a security group, deactivate on removal).
- **ERP link**: maps the app user to the ERP employee/person code (`EmplVc`-style) so worksheets and bookings (`ActVc`) sync with the correct ERP salesperson/technician code. Fed either manually or by matching email during initial load.

One user may hold all links. Login methods per tenant are configurable (e.g. "SSO only" policy). To confirm against herbe.calendar: whether it already runs one shared Supabase Auth tenant/project across suite apps (enabling true silent SSO) or a per-app project with token exchange — this decides whether herbe.service joins that project or federates against it.

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

- Supabase Auth's refresh/access token pair, with refresh token lifetime extended for field devices (offline work must survive weeks without re-auth).
- Device registry per user: named devices, last sync, remote sign-out (revoke the Supabase session) + local data wipe on next contact (lost phone / offboarding).
- Offline PIN/biometric app-lock re-verifying the cached session locally.

## Multi-tenancy

Tenant = company. Users belong to one tenant (cross-tenant contractor accounts out of scope for v1). All data, adapters, and policies are tenant-scoped. Suite-level SSO: a user signed into another herbe app with the same Entra identity gets silent SSO into herbe.service.
