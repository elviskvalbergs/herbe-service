-- scripts/migrations/0014_service_item_customer_and_ext_tokens.sql
--
-- Task 1 of the herbe.service /api/ext/v1 read-API slice
-- (docs/superpowers/sdd/task-1-brief.md): service_items has no customer
-- link today (only free-text siteName), so the ext read API can't filter
-- by customer. Adds a nullable customer_id FK (ON DELETE SET NULL — a
-- deleted customer shouldn't cascade-delete the service-item tree) plus
-- ext_tokens, the scoped bearer-token table the ext API authenticates
-- against. ext_tokens is append-only-ish (no change_seq / bump_change_seq
-- trigger, same reasoning as history_events in 0013): tokens aren't
-- delta-synced to any client.
ALTER TABLE "service_items" ADD COLUMN IF NOT EXISTS "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "service_items_customer_idx" ON "service_items" ("customer_id");

CREATE TABLE IF NOT EXISTS "ext_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid NOT NULL REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "customer_codes" text[] NOT NULL DEFAULT '{}'::text[],
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "ext_tokens_hash_uniq" ON "ext_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "ext_tokens_company_idx" ON "ext_tokens" ("erp_company_id");
