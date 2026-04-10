-- Migration 009: Semantic Cache
-- Layer 2 cache: stores full search results keyed by query embedding.
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
