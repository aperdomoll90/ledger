-- ============================================================
-- Migration 007 — Phase 4.6.2: Graded Relevance
--
-- Adds eval_golden_judgments table + 3 RPC functions for atomic writes.
-- Does NOT drop eval_golden_dataset.expected_doc_ids (deferred to migration 008).
-- ============================================================

-- ============================================================
-- Table
-- ============================================================
CREATE TABLE IF NOT EXISTS eval_golden_judgments (
  id            bigserial    PRIMARY KEY,
  golden_id     bigint       NOT NULL REFERENCES eval_golden_dataset(id) ON DELETE CASCADE,
  document_id   bigint       NOT NULL REFERENCES documents(id)           ON DELETE CASCADE,
  grade         smallint     NOT NULL CHECK (grade BETWEEN 0 AND 3),
  judged_at     timestamptz  NOT NULL DEFAULT now(),
  judged_by     text         NOT NULL DEFAULT 'adrian',
  notes         text,
  UNIQUE (golden_id, document_id)
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_golden_judgments_golden_id   ON eval_golden_judgments(golden_id);
CREATE INDEX IF NOT EXISTS idx_golden_judgments_document_id ON eval_golden_judgments(document_id);
CREATE INDEX IF NOT EXISTS idx_golden_judgments_grade       ON eval_golden_judgments(grade);

-- ============================================================
-- Row-level security
-- ============================================================
ALTER TABLE eval_golden_judgments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eval_golden_judgments_service_all ON eval_golden_judgments;
CREATE POLICY eval_golden_judgments_service_all
  ON eval_golden_judgments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- RPC: judgment_create
-- Inserts one judgment. Errors on duplicate (golden_id, document_id).
-- Returns the new row id.
-- ============================================================
CREATE OR REPLACE FUNCTION judgment_create(
  p_golden_id    bigint,
  p_document_id  bigint,
  p_grade        smallint,
  p_judged_by    text DEFAULT 'adrian',
  p_notes        text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO eval_golden_judgments (golden_id, document_id, grade, judged_by, notes)
  VALUES (p_golden_id, p_document_id, p_grade, p_judged_by, p_notes)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ============================================================
-- RPC: judgment_update
-- Updates grade (and optionally notes) for an existing judgment.
-- Bumps judged_at. Errors if no row matches.
-- ============================================================
CREATE OR REPLACE FUNCTION judgment_update(
  p_golden_id    bigint,
  p_document_id  bigint,
  p_grade        smallint,
  p_notes        text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated int;
BEGIN
  UPDATE eval_golden_judgments
     SET grade     = p_grade,
         notes     = COALESCE(p_notes, notes),
         judged_at = now()
   WHERE golden_id   = p_golden_id
     AND document_id = p_document_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'judgment_update: no judgment exists for (golden_id=%, document_id=%)',
      p_golden_id, p_document_id;
  END IF;
END;
$$;

-- ============================================================
-- RPC: judgment_delete
-- Removes a judgment. Idempotent on missing row (no error).
-- ============================================================
CREATE OR REPLACE FUNCTION judgment_delete(
  p_golden_id    bigint,
  p_document_id  bigint
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM eval_golden_judgments
   WHERE golden_id   = p_golden_id
     AND document_id = p_document_id;
END;
$$;

-- ============================================================
-- Grants
-- ============================================================
GRANT EXECUTE ON FUNCTION judgment_create(bigint, bigint, smallint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION judgment_update(bigint, bigint, smallint, text)       TO service_role;
GRANT EXECUTE ON FUNCTION judgment_delete(bigint, bigint)                       TO service_role;
