-- scripts/migrations/0006_device_pairing.sql
-- Task 15: technician PIN-on-paired-device login (docs/05-users-auth.md).
CREATE TABLE IF NOT EXISTS device_enrollments (
  token_hash TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

-- pin_hash is argon2 — never plaintext. failed_attempts/locked_until
-- implement the rate-limit + lockout (app/api/auth/device/unlock).
CREATE TABLE IF NOT EXISTS paired_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  user_id UUID NOT NULL REFERENCES users(id),
  device_label TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  failed_attempts BIGINT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_unlock_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
