-- scripts/migrations/0011_worksheets.sql
--
-- Worksheets (docs/02-data-model.md, 11-service-items-and-parts.md): one per
-- (service order x technician) — WSVc.EMCode is single-technician, so a crew
-- is N worksheets sharing crew_group_id, not one shared "lead" worksheet
-- (docs "Global Constraints"). No scalar erp_ref column here either: a
-- worksheet maps to BOTH a WSVc record and a worksheetShadow ActVc, so its
-- ERP refs live in the erp_refs side table (0012_erp_refs.sql) keyed by
-- purpose. Reuses domain_change_seq + bump_change_seq() exactly as
-- 0010_service_orders.sql retargets it from 0002/0009.
--
-- worksheet_rows/time_entries/distance_entries are child rows of a
-- worksheet with no independent change_seq/tombstone of their own, same as
-- service_order_rows in 0010.
CREATE TABLE IF NOT EXISTS "worksheets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,
  "technician_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "crew_group_id" uuid,
  "status" text NOT NULL DEFAULT 'Draft',
  "work_description" text,
  "fault" text,
  "cause" text,
  "remedy" text,
  "signed_on_site" boolean NOT NULL DEFAULT false,
  "signature_locked_at" timestamptz,
  "revision" integer NOT NULL DEFAULT 0,
  "rejected_reason" text,
  "change_seq" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "worksheets_tenant_idx" ON "worksheets" ("tenant_id");
CREATE INDEX IF NOT EXISTS "worksheets_order_idx" ON "worksheets" ("order_id");
CREATE INDEX IF NOT EXISTS "worksheets_status_idx" ON "worksheets" ("status");
CREATE INDEX IF NOT EXISTS "worksheets_change_seq_idx" ON "worksheets" ("change_seq");

-- One worksheet per (order x technician): WSVc.EMCode is single-technician.
-- Partial so a tombstoned worksheet (deleted_at set) or a crew-shared row
-- with no technician assigned yet (technician_user_id null) never blocks a
-- later insert.
CREATE UNIQUE INDEX IF NOT EXISTS "worksheets_order_tech_uniq" ON "worksheets" ("order_id", "technician_user_id")
  WHERE "deleted_at" IS NULL AND "technician_user_id" IS NOT NULL;

DROP TRIGGER IF EXISTS "trg_worksheets_change_seq" ON "worksheets";
CREATE TRIGGER "trg_worksheets_change_seq" BEFORE INSERT OR UPDATE ON "worksheets"
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

CREATE TABLE IF NOT EXISTS "worksheet_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "worksheet_id" uuid NOT NULL REFERENCES "worksheets"("id") ON DELETE CASCADE,
  "service_item_id" uuid REFERENCES "service_items"("id") ON DELETE SET NULL,
  "description" text,
  "quantity" numeric,
  "unit" text,
  "serial" text,
  "charge_type" text NOT NULL DEFAULT 'invoiceable',
  "stock_location" text,
  "price" numeric,
  "sum" numeric
);
CREATE INDEX IF NOT EXISTS "worksheet_rows_worksheet_idx" ON "worksheet_rows" ("worksheet_id");

CREATE TABLE IF NOT EXISTS "time_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "worksheet_id" uuid NOT NULL REFERENCES "worksheets"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,   -- 'work' | 'travel'
  "direction" text,       -- 'to' | 'from' | null
  "started_at" timestamptz,
  "ended_at" timestamptz,
  "minutes" integer,
  "pause_reason" text
);
CREATE INDEX IF NOT EXISTS "time_entries_worksheet_idx" ON "time_entries" ("worksheet_id");

CREATE TABLE IF NOT EXISTS "distance_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "worksheet_id" uuid NOT NULL REFERENCES "worksheets"("id") ON DELETE CASCADE,
  "km" numeric,
  "billable" boolean
);
CREATE INDEX IF NOT EXISTS "distance_entries_worksheet_idx" ON "distance_entries" ("worksheet_id");
