-- scripts/migrations/0017_users_session_version.sql
--
-- WS2 (docs/05-users-auth.md "Sessions & devices"): the Phase 0 jwt callback
-- (lib/auth/config.ts) already stamps a hardcoded token.sessionVersion = 1 on
-- every sign-in but never checks it against anything ("Placeholder for Phase
-- 1" comment) — role changes/offboarding can't force-invalidate a live
-- session. This column is the real counter: lib/auth/session-guard.ts
-- bumpSessionVersion increments it, and getVerifiedSession rejects any token
-- whose stamped version no longer matches.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" integer NOT NULL DEFAULT 1;
