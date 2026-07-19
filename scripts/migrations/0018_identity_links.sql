-- scripts/migrations/0018_identity_links.sql
--
-- WS2 (docs/05-users-auth.md "Model"): the app-side IdentityLink[] table —
-- links a `users` row to an external identity. Only provider 'erp' is
-- populated this slice (UserVc.Code, matched by email via
-- lib/auth/identity-link.ts matchUsersByEmail); entra-id/eid providers are
-- Phase 2+ and reuse this same shape without a further migration.
--
-- The unique index includes the nullable erp_company_id: Postgres treats
-- each NULL as distinct, so it only truly de-duplicates provider='erp' rows
-- (which always set erp_company_id) — acceptable since no other provider is
-- populated yet.
CREATE TABLE IF NOT EXISTS "identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "provider" text NOT NULL,
  "erp_company_id" uuid REFERENCES "erp_companies"("id"),
  "external_id" text NOT NULL,
  "linked_at" timestamptz NOT NULL DEFAULT now(),
  "linked_by" text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "identity_links_user_provider_company_uniq" ON "identity_links" ("user_id", "provider", "erp_company_id");
CREATE INDEX IF NOT EXISTS "identity_links_erp_lookup_idx" ON "identity_links" ("erp_company_id", "external_id");
