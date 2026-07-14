-- scripts/migrations/0013_history_events.sql
--
-- HistoryEvent (docs/02-data-model.md "HistoryEvent (service history)"):
-- denormalized, append-only history per ServiceItem node, projected from
-- worksheet approvals (lib/domain/history-projector.ts) and later ERP-poll
-- ingest / status changes. Every event carries a deterministic key so
-- re-running the projector is idempotent — UNIQUE (tenant_id, key) is what
-- the store's onConflictDoNothing relies on. No change_seq/bump_change_seq
-- trigger and no deleted_at here: history is delta-fed by insert only,
-- never updated or tombstoned, unlike service_items/service_orders/worksheets.
CREATE TABLE IF NOT EXISTS "history_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "service_item_id" uuid NOT NULL REFERENCES "service_items"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "at" timestamptz,
  "kind" text,
  "summary" text,
  "order_id" uuid REFERENCES "service_orders"("id") ON DELETE SET NULL,
  "worksheet_id" uuid REFERENCES "worksheets"("id") ON DELETE SET NULL,
  "coverage_covered" integer,
  "coverage_of" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "history_events_tenant_key_uniq" UNIQUE ("tenant_id", "key")
);
CREATE INDEX IF NOT EXISTS "history_events_tenant_item_idx" ON "history_events" ("tenant_id", "service_item_id");
