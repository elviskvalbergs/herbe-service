-- scripts/migrations/0024_users_role_check.sql
--
-- FIX-12 (docs/27): users.role is a bare TEXT column with no constraint
-- (0005_auth.sql), so a future user-management UI (WS10) or a bad write could
-- store an arbitrary string. lib/auth/roles.ts hasCapability can't map such a
-- value — until this fix it threw ("Cannot read properties of undefined") on
-- every office page load via getVisibleNavSections. The DB is the real gate:
-- constrain role to the five values in the Role union (lib/auth/roles.ts).
-- hasCapability now also returns false for an unknown role as defense in depth.
--
-- Named constraint so a re-apply raises SQLSTATE 42710 (duplicate_object),
-- which scripts/migrate.mjs tolerates; Postgres 14 has no ADD CONSTRAINT IF
-- NOT EXISTS.
ALTER TABLE "users"
  ADD CONSTRAINT "users_role_check"
  CHECK ("role" IN ('technician', 'team_lead', 'dispatcher', 'back_office', 'admin'));
