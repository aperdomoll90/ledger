-- ============================================================
-- Ledger Database Tests — Document Functions
-- Run with: SELECT * FROM runtests('public');
-- Or run this file directly in Supabase SQL Editor
-- Requires: pgTAP extension (CREATE EXTENSION IF NOT EXISTS pgtap)
-- ============================================================

BEGIN;
SELECT plan(20);

-- ============================================================
-- TEST: document_create
-- ============================================================

SELECT lives_ok(
  $$ SELECT document_create(
    p_name := 'test-create-basic',
    p_domain := 'general',
    p_document_type := 'knowledge',
    p_project := NULL,
    p_protection := 'open',
    p_owner_type := 'user',
    p_owner_id := NULL,
    p_is_auto_load := false,
    p_content := 'Test document for pgTAP testing.',
    p_description := 'pgTAP test document',
    p_content_hash := 'test-hash-001'
  ) $$,
  'document_create: creates a document without error'
);

SELECT is(
  (SELECT count(*)::int FROM documents WHERE name = 'test-create-basic'),
  1,
  'document_create: document row exists'
);

SELECT is(
  (SELECT domain FROM documents WHERE name = 'test-create-basic'),
  'general',
  'document_create: domain is correct'
);

SELECT is(
  (SELECT document_type FROM documents WHERE name = 'test-create-basic'),
  'knowledge',
  'document_create: document_type is correct'
);

SELECT is(
  (SELECT count(*)::int FROM audit_log WHERE document_id = (SELECT id FROM documents WHERE name = 'test-create-basic') AND operation = 'create'),
  1,
  'document_create: audit entry exists with operation=create'
);

-- Verify content_length is auto-calculated
SELECT is(
  (SELECT content_length FROM documents WHERE name = 'test-create-basic'),
  length('Test document for pgTAP testing.'),
  'document_create: content_length auto-calculated correctly'
);

-- ============================================================
-- TEST: document_create rejects duplicate names
-- ============================================================

SELECT throws_ok(
  $$ SELECT document_create(
    p_name := 'test-create-basic',
    p_domain := 'general',
    p_document_type := 'knowledge',
    p_project := NULL,
    p_protection := 'open',
    p_owner_type := 'user',
    p_owner_id := NULL,
    p_is_auto_load := false,
    p_content := 'Duplicate name should fail.',
    p_description := 'Duplicate test',
    p_content_hash := 'test-hash-dup'
  ) $$,
  '23505',  -- unique_violation error code
  'document_create: rejects duplicate name'
);

-- ============================================================
-- TEST: document_update_fields
-- ============================================================

SELECT lives_ok(
  $$ SELECT document_update_fields(
    p_id := (SELECT id FROM documents WHERE name = 'test-create-basic'),
    p_agent := 'test-runner',
    p_domain := 'persona',
    p_description := 'Updated by pgTAP test'
  ) $$,
  'document_update_fields: updates without error'
);

SELECT is(
  (SELECT domain FROM documents WHERE name = 'test-create-basic'),
  'persona',
  'document_update_fields: domain updated to persona'
);

SELECT is(
  (SELECT description FROM documents WHERE name = 'test-create-basic'),
  'Updated by pgTAP test',
  'document_update_fields: description updated'
);

SELECT is(
  (SELECT count(*)::int FROM audit_log WHERE document_id = (SELECT id FROM documents WHERE name = 'test-create-basic') AND operation = 'update_fields'),
  1,
  'document_update_fields: audit entry exists'
);

-- ============================================================
-- TEST: document_delete (soft delete)
-- ============================================================

SELECT lives_ok(
  $$ SELECT document_delete(
    (SELECT id FROM documents WHERE name = 'test-create-basic'),
    'test-runner'
  ) $$,
  'document_delete: soft deletes without error'
);

SELECT isnt(
  (SELECT deleted_at FROM documents WHERE name = 'test-create-basic'),
  NULL,
  'document_delete: deleted_at is set'
);

SELECT is(
  (SELECT count(*)::int FROM audit_log WHERE document_id = (SELECT id FROM documents WHERE name = 'test-create-basic') AND operation = 'delete'),
  1,
  'document_delete: audit entry exists with full rollback data'
);

-- Verify delete audit has content for rollback
SELECT ok(
  (SELECT diff->'content' IS NOT NULL FROM audit_log WHERE document_id = (SELECT id FROM documents WHERE name = 'test-create-basic') AND operation = 'delete'),
  'document_delete: audit diff contains content for rollback'
);

-- ============================================================
-- TEST: document_restore
-- ============================================================

SELECT lives_ok(
  $$ SELECT document_restore(
    (SELECT id FROM documents WHERE name = 'test-create-basic'),
    'test-runner'
  ) $$,
  'document_restore: restores without error'
);

SELECT is(
  (SELECT deleted_at FROM documents WHERE name = 'test-create-basic'),
  NULL,
  'document_restore: deleted_at is cleared'
);

SELECT is(
  (SELECT count(*)::int FROM audit_log WHERE document_id = (SELECT id FROM documents WHERE name = 'test-create-basic') AND operation = 'restore'),
  1,
  'document_restore: audit entry exists'
);

-- ============================================================
-- TEST: CHECK constraints work
-- ============================================================

SELECT throws_ok(
  $$ SELECT document_create(
    p_name := 'test-bad-domain',
    p_domain := 'invalid_domain',
    p_document_type := 'knowledge',
    p_project := NULL,
    p_protection := 'open',
    p_owner_type := 'user',
    p_owner_id := NULL,
    p_is_auto_load := false,
    p_content := 'Should fail on invalid domain.',
    p_description := 'Bad domain test',
    p_content_hash := 'test-hash-bad'
  ) $$,
  '23514',  -- check_violation error code
  'CHECK constraint: rejects invalid domain'
);

SELECT throws_ok(
  $$ SELECT document_create(
    p_name := 'test-bad-protection',
    p_domain := 'general',
    p_document_type := 'knowledge',
    p_project := NULL,
    p_protection := 'super_secret',
    p_owner_type := 'user',
    p_owner_id := NULL,
    p_is_auto_load := false,
    p_content := 'Should fail on invalid protection.',
    p_description := 'Bad protection test',
    p_content_hash := 'test-hash-bad2'
  ) $$,
  '23514',  -- check_violation error code
  'CHECK constraint: rejects invalid protection'
);

-- ============================================================
-- CLEANUP
-- ============================================================

DELETE FROM audit_log WHERE document_id IN (SELECT id FROM documents WHERE name LIKE 'test-%');
DELETE FROM documents WHERE name LIKE 'test-%';

SELECT * FROM finish();
ROLLBACK;
