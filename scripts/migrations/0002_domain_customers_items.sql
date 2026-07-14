-- scripts/migrations/0002_domain_customers_items.sql
--
-- customers/items domain tables + a shared changeSeq sequence + a plpgsql
-- trigger that bumps it on every insert/update. Fully self-idempotent (see
-- Task 4's per-statement runner, scripts/migrate.mjs) so a re-run is a clean
-- no-op: CREATE ... IF NOT EXISTS everywhere, CREATE OR REPLACE FUNCTION, and
-- DROP TRIGGER IF EXISTS immediately before each CREATE TRIGGER (Postgres has
-- no CREATE TRIGGER IF NOT EXISTS).
CREATE SEQUENCE IF NOT EXISTS domain_change_seq;

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  erp_company_id UUID NOT NULL REFERENCES erp_companies(id),
  erp_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  change_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (erp_company_id, erp_ref)
);
CREATE INDEX IF NOT EXISTS idx_customers_change_seq ON customers (change_seq);

CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  erp_company_id UUID NOT NULL REFERENCES erp_companies(id),
  erp_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  change_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (erp_company_id, erp_ref)
);
CREATE INDEX IF NOT EXISTS idx_items_change_seq ON items (change_seq);

CREATE OR REPLACE FUNCTION bump_change_seq() RETURNS trigger AS $$
BEGIN
  NEW.change_seq := nextval('domain_change_seq');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_change_seq ON customers;
CREATE TRIGGER trg_customers_change_seq BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();

DROP TRIGGER IF EXISTS trg_items_change_seq ON items;
CREATE TRIGGER trg_items_change_seq BEFORE INSERT OR UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION bump_change_seq();
