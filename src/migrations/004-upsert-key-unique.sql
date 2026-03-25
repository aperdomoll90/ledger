-- Partial unique index on upsert_key (only where not null)
-- Using INDEX instead of CONSTRAINT because JSONB->>key expressions
-- can't be used in ALTER TABLE ADD CONSTRAINT
CREATE UNIQUE INDEX IF NOT EXISTS uq_upsert_key
  ON notes ((metadata->>'upsert_key'))
  WHERE metadata->>'upsert_key' IS NOT NULL;
