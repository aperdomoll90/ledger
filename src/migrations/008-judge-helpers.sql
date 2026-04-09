-- ============================================================
-- Migration 008 — Phase 4.6.2: judge helpers
--
-- Adds the count_golden_with_min_judgments() function used by the
-- ledger eval:judge CLI progress display.
-- ============================================================

CREATE OR REPLACE FUNCTION count_golden_with_min_judgments(p_min int)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT count(*)::bigint FROM (
    SELECT golden_id
    FROM eval_golden_judgments
    GROUP BY golden_id
    HAVING count(*) >= p_min
  ) AS qualifying;
$$;

GRANT EXECUTE ON FUNCTION count_golden_with_min_judgments(int) TO service_role;
