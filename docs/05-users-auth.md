# herbe.service — Users, Auth & Roles

Status: draft v0.1 (2026-07-03)

## Model (same pattern as herbe.calendar)

Users are **app-local** accounts, optionally linked to external identities. The link is data, not identity: removing an SSO link never deletes the user or their history.

```
User ── IdentityLink[] ── { provider: entra-id | standard-erp | excellent-books | local,
                            externalId, linkedAt, linkedBy }
```

- **Local**: email + password (Argon2id), optional TOTP 2FA. Always available as fallback.
- **Microsoft Entra ID (Azure)**: OIDC login; optional SCIM/Graph-driven provisioning (auto-create users from a security group, deactivate on removal).
- **ERP link**: maps the app user to the ERP employee/person code (`EmplVc`-style) so worksheets sync with the correct ERP salesperson/technician code. Fed either manually or by matching email during initial load.

One user may hold all three links. Login methods per tenant are configurable (e.g. "SSO only" policy).

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

- Long-lived refresh tokens on field devices (offline work must survive weeks without re-auth), short-lived access tokens.
- Device registry per user: named devices, last sync, remote sign-out + local data wipe on next contact (lost phone / offboarding).
- Offline PIN/biometric app-lock re-verifying the cached session locally.

## Multi-tenancy

Tenant = company. Users belong to one tenant (cross-tenant contractor accounts out of scope for v1). All data, adapters, and policies are tenant-scoped. Suite-level SSO: a user signed into another herbe app with the same Entra identity gets silent SSO into herbe.service.
