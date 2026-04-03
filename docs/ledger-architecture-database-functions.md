# Ledger — Database Functions

> Full SQL for all 17 Postgres functions. Signatures, parameters, implementation.
>
> Updated: 2026-04-03. Parent doc: `ledger-architecture-database.md`

---

## Table of Contents

- [Summary](#summary)
  - [Document Operations (6)](#document-operations-6)
  - [Search (4)](#search-4)
  - [Evaluation and Maintenance (7)](#evaluation-and-maintenance-7)
- [Function SQL](#function-sql)
  - [document_create](#document_create)
  - [document_update](#document_update)
  - [document_update_fields](#document_update_fields)
  - [document_delete](#document_delete)
  - [document_restore](#document_restore)
  - [document_purge](#document_purge)
  - [match_documents](#match_documents)
  - [match_documents_keyword](#match_documents_keyword)
  - [match_documents_hybrid](#match_documents_hybrid)
  - [retrieve_context](#retrieve_context)
  - [aggregate_search_evaluations](#aggregate_search_evaluations)
  - [cleanup_search_evaluations](#cleanup_search_evaluations)
  - [cleanup_document_versions](#cleanup_document_versions)
  - [cleanup_query_cache](#cleanup_query_cache)
  - [create_audit_partition_if_needed](#create_audit_partition_if_needed)
  - [trg_documents_set_updated_at](#trg_documents_set_updated_at)
- [Active vs Unused](#active-vs-unused)

---

## Summary

### Document Operations (6)

| Function                 | Returns  | Purpose                                           |
|--------------------------|----------|---------------------------------------------------|
| `document_create`        | bigint   | Insert document + chunks + audit (atomic)         |
| `document_update`        | void     | Save version → update content → replace chunks → audit |
| `document_update_fields` | void     | Update metadata columns (no re-embedding) → sync chunk domain → audit |
| `document_delete`        | void     | Save to audit diff → soft delete → remove chunks  |
| `document_restore`       | void     | Clear deleted_at → audit (chunks must be regenerated separately) |
| `document_purge`         | integer  | Hard delete docs past grace period (default 30 days) |

### Search (4)

| Function                   | Returns | Purpose                                                   |
|----------------------------|---------|-----------------------------------------------------------|
| `match_documents`          | TABLE   | Vector search — cosine similarity on chunk embeddings     |
| `match_documents_keyword`  | TABLE   | Keyword search — tsvector + `websearch_to_tsquery`        |
| `match_documents_hybrid`   | TABLE   | Hybrid — vector + keyword combined via RRF fusion         |
| `retrieve_context`         | TABLE   | Smart retrieval — full doc if small, chunk + neighbors if large |

### Evaluation and Maintenance (7)

| Function                          | Returns | Purpose                                             |
|-----------------------------------|---------|-----------------------------------------------------|
| `aggregate_search_evaluations`    | void    | Crunch raw search_evaluations into daily summaries   |
| `cleanup_search_evaluations`      | void    | Delete raw rows older than N days (after aggregation)|
| `cleanup_document_versions`       | void    | Keep only last N versions per document               |
| `cleanup_query_cache`             | void    | Remove stale cached query embeddings                 |
| `create_audit_partition_if_needed`| void    | Auto-create next year's audit_log partition           |
| `document_purge`                  | integer | (listed above — also serves as maintenance)          |
| `trg_documents_set_updated_at`    | trigger | Auto-set updated_at on document changes              |

---

## Function SQL

### document_create

```sql
CREATE OR REPLACE FUNCTION public.document_create(
  p_name text, p_domain text, p_document_type text, p_project text,
  p_protection text, p_owner_type text, p_owner_id text, p_is_auto_load boolean,
  p_content text, p_description text, p_content_hash text,
  p_source_type text DEFAULT 'text', p_source_url text DEFAULT NULL,
  p_file_path text DEFAULT NULL, p_file_permissions text DEFAULT NULL,
  p_agent text DEFAULT NULL, p_status text DEFAULT NULL,
  p_skill_ref text DEFAULT NULL, p_embedding_model_id text DEFAULT NULL,
  p_chunk_contents text[] DEFAULT NULL, p_chunk_embeddings vector[] DEFAULT NULL,
  p_chunk_strategy text DEFAULT 'recursive',
  p_chunk_summaries text[] DEFAULT NULL,
  p_chunk_token_counts int[] DEFAULT NULL,
  p_chunk_overlap int DEFAULT 0
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_doc_id bigint;
  i int;
BEGIN
  INSERT INTO documents (
    name, domain, document_type, project, protection,
    owner_type, owner_id, is_auto_load,
    content, description, content_hash,
    source_type, source_url, file_path, file_permissions,
    agent, status, skill_ref, embedding_model_id
  ) VALUES (
    p_name, p_domain, p_document_type, p_project, p_protection,
    p_owner_type, p_owner_id, p_is_auto_load,
    p_content, p_description, p_content_hash,
    p_source_type, p_source_url, p_file_path, p_file_permissions,
    p_agent, p_status, p_skill_ref, p_embedding_model_id
  ) RETURNING id INTO v_doc_id;

  IF p_chunk_contents IS NOT NULL THEN
    FOR i IN 1..array_length(p_chunk_contents, 1) LOOP
      INSERT INTO document_chunks (
        document_id, chunk_index, content, domain, embedding,
        embedding_model_id, chunk_strategy, context_summary, token_count, overlap_chars
      )
      VALUES (
        v_doc_id, i - 1, p_chunk_contents[i], p_domain, p_chunk_embeddings[i],
        p_embedding_model_id, p_chunk_strategy,
        CASE WHEN p_chunk_summaries IS NOT NULL THEN p_chunk_summaries[i] ELSE NULL END,
        CASE WHEN p_chunk_token_counts IS NOT NULL THEN p_chunk_token_counts[i] ELSE NULL END,
        p_chunk_overlap
      );
    END LOOP;
    UPDATE documents SET chunk_count = array_length(p_chunk_contents, 1) WHERE id = v_doc_id;
  END IF;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (v_doc_id, p_domain, 'create', COALESCE(p_agent, 'unknown'), NULL, now());

  RETURN v_doc_id;
END;
$$;
```

### document_update

```sql
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
```

### document_update_fields

```sql
CREATE OR REPLACE FUNCTION public.document_update_fields(
  p_id bigint, p_agent text DEFAULT NULL,
  p_name text DEFAULT NULL, p_domain text DEFAULT NULL,
  p_document_type text DEFAULT NULL, p_project text DEFAULT NULL,
  p_protection text DEFAULT NULL, p_owner_type text DEFAULT NULL,
  p_owner_id text DEFAULT NULL, p_is_auto_load boolean DEFAULT NULL,
  p_description text DEFAULT NULL, p_source_type text DEFAULT NULL,
  p_source_url text DEFAULT NULL, p_file_path text DEFAULT NULL,
  p_file_permissions text DEFAULT NULL, p_status text DEFAULT NULL,
  p_skill_ref text DEFAULT NULL, p_embedding_model_id text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_old     record;
  v_domain  text;
  v_agent   text;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_old FROM documents WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document % not found', p_id; END IF;

  UPDATE documents SET
    name = COALESCE(p_name, name), domain = COALESCE(p_domain, domain),
    document_type = COALESCE(p_document_type, document_type), project = COALESCE(p_project, project),
    protection = COALESCE(p_protection, protection), owner_type = COALESCE(p_owner_type, owner_type),
    owner_id = COALESCE(p_owner_id, owner_id), is_auto_load = COALESCE(p_is_auto_load, is_auto_load),
    description = COALESCE(p_description, description), source_type = COALESCE(p_source_type, source_type),
    source_url = COALESCE(p_source_url, source_url), file_path = COALESCE(p_file_path, file_path),
    file_permissions = COALESCE(p_file_permissions, file_permissions), agent = COALESCE(p_agent, agent),
    status = COALESCE(p_status, status), skill_ref = COALESCE(p_skill_ref, skill_ref),
    embedding_model_id = COALESCE(p_embedding_model_id, embedding_model_id)
  WHERE id = p_id;

  v_domain := COALESCE(p_domain, v_old.domain);
  v_agent := COALESCE(p_agent, v_old.agent, 'unknown');

  IF p_domain IS NOT NULL AND p_domain IS DISTINCT FROM v_old.domain THEN
    UPDATE document_chunks SET domain = p_domain WHERE document_id = p_id;
  END IF;

  IF p_name IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('name', v_old.name); END IF;
  IF p_domain IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('domain', v_old.domain); END IF;
  IF p_document_type IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('document_type', v_old.document_type); END IF;
  IF p_project IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('project', v_old.project); END IF;
  IF p_protection IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('protection', v_old.protection); END IF;
  IF p_status IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('status', v_old.status); END IF;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_domain, 'update_fields', v_agent, v_changes, now());
END;
$$;
```

### document_delete

```sql
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

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_domain, 'delete', p_agent, jsonb_build_object('content', v_content, 'fields', v_fields), now());

  UPDATE documents SET deleted_at = now() WHERE id = p_id;
  DELETE FROM document_chunks WHERE document_id = p_id;
END;
$$;
```

### document_restore

```sql
CREATE OR REPLACE FUNCTION public.document_restore(p_id bigint, p_agent text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_domain text;
BEGIN
  SELECT domain INTO v_domain FROM documents WHERE id = p_id AND deleted_at IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document % not found or not deleted', p_id; END IF;

  UPDATE documents SET deleted_at = NULL WHERE id = p_id;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_domain, 'restore', p_agent, NULL, now());
END;
$$;
```

### document_purge

```sql
CREATE OR REPLACE FUNCTION public.document_purge(p_older_than interval DEFAULT '30 days')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM documents WHERE deleted_at IS NOT NULL AND deleted_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

### match_documents

```sql
CREATE OR REPLACE FUNCTION public.match_documents(
  q_emb vector, p_threshold double precision, p_max_results integer,
  p_domain text DEFAULT NULL, p_document_type text DEFAULT NULL, p_project text DEFAULT NULL
) RETURNS TABLE(
  id bigint, content text, name text, domain text, document_type text,
  project text, protection text, description text, agent text, status text,
  file_path text, skill_ref text, owner_type text, owner_id text,
  is_auto_load boolean, content_hash text, similarity double precision
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (n.id)
    n.id, n.content, n.name, n.domain, n.document_type,
    n.project, n.protection, n.description, n.agent, n.status,
    n.file_path, n.skill_ref, n.owner_type, n.owner_id,
    n.is_auto_load, n.content_hash,
    (1 - (c.embedding <=> q_emb))::float AS similarity
  FROM document_chunks c
  JOIN documents n ON n.id = c.document_id
  WHERE n.deleted_at IS NULL
    AND 1 - (c.embedding <=> q_emb) > p_threshold
    AND (p_domain IS NULL OR c.domain = p_domain)
    AND (p_document_type IS NULL OR n.document_type = p_document_type)
    AND (p_project IS NULL OR n.project = p_project)
  ORDER BY n.id, similarity DESC
  LIMIT p_max_results;
END;
$$;
```

### match_documents_keyword

```sql
CREATE OR REPLACE FUNCTION public.match_documents_keyword(
  p_query text, p_max_results integer DEFAULT 10,
  p_domain text DEFAULT NULL, p_document_type text DEFAULT NULL, p_project text DEFAULT NULL
) RETURNS TABLE(
  id bigint, content text, name text, domain text, document_type text,
  project text, protection text, description text, agent text, status text,
  file_path text, skill_ref text, owner_type text, owner_id text,
  is_auto_load boolean, content_hash text, rank double precision
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    n.id, n.content, n.name, n.domain, n.document_type,
    n.project, n.protection, n.description, n.agent, n.status,
    n.file_path, n.skill_ref, n.owner_type, n.owner_id,
    n.is_auto_load, n.content_hash,
    ts_rank(n.search_vector, websearch_to_tsquery('english', p_query))::float AS rank
  FROM documents n
  WHERE n.deleted_at IS NULL
    AND n.search_vector @@ websearch_to_tsquery('english', p_query)
    AND (p_domain IS NULL OR n.domain = p_domain)
    AND (p_document_type IS NULL OR n.document_type = p_document_type)
    AND (p_project IS NULL OR n.project = p_project)
  ORDER BY rank DESC
  LIMIT p_max_results;
END;
$$;
```

### match_documents_hybrid

```sql
CREATE OR REPLACE FUNCTION public.match_documents_hybrid(
  q_emb vector, q_text text,
  p_threshold double precision DEFAULT 0.5, p_max_results integer DEFAULT 10,
  p_domain text DEFAULT NULL, p_document_type text DEFAULT NULL,
  p_project text DEFAULT NULL, p_rrf_k integer DEFAULT 60
) RETURNS TABLE(
  id bigint, content text, name text, domain text, document_type text,
  project text, protection text, description text, agent text, status text,
  file_path text, skill_ref text, owner_type text, owner_id text,
  is_auto_load boolean, content_hash text, score double precision
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH vector_results AS (
    SELECT DISTINCT ON (n.id)
      n.id AS document_id,
      ROW_NUMBER() OVER (ORDER BY (c.embedding <=> q_emb)) AS rank
    FROM document_chunks c
    JOIN documents n ON n.id = c.document_id
    WHERE n.deleted_at IS NULL
      AND 1 - (c.embedding <=> q_emb) > p_threshold
      AND (p_domain IS NULL OR c.domain = p_domain)
      AND (p_document_type IS NULL OR n.document_type = p_document_type)
      AND (p_project IS NULL OR n.project = p_project)
    ORDER BY n.id, (c.embedding <=> q_emb)
    LIMIT p_max_results * 2
  ),
  keyword_results AS (
    SELECT
      n.id AS document_id,
      ROW_NUMBER() OVER (ORDER BY ts_rank(n.search_vector, websearch_to_tsquery('english', q_text)) DESC) AS rank
    FROM documents n
    WHERE n.deleted_at IS NULL
      AND n.search_vector @@ websearch_to_tsquery('english', q_text)
      AND (p_domain IS NULL OR n.domain = p_domain)
      AND (p_document_type IS NULL OR n.document_type = p_document_type)
      AND (p_project IS NULL OR n.project = p_project)
    LIMIT p_max_results * 2
  ),
  fused AS (
    SELECT
      COALESCE(v.document_id, k.document_id) AS document_id,
      COALESCE(1.0 / (p_rrf_k + v.rank), 0) + COALESCE(1.0 / (p_rrf_k + k.rank), 0) AS rrf_score
    FROM vector_results v
    FULL OUTER JOIN keyword_results k ON v.document_id = k.document_id
    ORDER BY rrf_score DESC
    LIMIT p_max_results
  )
  SELECT
    n.id, n.content, n.name, n.domain, n.document_type,
    n.project, n.protection, n.description, n.agent, n.status,
    n.file_path, n.skill_ref, n.owner_type, n.owner_id,
    n.is_auto_load, n.content_hash,
    f.rrf_score::float AS score
  FROM fused f
  JOIN documents n ON n.id = f.document_id
  ORDER BY f.rrf_score DESC;
END;
$$;
```

### retrieve_context

```sql
CREATE OR REPLACE FUNCTION public.retrieve_context(
  p_document_id bigint, p_matched_chunk_index integer,
  p_context_window integer DEFAULT 4000, p_neighbor_count integer DEFAULT 1
) RETURNS TABLE(
  document_id bigint, document_name text, retrieval_mode text,
  content text, matched_section text
) LANGUAGE plpgsql AS $$
DECLARE
  v_doc record;
BEGIN
  SELECT d.id, d.name, d.content, d.content_length, d.chunk_count
  INTO v_doc FROM documents d WHERE d.id = p_document_id AND d.deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document % not found', p_document_id; END IF;

  IF v_doc.content_length <= p_context_window THEN
    RETURN QUERY SELECT v_doc.id, v_doc.name, 'full'::text, v_doc.content, v_doc.content::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_doc.id, v_doc.name, 'chunked'::text, v_doc.content,
    string_agg(c.content, E'\n\n' ORDER BY c.chunk_index)
  FROM document_chunks c
  WHERE c.document_id = p_document_id
    AND c.chunk_index BETWEEN
      GREATEST(0, p_matched_chunk_index - p_neighbor_count)
      AND LEAST(v_doc.chunk_count - 1, p_matched_chunk_index + p_neighbor_count)
  GROUP BY v_doc.id, v_doc.name, v_doc.content;
  RETURN;
END;
$$;
```

### aggregate_search_evaluations

```sql
CREATE OR REPLACE FUNCTION public.aggregate_search_evaluations(
  p_date date DEFAULT (CURRENT_DATE - '1 day'::interval)::date
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_search_count int;
  v_avg_result_count float;
  v_avg_response_time_ms float;
  v_zero_result_count int;
  v_zero_result_rate float;
  v_avg_score float;
  v_searches_by_mode jsonb;
  v_top_document_types jsonb;
  v_feedback_counts jsonb;
BEGIN
  SELECT count(*)::int, coalesce(avg(result_count), 0), coalesce(avg(response_time_ms), 0),
    count(*) FILTER (WHERE result_count = 0)::int,
    CASE WHEN count(*) > 0 THEN count(*) FILTER (WHERE result_count = 0)::float / count(*) ELSE 0 END,
    avg((results->0->>'score')::float)
  INTO v_search_count, v_avg_result_count, v_avg_response_time_ms,
    v_zero_result_count, v_zero_result_rate, v_avg_score
  FROM search_evaluations WHERE created_at::date = p_date;

  IF v_search_count = 0 THEN RETURN; END IF;

  SELECT coalesce(jsonb_object_agg(search_mode, mode_count), '{}') INTO v_searches_by_mode
  FROM (SELECT search_mode, count(*) AS mode_count FROM search_evaluations WHERE created_at::date = p_date GROUP BY search_mode) modes;

  SELECT coalesce(jsonb_object_agg(doc_type, type_count), '{}') INTO v_top_document_types
  FROM (SELECT unnest(document_types) AS doc_type, count(*) AS type_count FROM search_evaluations WHERE created_at::date = p_date GROUP BY doc_type) dtypes;

  SELECT jsonb_build_object(
    'relevant', count(*) FILTER (WHERE feedback = 'relevant'),
    'irrelevant', count(*) FILTER (WHERE feedback = 'irrelevant'),
    'partial', count(*) FILTER (WHERE feedback = 'partial'),
    'none', count(*) FILTER (WHERE feedback IS NULL)
  ) INTO v_feedback_counts FROM search_evaluations WHERE created_at::date = p_date;

  INSERT INTO search_evaluation_aggregates (
    date, search_count, avg_result_count, avg_response_time_ms,
    zero_result_count, zero_result_rate, avg_score,
    searches_by_mode, top_document_types, feedback_counts
  ) VALUES (
    p_date, v_search_count, v_avg_result_count, v_avg_response_time_ms,
    v_zero_result_count, v_zero_result_rate, v_avg_score,
    v_searches_by_mode, v_top_document_types, v_feedback_counts
  ) ON CONFLICT (date) DO UPDATE SET
    search_count = EXCLUDED.search_count, avg_result_count = EXCLUDED.avg_result_count,
    avg_response_time_ms = EXCLUDED.avg_response_time_ms, zero_result_count = EXCLUDED.zero_result_count,
    zero_result_rate = EXCLUDED.zero_result_rate, avg_score = EXCLUDED.avg_score,
    searches_by_mode = EXCLUDED.searches_by_mode, top_document_types = EXCLUDED.top_document_types,
    feedback_counts = EXCLUDED.feedback_counts;
END;
$$;
```

### cleanup_search_evaluations

```sql
CREATE OR REPLACE FUNCTION public.cleanup_search_evaluations(p_older_than interval DEFAULT '30 days')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM search_evaluations WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

### cleanup_document_versions

```sql
CREATE OR REPLACE FUNCTION public.cleanup_document_versions(p_keep_count integer DEFAULT 10)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM document_versions WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY version_number DESC) AS row_num
      FROM document_versions
    ) ranked WHERE row_num > p_keep_count
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

### cleanup_query_cache

```sql
CREATE OR REPLACE FUNCTION public.cleanup_query_cache(p_older_than interval DEFAULT '7 days')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM query_cache WHERE last_used_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

### create_audit_partition_if_needed

```sql
CREATE OR REPLACE FUNCTION public.create_audit_partition_if_needed()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_next_year int := EXTRACT(YEAR FROM now())::int + 1;
  v_partition  text := 'audit_log_' || v_next_year;
  v_start      text := v_next_year || '-01-01';
  v_end        text := (v_next_year + 1) || '-01-01';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_partition) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      v_partition, v_start, v_end
    );
  END IF;
END;
$$;
```

### trg_documents_set_updated_at

```sql
CREATE OR REPLACE FUNCTION trg_documents_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION trg_documents_set_updated_at();
```

---

## Active vs Unused

| Function                          | Used in Code? | Notes                                            |
|-----------------------------------|---------------|--------------------------------------------------|
| `document_create`                 | Yes           | Called by `createDocument()` in operations.ts     |
| `document_update`                 | Yes           | Called by `updateDocument()` in operations.ts     |
| `document_update_fields`          | Yes           | Called by `updateDocumentFields()` in MCP server  |
| `document_delete`                 | Yes           | Called by MCP `delete_document` tool              |
| `document_restore`                | Yes           | Called by MCP `restore_document` tool             |
| `document_purge`                  | **No**        | Function exists — no cron wired (Phase 7)        |
| `match_documents`                 | Yes           | Called by `searchByVector()` in ai-search.ts      |
| `match_documents_keyword`         | Yes           | Called by `searchByKeyword()` in ai-search.ts     |
| `match_documents_hybrid`          | Yes           | Called by `searchHybrid()` in ai-search.ts        |
| `retrieve_context`                | Yes           | Called by MCP `get_document_context` tool          |
| `aggregate_search_evaluations`    | **No**        | Function exists — no cron wired (Phase 7)        |
| `cleanup_search_evaluations`      | **No**        | Function exists — no cron wired (Phase 7)        |
| `cleanup_document_versions`       | **No**        | Function exists — no cron wired (Phase 7)        |
| `cleanup_query_cache`             | **No**        | Function exists — no cron wired (Phase 7)        |
| `create_audit_partition_if_needed`| **No**        | Function exists — no cron wired (Phase 7)        |
| `trg_documents_set_updated_at`    | Yes           | Trigger — runs automatically on document UPDATE  |
