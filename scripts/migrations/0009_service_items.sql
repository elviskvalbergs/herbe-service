-- scripts/migrations/0009_service_items.sql
--
-- The service-item location tree (docs/11-service-items-and-parts.md "Part 1
-- — The service item hierarchy"): system/unit/lot nodes, self-referencing
-- parent link, materialized path, ItemModel reference. Reuses the
-- domain_change_seq sequence + bump_change_seq() trigger from
-- 0002_domain_customers_items.sql — attached below exactly as 0002 attaches
-- it to customers/items, just retargeted to service_items. Depends on
-- item_models (0008_item_models.sql), which must run first.
CREATE TABLE IF NOT EXISTS "service_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "erp_ref" text,
  "parent_id" uuid REFERENCES "service_items"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "serial_nr" text,
  "secondary_serial" text,
  "quantity" integer,
  "model_id" uuid REFERENCES "item_models"("id") ON DELETE SET NULL,
  "path" text NOT NULL DEFAULT '',
  "position_code" text,
  "label_id" text NOT NULL,
  "attributes" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "site_name" text,
  "warranty_until" timestamptz,
  "warranty_labor_covered" boolean NOT NULL DEFAULT false,
  "warranty_parts_covered" boolean NOT NULL DEFAULT false,
  "change_seq" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "service_items_erp_ref_uniq" UNIQUE ("erp_company_id", "erp_ref")
);
CREATE INDEX IF NOT EXISTS "service_items_tenant_idx" ON "service_items" ("tenant_id");
CREATE INDEX IF NOT EXISTS "service_items_parent_idx" ON "service_items" ("parent_id");
CREATE INDEX IF NOT EXISTS "service_items_label_idx" ON "service_items" ("label_id");
CREATE INDEX IF NOT EXISTS "service_items_change_seq_idx" ON "service_items" ("change_seq");
CREATE UNIQUE INDEX IF NOT EXISTS "service_items_label_uniq" ON "service_items" ("label_id");

DROP TRIGGER IF EXISTS "trg_service_items_change_seq" ON "service_items";
CREATE TRIGGER "trg_service_items_change_seq" BEFORE INSERT OR UPDATE ON "service_items"
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
