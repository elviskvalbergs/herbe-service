-- scripts/migrations/0010_service_orders.sql
--
-- Service orders (docs/02-data-model.md, 11-service-items-and-parts.md): the
-- top-level job entity. order_number is the app's OWN number — the ERP
-- SVOVc SerNr (and any other ERP-side ref) lands in the erp_refs side table
-- (0012_erp_refs.sql), never a scalar erp_ref column here: a service order
-- has no single scalar ERP counterpart (docs "Global Constraints"). Reuses
-- the domain_change_seq sequence + bump_change_seq() trigger from
-- 0002_domain_customers_items.sql, attached below exactly as 0009 attaches
-- it to service_items, retargeted to service_orders.
--
-- service_order_rows are the per-line group-service rows (coverage jsonb —
-- lib/domain/coverage.ts); they are child rows of an order with no
-- independent change_seq/tombstone of their own, same as the order they
-- belong to.
CREATE TABLE IF NOT EXISTS "service_orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id"),
  "site_name" text,
  "contact_name" text,
  "description" text,
  "priority" text,
  "requested_at" timestamptz,
  "promised_date" timestamptz,
  "status" text NOT NULL DEFAULT 'New',
  "default_charge_type" text NOT NULL DEFAULT 'invoiceable',
  "order_number" text,
  "crew_group_id" uuid,
  "change_seq" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "service_orders_tenant_idx" ON "service_orders" ("tenant_id");
CREATE INDEX IF NOT EXISTS "service_orders_customer_idx" ON "service_orders" ("customer_id");
CREATE INDEX IF NOT EXISTS "service_orders_status_idx" ON "service_orders" ("status");
CREATE INDEX IF NOT EXISTS "service_orders_change_seq_idx" ON "service_orders" ("change_seq");

DROP TRIGGER IF EXISTS "trg_service_orders_change_seq" ON "service_orders";
CREATE TRIGGER "trg_service_orders_change_seq" BEFORE INSERT OR UPDATE ON "service_orders"
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

CREATE TABLE IF NOT EXISTS "service_order_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "order_id" uuid NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,
  "service_item_id" uuid REFERENCES "service_items"("id") ON DELETE SET NULL,
  "coverage" jsonb,
  "symptom" text,
  "work_type" text,
  "charge_type" text
);
CREATE INDEX IF NOT EXISTS "service_order_rows_order_idx" ON "service_order_rows" ("order_id");
