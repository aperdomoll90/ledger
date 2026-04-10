# Semantic Cache Design

> Spec date: 2026-04-10 (Session 37)
> Status: Approved design, pending implementation
> Phase: 4.5.5

## Problem

Every search query runs the full pipeline: embed the query (OpenAI API call), vector scan (HNSW), keyword scan (GIN), RRF (Reciprocal Rank Fusion) merge, return results. When semantically similar queries arrive ("how does auth work" and "how does authentication work"), the system repeats all that work even though the results would be nearly identical.

## Solution

A new cache layer (layer 2 in the five-layer RAG caching architecture) that stores full search results keyed by query embedding. Before running the full search pipeline, check if a semantically similar query was recently cached. If so, return the cached results directly with zero database calls. If not, run the full pipeline and store the results for future queries. Staleness is handled by the reverse index invalidation: when a document changes, all cache entries containing that document are deleted.

### What This Is Not

- Not replacing the existing query_cache (layer 1). That caches embeddings to skip OpenAI API calls. This caches search results to skip the entire database search.
- Not a partial cache. Full `ISearchResultProps` objects are cached, returned directly on hit. Staleness is prevented by reverse index invalidation (document changes delete affected cache entries).
- Not an LLM response cache (layer 5). Ledger returns documents, not generated answers.

## Architecture

### New Components

| Component                         | Where                           | Purpose                                           |
|-----------------------------------|---------------------------------|---------------------------------------------------|
| `semantic_cache` table            | Postgres (new)                  | Stores cached result IDs + scores per query       |
| HNSW index on `query_embedding`   | Postgres (new)                  | Fast similarity lookup for incoming queries       |
| GIN index on `source_doc_ids`     | Postgres (new)                  | Fast reverse index for invalidation               |
| `semantic_cache_lookup` RPC       | Postgres (new)                  | Find cache hit by vector similarity > 0.90        |
| `semantic_cache_store` RPC        | Postgres (new)                  | Save new cache entry with source_doc_ids          |
| `semantic_cache_cleanup` function | Postgres (new)                  | Purge expired entries (TTL = 7 days)              |

### Modified Components

| Component                         | Where                           | Change                                            |
|-----------------------------------|---------------------------------|---------------------------------------------------|
| `document_update` RPC            | Postgres (modify)               | Invalidate cache entries containing updated doc   |
| `document_delete` RPC            | Postgres (modify)               | Invalidate cache entries containing deleted doc   |
| `searchByVector`                 | `ai-search.ts` (modify)        | Check cache before search, store after            |
| `searchByKeyword`                | `ai-search.ts` (modify)        | Check cache before search, store after            |
| `searchHybrid`                   | `ai-search.ts` (modify)        | Check cache before search, store after            |

## Table Schema

```sql
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
```

### Column Details

| Column               | Purpose                                                                        |
|----------------------|--------------------------------------------------------------------------------|
| `query_text`         | Original query string (for debugging and observability)                        |
| `query_embedding`    | The 1536-dimension vector used for similarity matching                         |
| `search_mode`        | Which search function produced these results (vector, keyword, hybrid)         |
| `search_params`      | Serialized search parameters: threshold, limit, domain, project, doc_type      |
| `cached_results`     | JSONB array of full `ISearchResultProps` objects (complete result shape)        |
| `source_doc_ids`     | Integer array of all document IDs in the results (reverse index for invalidation)|
| `embedding_model_id` | Which embedding model generated the vector (invalidate on model change)        |
| `created_at`         | When the entry was created                                                     |
| `expires_at`         | When the entry expires (TTL = 7 days from creation)                            |

### Indexes

| Index                                | Type   | Column            | Purpose                                       |
|--------------------------------------|--------|-------------------|-----------------------------------------------|
| `idx_semantic_cache_embedding`       | HNSW   | `query_embedding`  | Fast approximate nearest neighbor lookup       |
| `idx_semantic_cache_source_doc_ids`  | GIN    | `source_doc_ids`   | Fast reverse index invalidation (`@>` operator)|
| `idx_semantic_cache_expires_at`      | BTREE  | `expires_at`       | Efficient TTL cleanup                          |

## Search Flow (with cache)

```
query arrives
    |
    v
embed query (layer 1: query_cache handles this, skips OpenAI if cached)
    |
    v
semantic_cache_lookup(embedding, search_mode, params)
    |
    +--> HIT (similarity > 0.90, not expired, params match)
    |       |
    |       v
    |    return cached_results (full ISearchResultProps[], zero DB calls)
    |
    +--> MISS
            |
            v
         run full search pipeline (vector + keyword + RRF fusion)
            |
            v
         semantic_cache_store(query, embedding, results, source_doc_ids)
            |
            v
         return results
```

## Cache Hit Criteria

A cache hit requires ALL of these conditions:

1. **Cosine similarity > 0.90** between the incoming query embedding and a cached entry's embedding
2. **Same search_mode** (hybrid, vector, keyword)
3. **Same search_params** (domain, project, threshold, limit filters must match via Postgres JSONB `=` operator, which is key-order independent)
4. **Not expired** (`expires_at > now()`)
5. **Same embedding_model_id** (prevents stale results from old model versions)

This prevents cross-contamination between different search contexts. A hybrid search filtered to project "ledger" will not return cached results from a vector search filtered to project "atelier."

## Cache Invalidation

### Primary Mechanism: Reverse Index (Event-Driven)

Built into existing Postgres RPC functions:

| Event             | RPC Function        | Invalidation Action                                              |
|-------------------|---------------------|------------------------------------------------------------------|
| Document created  | `document_create`   | None needed (new doc was not in any cached results)              |
| Document updated  | `document_update`   | `DELETE FROM semantic_cache WHERE source_doc_ids @> ARRAY[p_id]` |
| Document deleted  | `document_delete`   | `DELETE FROM semantic_cache WHERE source_doc_ids @> ARRAY[p_id]` |

The `@>` operator ("contains") on the GIN-indexed `source_doc_ids` column performs this check efficiently.

### Safety Net: TTL (Time-Based)

Every entry has `expires_at = created_at + 7 days`. A cleanup function (`semantic_cache_cleanup`) deletes expired entries. This catches any edge cases the event-driven invalidation misses (e.g., direct SQL updates, bugs in invalidation logic).

### Model Change Invalidation

The `embedding_model_id` in the cache hit criteria ensures that changing the embedding model automatically causes cache misses for all old entries. No manual flush needed.

## RPC Functions

### `semantic_cache_lookup`

**Input:** query_embedding (vector), search_mode (text), search_params (jsonb), embedding_model_id (text)
**Output:** cached_results (jsonb) or NULL

1. Find the nearest neighbor in semantic_cache using HNSW index
2. Check cosine similarity > 0.90
3. Check search_mode, search_params, embedding_model_id match exactly
4. Check expires_at > now()
5. Return cached_results if all conditions met, NULL otherwise

### `semantic_cache_store`

**Input:** query_text, query_embedding, search_mode, search_params, cached_results (jsonb), source_doc_ids (int[]), embedding_model_id
**Output:** void

Insert a new row into semantic_cache. If an exact query_text + search_mode + search_params combination already exists, update it (upsert).

### `semantic_cache_cleanup`

**Input:** none
**Output:** number of rows deleted

`DELETE FROM semantic_cache WHERE expires_at < now()`. Intended to be called periodically (e.g., daily via cron or on-demand).

## Configuration

| Parameter                | Value  | Rationale                                               |
|--------------------------|--------|---------------------------------------------------------|
| Cosine similarity threshold | 0.90 | Production sweet spot (Netflix uses 0.90). Strict enough to avoid false positives, permissive enough for useful hit rates. |
| TTL                      | 7 days | Documents change infrequently. Active invalidation handles the normal case. TTL is the safety net. |
| HNSW `m`                 | 16     | Default, sufficient for cache-sized datasets            |
| HNSW `ef_construction`   | 128    | Default, good build quality                             |

## Testing

### pgTAP Tests

- `semantic_cache_lookup` returns NULL on empty cache
- `semantic_cache_lookup` returns results for similar query above threshold
- `semantic_cache_lookup` returns NULL for dissimilar query below threshold
- `semantic_cache_lookup` returns NULL when search_params differ
- `semantic_cache_lookup` returns NULL for expired entry
- `semantic_cache_store` creates entry with correct source_doc_ids
- `document_update` invalidation deletes affected cache entries
- `document_delete` invalidation deletes affected cache entries
- `semantic_cache_cleanup` deletes expired entries

### TypeScript Tests

- searchHybrid returns cached results on cache hit (mock RPC)
- searchHybrid stores results on cache miss (mock RPC)
- searchByVector and searchByKeyword use cache correctly
- Cache miss falls through to full search pipeline

### Eval Verification

- Run 15 with cache enabled vs run 14 baseline
- Results should be identical (same document IDs, same scores)
- Only difference: latency (cache hits should be faster)

## Scope Boundaries

**In scope:**
- semantic_cache table + indexes
- 3 RPC functions (lookup, store, cleanup)
- Invalidation in document_update and document_delete RPCs
- Integration in all 3 search functions in ai-search.ts
- pgTAP and TypeScript tests

**Out of scope:**
- Caching document content (layer 3+)
- Automatic cleanup scheduling (manual or future cron)
- Cache warming (pre-populating from search_evaluations history)
- Cache analytics/observability dashboard
- Reranker result caching (reranker is disabled)
