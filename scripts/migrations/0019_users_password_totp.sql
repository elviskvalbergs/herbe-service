-- scripts/migrations/0019_users_password_totp.sql
--
-- WS2 (docs/05-users-auth.md "Login methods are role-shaped" — "Optional
-- per tenant: password (argon2) + TOTP for admin roles"). Scoped to the
-- admin role in application code only (no DB-level role constraint, same
-- as the rest of this repo's role handling). mfa_secret_encrypted packs
-- {secretBase32, recoveryHashes} as JSON through the same envelope
-- convention lib/erp/credentials.ts already uses for api_creds_encrypted:
-- keyId(16)||nonce(12)||ciphertext, base64-encoded into this text column.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret_encrypted" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_totp_last_used_epoch" integer;
