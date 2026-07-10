-- Task 13: the Phase-0 outbound round-trip. id is the client-generated UUID
-- (the idempotency key) — see drizzle/schema.ts outboxOps for column notes.
CREATE TABLE IF NOT EXISTS outbox_ops (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  entity TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  base_version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  erp_ref TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);
