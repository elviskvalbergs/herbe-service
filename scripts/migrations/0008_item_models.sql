-- scripts/migrations/0008_item_models.sql
--
-- ItemModel registry (docs/11-service-items-and-parts.md "Model registry is
-- the join point"): make/model/category, referenced by service_items.model_id
-- and (later) PartCompatibility rows. Numbered ahead of 0009_service_items.sql
-- because service_items.model_id FKs this table — must exist first.
CREATE TABLE IF NOT EXISTS "item_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "make" text,
  "model" text,
  "category" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "item_models_tenant_idx" ON "item_models" ("tenant_id");
