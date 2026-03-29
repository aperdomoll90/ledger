-- Migration 005: Audit Log Table
-- Phase 1 of v2 roadmap
-- Append-only log of every write operation for rollback, sync, rate limiting, and observability
--
-- Design decisions:
--   - No FK on note_id (audit entries must survive note deletion)
--   - JSONB diff column stores old values for rollback
--   - Indexes on note_id (lookup by note), created_at (time-range), domain (filter by domain)

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial    PRIMARY KEY,
  note_id    bigint,
  domain     text,
  operation  text         NOT NULL,
  agent      text         NOT NULL,
  diff       jsonb,
  created_at timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_note_id ON audit_log (note_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_domain  ON audit_log (domain);
