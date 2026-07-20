-- scripts/migrations/0021_push_subscriptions.sql
--
-- WS1 Task 9 (push infra, docs/superpowers/sdd/task-9-brief.md): one row per
-- browser/device Web Push subscription. endpoint is globally unique per the
-- Push API spec, so it's the natural upsert key for subscribe (Task 9's
-- POST /api/push/subscribe upserts by endpoint for the current user). No
-- ON DELETE on user_id, same as identity_links (0018) — users are never
-- hard-deleted in this app today.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_uniq" ON "push_subscriptions" ("endpoint");
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx" ON "push_subscriptions" ("user_id");
