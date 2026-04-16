-- ============================================================
-- Ledger Database Tests — Hybrid Search Timing Sidecar (Phase 2)
-- Run with: psql "$DATABASE_URL" -f tests/sql/004-hybrid-search-timing.sql
-- Requires: pgTAP extension, document_chunks must have at least one row
-- ============================================================

BEGIN;
SELECT plan(4);

-- ============================================================
-- Setup: capture one invocation's output for inspection.
-- Uses threshold=0.0 and limit=1 to maximize the chance of a hit
-- regardless of corpus content. Uses the first available chunk
-- embedding as the query vector.
-- ============================================================

CREATE TEMP TABLE _t_hybrid_timing_result AS
SELECT timing
FROM match_documents_hybrid(
  (SELECT embedding FROM document_chunks LIMIT 1),
  'test',
  0.0, 1, NULL, NULL, NULL, 60
)
LIMIT 1;

-- ============================================================
-- TEST: timing column is present and not null
-- ============================================================

SELECT ok(
  (SELECT timing IS NOT NULL FROM _t_hybrid_timing_result),
  'timing column is present and not null'
);

-- ============================================================
-- TEST: vector_ms is a non-negative integer
-- ============================================================

SELECT ok(
  (SELECT (timing->>'vector_ms')::int >= 0 FROM _t_hybrid_timing_result),
  'vector_ms is a non-negative integer'
);

-- ============================================================
-- TEST: keyword_ms is a non-negative integer
-- ============================================================

SELECT ok(
  (SELECT (timing->>'keyword_ms')::int >= 0 FROM _t_hybrid_timing_result),
  'keyword_ms is a non-negative integer'
);

-- ============================================================
-- TEST: fusion_ms is a non-negative integer
-- ============================================================

SELECT ok(
  (SELECT (timing->>'fusion_ms')::int >= 0 FROM _t_hybrid_timing_result),
  'fusion_ms is a non-negative integer'
);

SELECT * FROM finish();
ROLLBACK;
