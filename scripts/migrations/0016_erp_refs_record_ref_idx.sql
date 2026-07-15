-- scripts/migrations/0016_erp_refs_record_ref_idx.sql
--
-- SVOVc -> service_orders ingest (docs/superpowers/plans/2026-07-15-service-phase1-svovc-orders.md):
-- service_orders has no scalar erpRef column (0010_service_orders.sql) — a
-- re-ingested SVOVc row is matched to its existing order via a reverse
-- lookup on erp_refs (erp_company_id, entity_type, purpose, record_ref)
-- instead of an onConflict target. This index backs that lookup
-- (findEntityIdByErpRef, lib/domain/stores/erp-refs.ts) with an index scan
-- instead of a sequential scan as erp_refs grows.
CREATE INDEX IF NOT EXISTS "erp_refs_record_ref_idx" ON "erp_refs" ("erp_company_id", "entity_type", "purpose", "record_ref");
