-- scripts/migrations/0007_scope_membership.sql
--
-- Task 22: scoped-replication membership table (03-architecture.md "Scoped
-- replication"). Reuses the domain_change_seq sequence Task 11's 0002
-- migration created — one shared monotonic space across changeSeq and
-- membershipSeq, not a second sequence. Self-idempotent per the Task 11
-- convention: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION, and
-- DROP TRIGGER IF EXISTS immediately before CREATE TRIGGER.
CREATE TABLE IF NOT EXISTS scope_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  membership_seq BIGINT NOT NULL,
  in_scope_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  out_scope_seq BIGINT,
  UNIQUE (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_scope_membership_seq ON scope_membership (membership_seq);

CREATE OR REPLACE FUNCTION bump_membership_seq() RETURNS trigger AS $$
BEGIN
  NEW.membership_seq := nextval('domain_change_seq'); -- reuses Task 11's shared sequence, same monotonic space
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scope_membership_seq ON scope_membership;
CREATE TRIGGER trg_scope_membership_seq BEFORE INSERT OR UPDATE ON scope_membership
  FOR EACH ROW EXECUTE FUNCTION bump_membership_seq();
