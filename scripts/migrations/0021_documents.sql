-- scripts/migrations/0021_documents.sql
--
-- WS12 documents slice (docs/superpowers/plans/2026-07-20-service-phase1-ws12-documents.md
-- decision 4): order report PDF + DOCX template engine data model.
-- document_templates holds uploaded DOCX bytes (newest active per
-- (tenant, doc_type) wins, else built-in). document_number_series is the
-- per-(tenant, doc_type) counter behind `<prefix>-<year>-<counter>` numbers —
-- assigned at first final render, immutable after. documents rows are only
-- inserted on SUCCESSFUL render (no status column); re-renders bump version
-- and copy the number from version 1. document_render_jobs is the queued
-- render pipeline — the WS4 push-queue idioms (0020): plain-text status with
-- a comment (no CHECK), attempts + next_attempt_at backoff, dead after max
-- attempts. Bytes live in Postgres bytea per decision 3 (no media/storage
-- infra exists yet; lib/documents/store.ts is the single swap point).
-- tenants.branding (decision 6) themes the built-in report; WS1's real
-- settings model supersedes it later.
CREATE TABLE IF NOT EXISTS "document_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "doc_type" text NOT NULL,      -- 'order_report' | 'order_confirmation'
  "name" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "docx" bytea NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "document_templates_tenant_type_active_idx" ON "document_templates" ("tenant_id", "doc_type", "active");

CREATE TABLE IF NOT EXISTS "document_number_series" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "doc_type" text NOT NULL,
  "prefix" text NOT NULL,        -- 'SR' for order_report, 'OC' for order_confirmation
  "next_counter" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "document_number_series_tenant_type_uniq" UNIQUE ("tenant_id", "doc_type")
);

-- template_id null = rendered with the built-in report, not a custom
-- template. series_id/template_id deliberately do NOT cascade: a series or
-- template referenced by a rendered document must not be silently deletable.
CREATE TABLE IF NOT EXISTS "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "doc_type" text NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,
  "number" text NOT NULL,
  "series_id" uuid NOT NULL REFERENCES "document_number_series"("id"),
  "version" integer NOT NULL DEFAULT 1,
  "template_id" uuid REFERENCES "document_templates"("id"),
  "template_version" integer,
  "context_snapshot" jsonb NOT NULL,
  "docx_bytes" bytea,
  "pdf_bytes" bytea,
  "rendered_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "documents_tenant_type_order_version_uniq" UNIQUE ("tenant_id", "doc_type", "order_id", "version")
);
CREATE INDEX IF NOT EXISTS "documents_tenant_order_idx" ON "documents" ("tenant_id", "order_id");

-- "trigger" is a non-reserved keyword in Postgres — legal as a column name
-- (quoted here like every other identifier in these migrations).
CREATE TABLE IF NOT EXISTS "document_render_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "erp_company_id" uuid REFERENCES "erp_companies"("id") ON DELETE CASCADE,
  "doc_type" text NOT NULL,
  "order_id" uuid NOT NULL REFERENCES "service_orders"("id") ON DELETE CASCADE,
  "trigger" text NOT NULL,       -- 'approval' | 'manual'
  "status" text NOT NULL DEFAULT 'queued',  -- queued|running|done|dead
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "document_render_jobs_status_next_idx" ON "document_render_jobs" ("status", "next_attempt_at");

-- Built-in report theming (decision 6): { locale?, logoUrl?, accentColor?,
-- footerText? }. Nullable, no default — null renders with neutral defaults.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "branding" jsonb;
