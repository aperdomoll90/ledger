# Semantic Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a semantic cache (layer 2) that stores full search results keyed by query embedding, skipping the full search pipeline for semantically similar queries. Cache hits return directly with zero database calls.

**Architecture:** New `semantic_cache` Postgres table with HNSW index for similarity lookup and GIN index for reverse invalidation. Three new RPC functions (lookup, store, cleanup). Invalidation wired into existing `document_update` and `document_delete` RPCs. TypeScript integration in `searchByVector` and `searchHybrid` (not `searchByKeyword`, which has no embedding to compare).

**Tech Stack:** PostgreSQL (Supabase) · pgTAP · pgvector HNSW · TypeScript (strict) · vitest

**Spec:** [docs/superpowers/specs/2026-04-10-semantic-cache-design.md](../specs/2026-04-10-semantic-cache-design.md)

---

## File Structure

**New files:**
- `src/migrations/009-semantic-cache.sql` — DDL, indexes, RPC functions, invalidation additions
- `tests/sql/003-semantic-cache.sql` — pgTAP tests for cache RPCs and invalidation
- `src/lib/search/semantic-cache.ts` — TypeScript helper: build search_params, serialize/deserialize results
- `tests/semantic-cache.test.ts` — TypeScript unit tests for helpers + integration with ai-search

**Modified files:**
- `src/lib/search/ai-search.ts` — Add cache check before search, store after search

---

## Ordering Rationale

| Task | What                                    | State after                          | Rollback             |
|------|-----------------------------------------|--------------------------------------|----------------------|
| 1    | pgTAP tests (fail)                      | Tests exist, nothing built           | Delete test file     |
| 2    | Migration SQL + pgTAP green             | Table + RPCs live                    | Drop table           |
| 3    | TypeScript helpers + tests              | Helpers work, search unchanged       | Delete file          |
| 4    | Integrate into searchByVector           | Vector search uses cache             | Revert function      |
| 5    | Integrate into searchHybrid             | Hybrid search uses cache             | Revert function      |
| 6    | Full test suite + build                 | Everything green                     | —                    |
| 7    | Documentation updates                   | Architecture docs current            | Revert docs          |

---

## Task 1: pgTAP Tests (Red Phase)

**Files:**
- Create: `tests/sql/003-semantic-cache.sql`

- [ ] **Step 1: Write the pgTAP test file**

Create `tests/sql/003-semantic-cache.sql`:

```sql
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
  (SELECT query_embedding FROM semantic_cache LIMIT 1),
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd ~/repos/ledger && psql "$DATABASE_URL" -f tests/sql/003-semantic-cache.sql
```
Expected: FAIL — relation "semantic_cache" does not exist

- [ ] **Step 3: Commit**

```bash
cd ~/repos/ledger
git add tests/sql/003-semantic-cache.sql
git commit -m "add pgTAP tests for semantic cache (red phase)"
```

---

## Task 2: Migration SQL + pgTAP Green

**Files:**
- Create: `src/migrations/009-semantic-cache.sql`

- [ ] **Step 1: Write the migration**

Create `src/migrations/009-semantic-cache.sql`:

```sql
-- Migration 009: Semantic Cache
-- Layer 2 cache: stores search result IDs + scores keyed by query embedding.
-- Skips the full search pipeline for semantically similar queries.
--
-- Components:
--   1. semantic_cache table with HNSW, GIN, and BTREE indexes
--   2. semantic_cache_lookup: find cached results by vector similarity
--   3. semantic_cache_store: save search results to cache
--   4. semantic_cache_cleanup: purge expired entries
--   5. Invalidation added to document_update and document_delete

-- =============================================================================
-- 1. Table
-- =============================================================================

CREATE TABLE semantic_cache (
  id                 bigserial    PRIMARY KEY,
  query_text         text         NOT NULL,
  query_embedding    vector(1536) NOT NULL,
  search_mode        text         NOT NULL CHECK (search_mode IN ('vector', 'keyword', 'hybrid')),
  search_params      jsonb        NOT NULL,
  cached_results     jsonb        NOT NULL,
  source_doc_ids     int[]        NOT NULL,
  embedding_model_id text         NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  expires_at         timestamptz  NOT NULL DEFAULT now() + interval '7 days'
);

-- RLS: service_role only (same pattern as other tables)
ALTER TABLE semantic_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY semantic_cache_service_role ON semantic_cache
  FOR ALL USING (auth.role() = 'service_role');

-- =============================================================================
-- 2. Indexes
-- =============================================================================

-- HNSW for fast approximate nearest neighbor lookup
CREATE INDEX idx_semantic_cache_embedding
  ON semantic_cache USING hnsw (query_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- GIN for reverse index invalidation (source_doc_ids @> ARRAY[doc_id])
CREATE INDEX idx_semantic_cache_source_doc_ids
  ON semantic_cache USING gin (source_doc_ids);

-- BTREE for TTL cleanup (expires_at < now())
CREATE INDEX idx_semantic_cache_expires_at
  ON semantic_cache (expires_at);

-- =============================================================================
-- 3. semantic_cache_lookup
-- =============================================================================

CREATE OR REPLACE FUNCTION semantic_cache_lookup(
  p_query_embedding    vector(1536),
  p_search_mode        text,
  p_search_params      jsonb,
  p_embedding_model_id text,
  p_similarity_threshold float DEFAULT 0.90
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT cached_results INTO v_result
  FROM semantic_cache
  WHERE 1 - (query_embedding <=> p_query_embedding) >= p_similarity_threshold
    AND search_mode = p_search_mode
    AND search_params = p_search_params
    AND embedding_model_id = p_embedding_model_id
    AND expires_at > now()
  ORDER BY query_embedding <=> p_query_embedding
  LIMIT 1;

  RETURN v_result;
END;
$$;

-- =============================================================================
-- 4. semantic_cache_store
-- =============================================================================

CREATE OR REPLACE FUNCTION semantic_cache_store(
  p_query_text         text,
  p_query_embedding    vector(1536),
  p_search_mode        text,
  p_search_params      jsonb,
  p_cached_results     jsonb,
  p_source_doc_ids     int[],
  p_embedding_model_id text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO semantic_cache (
    query_text, query_embedding, search_mode, search_params,
    cached_results, source_doc_ids, embedding_model_id
  ) VALUES (
    p_query_text, p_query_embedding, p_search_mode, p_search_params,
    p_cached_results, p_source_doc_ids, p_embedding_model_id
  );
END;
$$;

-- =============================================================================
-- 5. semantic_cache_cleanup
-- =============================================================================

CREATE OR REPLACE FUNCTION semantic_cache_cleanup()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM semantic_cache WHERE expires_at < now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- =============================================================================
-- 6. Invalidation: add cache clearing to document_update
-- =============================================================================

CREATE OR REPLACE FUNCTION public.document_update(
  p_id bigint, p_content text, p_content_hash text,
  p_agent text DEFAULT NULL, p_description text DEFAULT NULL,
  p_status text DEFAULT NULL, p_embedding_model_id text DEFAULT NULL,
  p_chunk_contents text[] DEFAULT NULL, p_chunk_embeddings vector[] DEFAULT NULL,
  p_chunk_strategy text DEFAULT 'recursive',
  p_chunk_summaries text[] DEFAULT NULL,
  p_chunk_token_counts int[] DEFAULT NULL,
  p_chunk_overlap int DEFAULT 0
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_old_content text;
  v_old_domain  text;
  v_version_num int;
  i int;
BEGIN
  SELECT content, domain INTO v_old_content, v_old_domain
  FROM documents WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document % not found', p_id; END IF;

  -- Invalidate semantic cache entries that included this document
  DELETE FROM semantic_cache WHERE source_doc_ids @> ARRAY[p_id::int];

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_num
  FROM document_versions WHERE document_id = p_id;

  INSERT INTO document_versions (document_id, version_number, content, content_hash, agent)
  VALUES (p_id, v_version_num, v_old_content, encode(digest(v_old_content, 'sha256'), 'hex'), COALESCE(p_agent, 'unknown'));

  UPDATE documents SET
    content = p_content, content_hash = p_content_hash,
    agent = COALESCE(p_agent, agent), description = COALESCE(p_description, description),
    status = COALESCE(p_status, status), embedding_model_id = COALESCE(p_embedding_model_id, embedding_model_id)
  WHERE id = p_id;

  IF p_chunk_contents IS NOT NULL THEN
    DELETE FROM document_chunks WHERE document_id = p_id;
    FOR i IN 1..array_length(p_chunk_contents, 1) LOOP
      INSERT INTO document_chunks (
        document_id, chunk_index, content, domain, embedding,
        embedding_model_id, chunk_strategy, context_summary, token_count, overlap_chars
      )
      VALUES (
        p_id, i - 1, p_chunk_contents[i], v_old_domain, p_chunk_embeddings[i],
        p_embedding_model_id, p_chunk_strategy,
        CASE WHEN p_chunk_summaries IS NOT NULL THEN p_chunk_summaries[i] ELSE NULL END,
        CASE WHEN p_chunk_token_counts IS NOT NULL THEN p_chunk_token_counts[i] ELSE NULL END,
        p_chunk_overlap
      );
    END LOOP;
    UPDATE documents SET chunk_count = array_length(p_chunk_contents, 1) WHERE id = p_id;
  END IF;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_old_domain, 'update', COALESCE(p_agent, 'unknown'), jsonb_build_object('content', v_old_content), now());
END;
$$;

-- =============================================================================
-- 7. Invalidation: add cache clearing to document_delete
-- =============================================================================

CREATE OR REPLACE FUNCTION public.document_delete(p_id bigint, p_agent text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_content text;
  v_domain  text;
  v_fields  jsonb;
BEGIN
  SELECT content, domain,
    jsonb_build_object(
      'name', name, 'domain', domain, 'document_type', document_type,
      'project', project, 'protection', protection,
      'description', description, 'agent', agent, 'status', status,
      'file_path', file_path, 'file_permissions', file_permissions,
      'skill_ref', skill_ref, 'owner_type', owner_type, 'owner_id', owner_id,
      'is_auto_load', is_auto_load, 'source_type', source_type,
      'source_url', source_url, 'embedding_model_id', embedding_model_id,
      'content_hash', content_hash, 'schema_version', schema_version,
      'created_at', created_at
    )
  INTO v_content, v_domain, v_fields
  FROM documents WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document % not found', p_id; END IF;

  -- Invalidate semantic cache entries that included this document
  DELETE FROM semantic_cache WHERE source_doc_ids @> ARRAY[p_id::int];

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_domain, 'delete', p_agent, jsonb_build_object('content', v_content, 'fields', v_fields), now());

  UPDATE documents SET deleted_at = now() WHERE id = p_id;
  DELETE FROM document_chunks WHERE document_id = p_id;
END;
$$;
```

- [ ] **Step 2: Run the migration**

Run:
```bash
cd ~/repos/ledger && psql "$DATABASE_URL" -f src/migrations/009-semantic-cache.sql
```
Expected: All CREATE/ALTER statements succeed

- [ ] **Step 3: Run pgTAP tests**

Run:
```bash
cd ~/repos/ledger && psql "$DATABASE_URL" -f tests/sql/003-semantic-cache.sql
```
Expected: All 9 tests PASS

- [ ] **Step 4: Commit**

```bash
cd ~/repos/ledger
git add src/migrations/009-semantic-cache.sql
git commit -m "add semantic cache table, RPCs, and invalidation (migration 009)"
```

---

## Task 3: TypeScript Helpers + Tests

**Files:**
- Create: `src/lib/search/semantic-cache.ts`
- Create: `tests/semantic-cache.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/semantic-cache.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSearchParams, parseCachedResults, extractSourceDocIds } from '../src/lib/search/semantic-cache.js';

describe('buildSearchParams', () => {
  it('builds params with all fields', () => {
    const params = buildSearchParams({
      threshold: 0.38,
      limit: 10,
      domain: 'project',
      document_type: 'architecture',
      project: 'ledger',
    });
    expect(params).toEqual({
      threshold: 0.38,
      limit: 10,
      domain: 'project',
      document_type: 'architecture',
      project: 'ledger',
    });
  });

  it('omits undefined fields', () => {
    const params = buildSearchParams({
      threshold: 0.38,
      limit: 10,
    });
    expect(params).toEqual({ threshold: 0.38, limit: 10 });
    expect(params).not.toHaveProperty('domain');
    expect(params).not.toHaveProperty('document_type');
    expect(params).not.toHaveProperty('project');
  });

  it('produces identical JSON for same inputs regardless of call order', () => {
    const a = buildSearchParams({ threshold: 0.38, limit: 10, domain: 'project' });
    const b = buildSearchParams({ domain: 'project', limit: 10, threshold: 0.38 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('parseCachedResults', () => {
  it('returns the array as-is for valid results', () => {
    const results = [
      { id: 42, content: 'doc content', name: 'test', score: 0.95 },
      { id: 7, content: 'other doc', name: 'test2', score: 0.81 },
    ];
    expect(parseCachedResults(results)).toBe(results);
  });

  it('returns empty array for null', () => {
    expect(parseCachedResults(null)).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(parseCachedResults([])).toEqual([]);
  });
});

describe('extractSourceDocIds', () => {
  it('extracts unique document IDs from search results', () => {
    const results = [
      { id: 42, score: 0.95 },
      { id: 7, score: 0.81 },
      { id: 42, score: 0.60 },
    ];
    const ids = extractSourceDocIds(results);
    expect(ids).toEqual([42, 7]);
  });

  it('returns empty array for empty results', () => {
    expect(extractSourceDocIds([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/semantic-cache.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 4: Write the semantic cache helpers**

Create `src/lib/search/semantic-cache.ts`:

```typescript
// semantic-cache.ts
// Helpers for the semantic cache (layer 2).
// Handles serialization, deserialization, and parameter normalization
// for cache lookup and store operations.
//
// The actual cache logic (HNSW lookup, store, invalidation) lives in Postgres
// RPC functions. This module prepares data for those calls.

import type { ISearchResultProps } from './ai-search.js';

const EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small';
const SIMILARITY_THRESHOLD = 0.90;

export { EMBEDDING_MODEL_ID as SEMANTIC_CACHE_MODEL_ID };
export { SIMILARITY_THRESHOLD as SEMANTIC_CACHE_THRESHOLD };

// =============================================================================
// Parameter normalization
// =============================================================================

interface IBuildSearchParamsInput {
  threshold?: number;
  limit?: number;
  domain?: string;
  document_type?: string;
  project?: string;
}

/**
 * Build a normalized search_params object for cache key matching.
 * Keys are sorted alphabetically so JSONB equality works regardless
 * of the order properties were passed in.
 * Undefined values are omitted (not set to null) to avoid
 * mismatches between {domain: null} and {}.
 */
export function buildSearchParams(input: IBuildSearchParamsInput): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  // Alphabetical order for consistent JSONB serialization
  if (input.document_type !== undefined) params.document_type = input.document_type;
  if (input.domain !== undefined) params.domain = input.domain;
  if (input.limit !== undefined) params.limit = input.limit;
  if (input.project !== undefined) params.project = input.project;
  if (input.threshold !== undefined) params.threshold = input.threshold;
  return params;
}

// =============================================================================
// Result serialization
// =============================================================================

/**
 * Parse cached_results JSONB from Postgres into typed array.
 * Returns the array directly since we cache full ISearchResultProps objects.
 */
export function parseCachedResults(
  jsonb: ISearchResultProps[] | null,
): ISearchResultProps[] {
  if (!jsonb || jsonb.length === 0) return [];
  return jsonb;
}

/**
 * Extract unique document IDs from search results for the reverse index.
 * These are stored in source_doc_ids so document_update/delete can
 * invalidate affected cache entries.
 */
export function extractSourceDocIds(
  results: Array<{ id: number }>,
): number[] {
  return [...new Set(results.map(r => r.id))];
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/semantic-cache.test.ts
```
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd ~/repos/ledger
git add src/lib/search/semantic-cache.ts tests/semantic-cache.test.ts
git commit -m "add semantic cache TypeScript helpers with tests"
```

---

## Task 4: Integrate into searchByVector

**Files:**
- Modify: `src/lib/search/ai-search.ts`

- [ ] **Step 1: Add imports at the top of ai-search.ts**

After the existing imports (line 8), add:

```typescript
import {
  buildSearchParams,
  parseCachedResults,
  extractSourceDocIds,
  SEMANTIC_CACHE_MODEL_ID,
  SEMANTIC_CACHE_THRESHOLD,
} from './semantic-cache.js';
```

- [ ] **Step 2: Replace searchByVector function body**

Replace the `searchByVector` function (lines 149-176) with:

```typescript
export async function searchByVector(
  clients: IClientsProps,
  props: IVectorSearchProps,
): Promise<ISearchResultProps[]> {
  const startTime = Date.now();
  const queryEmbedding = await getOrCacheQueryEmbedding(clients, props.query);
  const embeddingString = toVectorString(queryEmbedding);

  // Semantic cache lookup (layer 2)
  const searchParams = buildSearchParams({
    threshold: props.threshold ?? 0.38,
    limit: props.limit ?? 10,
    domain: props.domain,
    document_type: props.document_type,
    project: props.project,
  });

  const { data: cachedResults } = await clients.supabase.rpc('semantic_cache_lookup', {
    p_query_embedding: embeddingString,
    p_search_mode: 'vector',
    p_search_params: searchParams,
    p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
    p_similarity_threshold: SEMANTIC_CACHE_THRESHOLD,
  });

  if (cachedResults) {
    const results = cachedResults as ISearchResultProps[];
    if (results.length > 0) {
      logSearchEvaluation(clients.supabase, {
        query: props.query,
        searchMode: 'vector',
        results,
        responseTimeMs: Date.now() - startTime,
      });
      return results;
    }
  }

  // Cache miss: run full search pipeline
  const { data, error } = await clients.supabase.rpc('match_documents', {
    q_emb: embeddingString,
    p_threshold: props.threshold ?? 0.38,
    p_max_results: props.limit ?? 10,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
  });

  if (error) throw new Error(`Vector search failed for "${props.query}": ${error.message}`);
  const results = (data ?? []) as ISearchResultProps[];

  // Store in semantic cache (non-blocking)
  if (results.length > 0) {
    const sourceDocIds = extractSourceDocIds(results);
    clients.supabase.rpc('semantic_cache_store', {
      p_query_text: props.query,
      p_query_embedding: embeddingString,
      p_search_mode: 'vector',
      p_search_params: searchParams,
      p_cached_results: results,
      p_source_doc_ids: sourceDocIds,
      p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
    }).then(() => {}).catch((err: { message?: string }) => {
      process.stderr.write(`[ledger] semantic cache store failed: ${err.message ?? 'unknown'}\n`);
    });
  }

  logSearchEvaluation(clients.supabase, {
    query: props.query,
    searchMode: 'vector',
    results,
    responseTimeMs: Date.now() - startTime,
  });

  return results;
}
```

- [ ] **Step 3: Verify typecheck passes**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 4: Run existing search tests**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/ai-search.test.ts
```
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/search/ai-search.ts
git commit -m "integrate semantic cache into searchByVector"
```

---

## Task 5: Integrate into searchHybrid

**Files:**
- Modify: `src/lib/search/ai-search.ts`

- [ ] **Step 1: Replace searchHybrid function body**

Replace the `searchHybrid` function with:

```typescript
export async function searchHybrid(
  clients: IClientsProps,
  props: IHybridSearchProps,
): Promise<ISearchResultProps[]> {
  const startTime = Date.now();
  const queryEmbedding = await getOrCacheQueryEmbedding(clients, props.query);
  const embeddingString = toVectorString(queryEmbedding);

  const useReranker = props.reranker === 'cohere' && clients.cohereApiKey;
  const desiredLimit = props.limit ?? 10;
  const requestLimit = useReranker ? desiredLimit * 2 : desiredLimit;

  // Semantic cache lookup (layer 2)
  // Skip cache when reranker is enabled (reranker produces different ordering)
  const searchParams = buildSearchParams({
    threshold: props.threshold ?? 0.38,
    limit: requestLimit,
    domain: props.domain,
    document_type: props.document_type,
    project: props.project,
  });

  if (!useReranker) {
    const { data: cachedResults } = await clients.supabase.rpc('semantic_cache_lookup', {
      p_query_embedding: embeddingString,
      p_search_mode: 'hybrid',
      p_search_params: searchParams,
      p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
      p_similarity_threshold: SEMANTIC_CACHE_THRESHOLD,
    });

    if (cachedResults) {
      const results = cachedResults as ISearchResultProps[];
      if (results.length > 0) {
        logSearchEvaluation(clients.supabase, {
          query: props.query,
          searchMode: 'hybrid',
          results,
          responseTimeMs: Date.now() - startTime,
        });
        return results;
      }
    }
  }

  // Cache miss: run full search pipeline
  const { data, error } = await clients.supabase.rpc('match_documents_hybrid', {
    q_emb: embeddingString,
    q_text: props.query,
    p_threshold: props.threshold ?? 0.38,
    p_max_results: requestLimit,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
    p_rrf_k: props.reciprocalRankFusionK ?? 60,
  });

  if (error) throw new Error(`Hybrid search failed for "${props.query}": ${error.message}`);
  let results = (data ?? []) as ISearchResultProps[];

  if (useReranker && results.length > 0) {
    results = await rerankResults(props.query, results, {
      apiKey: clients.cohereApiKey!,
      topN: desiredLimit,
    });
  }

  // Store in semantic cache (non-blocking, skip if reranker was used)
  if (results.length > 0 && !useReranker) {
    const sourceDocIds = extractSourceDocIds(results);
    clients.supabase.rpc('semantic_cache_store', {
      p_query_text: props.query,
      p_query_embedding: embeddingString,
      p_search_mode: 'hybrid',
      p_search_params: searchParams,
      p_cached_results: results,
      p_source_doc_ids: sourceDocIds,
      p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
    }).then(() => {}).catch((err: { message?: string }) => {
      process.stderr.write(`[ledger] semantic cache store failed: ${err.message ?? 'unknown'}\n`);
    });
  }

  logSearchEvaluation(clients.supabase, {
    query: props.query,
    searchMode: useReranker ? 'hybrid+rerank' : 'hybrid',
    results,
    responseTimeMs: Date.now() - startTime,
  });

  return results;
}
```

- [ ] **Step 2: Verify typecheck passes**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Run existing search tests**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/ai-search.test.ts
```
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
cd ~/repos/ledger
git add src/lib/search/ai-search.ts
git commit -m "integrate semantic cache into searchHybrid"
```

---

## Task 6: Full Test Suite + Build

**Files:** None (validation only)

- [ ] **Step 1: Run full test suite**

Run:
```bash
cd ~/repos/ledger && npx vitest run
```
Expected: All tests PASS (212+ TypeScript tests)

- [ ] **Step 2: Run typecheck**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Run build**

Run:
```bash
cd ~/repos/ledger && npm run build
```
Expected: Build succeeds

---

## Task 7: Documentation Updates

**Files:**
- Modify: `docs/ledger-architecture.md`
- Modify: `docs/reference-rag-operations-scaling.md` (if Ledger Implementation section exists)

- [ ] **Step 1: Update ledger-architecture.md**

Add the semantic cache to the Search section and update the RAG Pipeline section to show the cache layer. Add `semantic-cache.ts` to the Repo Structure.

- [ ] **Step 2: Update Ledger error log in Ledger**

No error log needed (this is a new feature, not a bug fix).

- [ ] **Step 3: Update ledger-architecture in Ledger via sync**

Run:
```bash
cd ~/repos/ledger && npx tsx src/scripts/sync-local-docs.ts --file docs/ledger-architecture.md
```

- [ ] **Step 4: Commit docs**

```bash
cd ~/repos/ledger
git add docs/ledger-architecture.md
git commit -m "update architecture docs with semantic cache"
```
