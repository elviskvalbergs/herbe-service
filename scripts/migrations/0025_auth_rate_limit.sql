-- scripts/migrations/0025_auth_rate_limit.sql
--
-- FIX-7 (docs/27): the auth endpoints (login → argon2 CPU cost, TOTP verify,
-- unauthenticated magic-link request) had no throttle — only /api/ext did.
-- Mirrors ext_rate_limit (0015) but keyed on an opaque TEXT key
-- (IP+tenant+email) instead of an ext-token uuid, because auth requests carry
-- no token. Fixed-window counter; no FK; PK is the composite key. Old windows
-- are harmless orphan rows (same as ext_rate_limit).
CREATE TABLE IF NOT EXISTS "auth_rate_limit" (
  "key" text NOT NULL,
  "endpoint" text NOT NULL,
  "window_start" timestamptz NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "auth_rate_limit_pk" PRIMARY KEY ("key", "endpoint", "window_start")
);
