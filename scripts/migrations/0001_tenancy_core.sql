-- scripts/migrations/0001_tenancy_core.sql
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  display_name TEXT NOT NULL,
  adapter_type TEXT NOT NULL,
  adapter_config_json JSONB NOT NULL DEFAULT '{}',
  api_creds_encrypted TEXT,
  secret_version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp_sync_state (
  erp_company_id UUID NOT NULL REFERENCES erp_companies(id),
  register TEXT NOT NULL,
  sync_cursor TEXT NOT NULL DEFAULT '0',
  last_sync_at TIMESTAMPTZ,
  last_full_sync_at TIMESTAMPTZ,
  sync_status TEXT NOT NULL DEFAULT 'idle',
  error_message TEXT,
  PRIMARY KEY (erp_company_id, register)
);
