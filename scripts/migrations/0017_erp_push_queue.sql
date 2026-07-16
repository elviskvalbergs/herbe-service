-- scripts/migrations/0017_erp_push_queue.sql
--
-- WS4 ERP outbound slice (docs/superpowers/plans/2026-07-16-service-phase1-erp-outbound.md
-- decision 1): outbox_ops (0004) stays a client-op journal; the app->ERP
-- push path is its own FIFO saga queue. erp_push_groups is the ordering
-- unit — "lane" is the FIFO key (e.g. "order:<orderId>") so, per doc 04, a
-- worksheet push never races ahead of its own order's create. erp_push_steps
-- are the seq-ordered work items inside a group; group_id cascades so a
-- group delete takes its steps with it. No change_seq/tombstone here — the
-- saga engine (Task 5) drives status transitions directly and completed
-- groups/steps are kept, not deleted.
CREATE TABLE IF NOT EXISTS "erp_push_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "erp_company_id" uuid NOT NULL REFERENCES "erp_companies"("id"),
  "lane" text NOT NULL,
  "kind" text NOT NULL,          -- 'order_create' | 'worksheet_push'
  "status" text NOT NULL DEFAULT 'pending',  -- pending|running|succeeded|failed|dead
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "erp_push_groups_company_status_idx" ON "erp_push_groups" ("erp_company_id", "status");
CREATE INDEX IF NOT EXISTS "erp_push_groups_lane_created_idx" ON "erp_push_groups" ("lane", "created_at");

CREATE TABLE IF NOT EXISTS "erp_push_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "group_id" uuid NOT NULL REFERENCES "erp_push_groups"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "entity_type" text NOT NULL,   -- 'serviceOrder' | 'worksheet'
  "entity_id" uuid NOT NULL,
  "register" text NOT NULL,      -- 'SVOVc' | 'WSVc'
  "op" text NOT NULL,            -- 'create' | 'update'
  "status" text NOT NULL DEFAULT 'pending',  -- pending|running|succeeded|failed|dead
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "erp_ref" text,
  "error_message" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "erp_push_steps_group_seq_uniq" UNIQUE ("group_id", "seq")
);
CREATE INDEX IF NOT EXISTS "erp_push_steps_group_idx" ON "erp_push_steps" ("group_id");
