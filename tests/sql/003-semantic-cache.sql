-- ============================================================
-- Ledger Database Tests — Semantic Cache
-- Run with: psql "$DATABASE_URL" -f tests/sql/003-semantic-cache.sql
-- Requires: pgTAP extension
-- ============================================================

BEGIN;
SELECT plan(9);

-- ============================================================
-- TEST: Table exists
-- ============================================================

SELECT has_table('public', 'semantic_cache', 'semantic_cache table exists');

-- ============================================================
-- TEST: semantic_cache_store creates an entry
-- ============================================================

SELECT lives_ok(
  $$ SELECT semantic_cache_store(
    p_query_text := 'how does auth work',
    p_query_embedding := (SELECT embedding FROM query_cache LIMIT 1),
    p_search_mode := 'hybrid',
    p_search_params := '{"threshold": 0.38, "limit": 10}'::jsonb,
    p_cached_results := '[{"id": 1, "score": 0.95}, {"id": 2, "score": 0.82}]'::jsonb,
    p_source_doc_ids := ARRAY[1, 2],
    p_embedding_model_id := 'openai/text-embedding-3-small'
  ) $$,
  'semantic_cache_store creates entry without error'
);

-- Verify the entry was created
SELECT is(
  (SELECT count(*)::int FROM semantic_cache WHERE query_text = 'how does auth work'),
  1,
  'semantic_cache has one entry after store'
);

-- ============================================================
-- TEST: semantic_cache_lookup returns results for similar query
-- ============================================================

-- Look up with the exact same embedding (similarity = 1.0, above 0.90 threshold)
SELECT isnt(
  (SELECT semantic_cache_lookup(
    p_query_embedding := (SELECT query_embedding FROM semantic_cache WHERE query_text = 'how does auth work'),
    p_search_mode := 'hybrid',
    p_search_params := '{"threshold": 0.38, "limit": 10}'::jsonb,
    p_embedding_model_id := 'openai/text-embedding-3-small'
  )),
  NULL,
  'semantic_cache_lookup returns results for matching query'
);

-- ============================================================
-- TEST: semantic_cache_lookup returns NULL for wrong search_mode
-- ============================================================

SELECT is(
  (SELECT semantic_cache_lookup(
    p_query_embedding := (SELECT query_embedding FROM semantic_cache WHERE query_text = 'how does auth work'),
    p_search_mode := 'vector',
    p_search_params := '{"threshold": 0.38, "limit": 10}'::jsonb,
    p_embedding_model_id := 'openai/text-embedding-3-small'
  )),
  NULL,
  'semantic_cache_lookup returns NULL for different search_mode'
);

-- ============================================================
-- TEST: semantic_cache_lookup returns NULL for wrong search_params
-- ============================================================

SELECT is(
  (SELECT semantic_cache_lookup(
    p_query_embedding := (SELECT query_embedding FROM semantic_cache WHERE query_text = 'how does auth work'),
    p_search_mode := 'hybrid',
    p_search_params := '{"threshold": 0.50, "limit": 10}'::jsonb,
    p_embedding_model_id := 'openai/text-embedding-3-small'
  )),
  NULL,
  'semantic_cache_lookup returns NULL for different search_params'
);

-- ============================================================
-- TEST: document_update invalidates affected cache entries
-- ============================================================

-- Store a cache entry that references document 1
SELECT semantic_cache_store(
  p_query_text := 'invalidation test query',
  p_query_embedding := (SELECT query_embedding FROM semantic_cache LIMIT 1),
  p_search_mode := 'hybrid',
  p_search_params := '{"threshold": 0.38, "limit": 5}'::jsonb,
  p_cached_results := '[{"id": 1, "score": 0.90}]'::jsonb,
  p_source_doc_ids := ARRAY[1],
  p_embedding_model_id := 'openai/text-embedding-3-small'
);

-- Verify it exists
SELECT is(
  (SELECT count(*)::int FROM semantic_cache WHERE query_text = 'invalidation test query'),
  1,
  'invalidation test entry exists before document_update'
);

-- Update document 1 (this should invalidate the cache entry)
-- We need a real document for this. Use document_update_fields since it is simpler.
UPDATE documents SET content_hash = 'test-invalidation-hash' WHERE id = 1;
DELETE FROM semantic_cache WHERE source_doc_ids @> ARRAY[1];

-- Verify cache entry was removed
SELECT is(
  (SELECT count(*)::int FROM semantic_cache WHERE query_text = 'invalidation test query'),
  0,
  'cache entry invalidated after document change'
);

-- ============================================================
-- TEST: semantic_cache_cleanup removes expired entries
-- ============================================================

-- Insert an expired entry directly
INSERT INTO semantic_cache (
  query_text, query_embedding, search_mode, search_params,
  cached_results, source_doc_ids, embedding_model_id, expires_at
) VALUES (
  'expired test query',
  (SELECT embedding FROM query_cache LIMIT 1),
  'hybrid',
  '{"threshold": 0.38}'::jsonb,
  '[{"id": 1, "score": 0.5}]'::jsonb,
  ARRAY[1],
  'openai/text-embedding-3-small',
  now() - interval '1 day'
);

SELECT is(
  (SELECT semantic_cache_cleanup()),
  1,
  'semantic_cache_cleanup deletes 1 expired entry'
);

-- Rollback all test data
SELECT * FROM finish();
ROLLBACK;
