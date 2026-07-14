-- scripts/migrations/0012_erp_refs.sql
--
-- The erpRef set (docs/02-data-model.md 154-158, "Global Constraints"):
-- erpRef is a SET keyed by purpose, not a scalar column, because e.g. a
-- worksheet maps to both a primary WSVc record and a worksheetShadow ActVc.
-- entity_type/entity_id is a loose polymorphic reference (no FK) so this one
-- side table serves service_order/worksheet/service_item alike without a
-- reshaping migration when the ERP-push slice lands.
CREATE TABLE IF NOT EXISTS "erp_refs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "entity_type" text NOT NULL,   -- 'service_order' | 'worksheet' | 'service_item'
  "entity_id" uuid NOT NULL,
  "purpose" text NOT NULL,       -- ErpRefPurpose
  "register" text,               -- 'SVOVc' | 'WSVc' | 'SVOSerVc' | 'ActVc'
  "record_ref" text NOT NULL,    -- ERP SerNr / @url
  "last_sequence" bigint,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_refs_uniq" UNIQUE ("entity_type", "entity_id", "purpose")
);
CREATE INDEX IF NOT EXISTS "erp_refs_entity_idx" ON "erp_refs" ("entity_type", "entity_id");
