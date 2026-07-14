-- scripts/migrations/0008_item_models.sql
--
-- ItemModel registry (docs/11-service-items-and-parts.md "Model registry is
-- the join point"): make/model/category, referenced by service_items.model_id
-- and (later) PartCompatibility rows. Numbered ahead of 0009_service_items.sql
-- because service_items.model_id FKs this table — must exist first.
-- ItemModel is app-master (docs/11 "all app-master, no ERP contract change"):
-- no erp_company_id/erp_ref — it has no single ERP counterpart. Still
-- tenant-scoped, delta-synced, and tombstoneable like the rest of the domain
-- layer, so it gets the same change_seq/updated_at/deleted_at + trigger.
CREATE TABLE IF NOT EXISTS "item_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "make" text,
  "model" text,
  "category" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "change_seq" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "item_models_tenant_idx" ON "item_models" ("tenant_id");
CREATE INDEX IF NOT EXISTS "item_models_change_seq_idx" ON "item_models" ("change_seq");

DROP TRIGGER IF EXISTS "trg_item_models_change_seq" ON "item_models";
CREATE TRIGGER "trg_item_models_change_seq" BEFORE INSERT OR UPDATE ON "item_models"
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
