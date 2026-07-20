-- scripts/migrations/0020_user_settings.sql
--
-- WS1 Task 3 (settings model — user prefs): locale + display-scheme are
-- per-user preferences, added directly to `users` following the same
-- convention as password_hash/mfa_* (0019_users_password_totp.sql) rather
-- than a separate table. Validated in application code
-- (lib/settings/user-prefs.ts) against lib/i18n/config.ts's locale list and
-- the 3-value display_scheme union — no DB-level CHECK constraint,
-- consistent with how `role` is handled elsewhere on this table.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" text NOT NULL DEFAULT 'lv';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_scheme" text NOT NULL DEFAULT 'standard';
