-- scripts/migrations/0015_ext_rate_limit.sql
--
-- Task 6 of the herbe.service /api/ext/v1 read-API slice: a token-keyed
-- rate limiter (429 + Retry-After, docs/08-suite-integration.md §"Phase 1").
-- Fixed-window counter keyed on (token_id, endpoint, window_start); no
-- existing rate-limit table in the repo (only cron's bearerMatches), so this
-- is net-new. Standalone — no FK to ext_tokens: a deleted token just orphans
-- its counter rows harmlessly, and this table is never read by token_id
-- alone (always token_id + endpoint + window_start), so no index is needed
-- beyond the primary key.
CREATE TABLE IF NOT EXISTS "ext_rate_limit" (
  "token_id" uuid NOT NULL,
  "endpoint" text NOT NULL,
  "window_start" timestamptz NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "ext_rate_limit_pk" PRIMARY KEY ("token_id","endpoint","window_start")
);
