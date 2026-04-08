-- ============================================================
-- Ledger Database Tests — eval_golden_judgments (Phase 4.6.2)
-- Run with: psql "$DATABASE_URL" -f tests/sql/002-eval-golden-judgments.sql
-- Requires: pgTAP extension, eval_golden_dataset table, documents table
-- ============================================================

BEGIN;
SELECT plan(8);

-- Setup: ensure we have a query and a document to reference.
-- Note: expected_doc_ids is still NOT NULL on the current schema; it's dropped in Task 11.
-- We pass an empty array so this file works both before and after that column drop.
INSERT INTO eval_golden_dataset (query, tags, expected_doc_ids)
  VALUES ('pgtap-judgments-test-query', ARRAY['pgtap'], ARRAY[]::integer[])
  ON CONFLICT DO NOTHING;
INSERT INTO documents (name, domain, document_type, content, content_hash)
  VALUES ('pgtap-judgments-test-doc', 'general', 'knowledge', 'content', 'pgtap-hash-judgments')
  ON CONFLICT (name) DO NOTHING;

-- TEST 1: table exists
SELECT has_table('eval_golden_judgments', 'eval_golden_judgments table exists');

-- TEST 2: CHECK constraint rejects grade 4
PREPARE bad_grade AS
  INSERT INTO eval_golden_judgments (golden_id, document_id, grade)
  VALUES (
    (SELECT id FROM eval_golden_dataset WHERE query = 'pgtap-judgments-test-query'),
    (SELECT id FROM documents WHERE name = 'pgtap-judgments-test-doc'),
    4
  );
SELECT throws_ok(
  'EXECUTE bad_grade',
  '23514',
  NULL,
  'CHECK constraint rejects grade 4'
);

-- TEST 3: judgment_create happy path returns non-null id
SELECT isnt(
  (SELECT judgment_create(
    p_golden_id   := (SELECT id FROM eval_golden_dataset WHERE query = 'pgtap-judgments-test-query'),
    p_document_id := (SELECT id FROM documents WHERE name = 'pgtap-judgments-test-doc'),
    p_grade       := 2::smallint,
    p_judged_by   := 'pgtap',
    p_notes       := NULL
  ))::text,
  NULL,
  'judgment_create returns a non-null id'
);

-- TEST 4: judgment_create rejects duplicate (golden_id, document_id)
PREPARE dup_create AS
  SELECT judgment_create(
    p_golden_id   := (SELECT id FROM eval_golden_dataset WHERE query = 'pgtap-judgments-test-query'),
    p_document_id := (SELECT id FROM documents WHERE name = 'pgtap-judgments-test-doc'),
    p_grade       := 3::smallint,
    p_judged_by   := 'pgtap',
    p_notes       := NULL
  );
SELECT throws_ok(
  'EXECUTE dup_create',
  NULL, NULL,
  'judgment_create rejects duplicate (golden_id, document_id)'
);

-- TEST 5: judgment_update happy path
SELECT lives_ok(
  $$ SELECT judgment_update(
       p_golden_id   := (SELECT id FROM eval_golden_dataset WHERE query = 'pgtap-judgments-test-query'),
       p_document_id := (SELECT id FROM documents WHERE name = 'pgtap-judgments-test-doc'),
       p_grade       := 3::smallint,
       p_notes       := 'updated by pgtap'
     ) $$,
  'judgment_update succeeds on existing row'
);

-- TEST 6: judgment_update actually changed the grade
SELECT is(
  (SELECT grade FROM eval_golden_judgments
     WHERE golden_id = (SELECT id FROM eval_golden_dataset WHERE query = 'pgtap-judgments-test-query')
       AND document_id = (SELECT id FROM documents WHERE name = 'pgtap-judgments-test-doc')),
  3::smallint,
  'judgment_update actually changed the grade'
);

-- TEST 7: judgment_update errors on missing row
PREPARE missing_update AS
  SELECT judgment_update(
    p_golden_id   := -9999,
    p_document_id := -9999,
    p_grade       := 2::smallint,
    p_notes       := NULL
  );
SELECT throws_ok(
  'EXECUTE missing_update',
  NULL, NULL,
  'judgment_update errors when judgment does not exist'
);

-- TEST 8: FK cascade — deleting golden row removes its judgments
DELETE FROM eval_golden_dataset WHERE query = 'pgtap-judgments-test-query';
SELECT is(
  (SELECT count(*)::int FROM eval_golden_judgments
     WHERE document_id = (SELECT id FROM documents WHERE name = 'pgtap-judgments-test-doc')),
  0,
  'judgments were cascade-deleted with their golden row'
);

SELECT * FROM finish();
ROLLBACK;
