# Production RAG System — Database Schemas

> Complete SQL for every table, function, and index in a production RAG system. Companion to `reference-rag-system-architecture.md` which explains what each piece is and why.

---

## Table of Contents

- [Tables](#tables)
  - Storage
    - [documents](#documents)
    - [document_chunks](#document_chunks)
    - [embedding_models](#embedding_models)
  - Caching
    - [query_cache](#query_cache)
  - History
    - [audit_log](#audit_log)
    - [document_versions](#document_versions)
  - Security
    - [agents](#agents)
    - [document_permissions](#document_permissions)
  - Ingestion
    - [ingestion_queue](#ingestion_queue)
  - Evaluation
    - [search_evaluations](#search_evaluations)
    - [eval_golden_dataset](#eval_golden_dataset)
    - [search_evaluation_aggregates](#search_evaluation_aggregates)
    - [eval_runs](#eval_runs)
- [Indexes](#indexes)
- [Functions](#functions)
  - [Document Operations](#document-operations)
  - [Search](#search)
  - [Evaluation & Maintenance](#evaluation--maintenance)
- [Triggers](#triggers)
- [Row-Level Security](#row-level-security)
- [Extensions](#extensions)
- [Realtime](#realtime)
- [Scheduled Jobs](#scheduled-jobs)

---

## Tables

### Storage

#### documents

Source of truth. One row per document, full content, all fields as real columns.

| Column               | What it's for |
|----------------------|---------------|
| Content
| `content`            | Full document text — never split across rows |
| `content_hash`       | SHA-256 hash — detect changes without comparing full text |
| `content_length`     | Auto-computed character count (GENERATED) |
| Search
| `search_vector`      | Auto-generated keyword index for BM25 search (GENERATED) |
| `embedding_model_id` | Which model was used to embed this document's chunks |
| `chunk_count`        | How many chunks this document was split into |
| `retrieval_count`    | How often this document has been found in searches |
| Source tracking
| `source_type`        | Original format: text, pdf, audio, web, etc. |
| `source_url`         | Where the original came from (URL, file path) |
| Lifecycle
| `deleted_at`         | Soft delete — NULL = active, set = in trash |
| `created_at`         | When created |
| `updated_at`         | Auto-updated on every change |
| Optional (add as needed per project)
| `name`               | Human-readable unique identifier |
| `description`        | Short summary for search result previews |
| `agent`              | Who created/modified this document |
| *your columns*       | Domain, type, project, protection, owner, tags, etc. |

```sql
CREATE TABLE documents (
  -- Core RAG columns (every RAG system needs these)
  id                    bigserial    PRIMARY KEY,
  content               text         NOT NULL,
  content_hash          text,                            -- SHA-256 for change detection
  source_type           text         NOT NULL DEFAULT 'text',  -- text, pdf, audio, etc.
  source_url            text,                            -- where the original came from
  embedding_model_id    text         REFERENCES embedding_models(id),
  content_length        int          GENERATED ALWAYS AS (length(content)) STORED,
  chunk_count           int          NOT NULL DEFAULT 1,
  retrieval_count       int          NOT NULL DEFAULT 0,
  deleted_at            timestamptz,                     -- soft delete
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),

  -- Full-text search (keyword/BM25 support)
  search_vector         tsvector     GENERATED ALWAYS AS (
                          to_tsvector('english', coalesce(content, ''))
                        ) STORED,

  -- Add other columns as required by your project's data structure.
  -- Examples: name, domain, document_type, project, protection, owner_type,
  -- owner_id, description, status, agent, file_path, tags, etc.
  -- Use CHECK constraints for columns with constrained values.

  name                  text         UNIQUE,              -- optional: human-readable identifier
  description           text,                             -- optional: short summary
  agent                 text                              -- optional: who created/modified
);
```

#### document_chunks

Search index derived from documents. Each document has 1+ chunks with embeddings. Chunks can be regenerated anytime (new strategy, new model) without touching the original document.

| Column               | What it's for |
|----------------------|---------------|
| Relationship
| `document_id`        | Parent document (CASCADE — delete doc, chunks disappear) |
| `chunk_index`        | Position within the document (0, 1, 2...) |
| Content
| `content`            | The chunk text that gets embedded |
| `content_type`       | What kind of content: text, code_block, table_extraction, transcript |
| `context_summary`    | LLM-generated context prepend — chunk context enrichment (also known as contextual retrieval) |
| `token_count`        | Token count for context window budgeting |
| Embedding
| `embedding`          | Array of numbers representing meaning (vector) |
| `embedding_model_id` | Which model generated this embedding |
| Chunking metadata
| `chunk_strategy`     | How this chunk was created: paragraph, recursive, semantic, forced |
| `overlap_chars`      | Characters shared with previous chunk for context continuity |

```sql
CREATE TABLE document_chunks (
  -- Core RAG columns (every RAG system needs these)
  id              bigserial    PRIMARY KEY,
  document_id     bigint       NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index     int          NOT NULL,                 -- position within the document
  content         text         NOT NULL,                 -- the chunk text
  embedding       vector(1536),                          -- adjust dimensions to match your model
  embedding_model_id text      REFERENCES embedding_models(id),
  chunk_strategy  text,                                  -- paragraph, recursive, semantic, forced
  overlap_chars   int          NOT NULL DEFAULT 0,       -- chars shared with previous chunk
  context_summary text,                                  -- LLM-generated context prepend (chunk context enrichment)
  token_count     int,                                   -- for context window budgeting
  content_type    text         NOT NULL DEFAULT 'text',  -- text, code_block, table_extraction, transcript
  created_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT unique_document_chunks_doc_index UNIQUE (document_id, chunk_index)

  -- Add other columns as required by your project.
  -- If you need filtered vector search (e.g. per-tenant, per-domain), add the filter
  -- column here (denormalized from parent) because HNSW indexes can't use subqueries.
);
```

#### embedding_models

Registry tracking which model produced which embeddings. Prevents mixing incompatible vectors.

| Column | What it's for |
|--------------|---------------------------------------------|
| `id`         | Model identifier, e.g. 'openai/text-embedding-3-small' |
| `provider`   | openai, cohere, local, etc. |
| `model_name` | The specific model name |
| `dimensions` | Vector dimensions (1536, 1024, etc.) |
| `is_default` | Which model to use for new embeddings |

```sql
CREATE TABLE embedding_models (
  id              text         PRIMARY KEY,
  provider        text         NOT NULL,
  model_name      text         NOT NULL,
  dimensions      int          NOT NULL,
  is_default      boolean      NOT NULL DEFAULT false,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

-- Seed default model
INSERT INTO embedding_models (id, provider, model_name, dimensions, is_default)
VALUES ('openai/text-embedding-3-small', 'openai', 'text-embedding-3-small', 1536, true);
```

### Caching

#### query_cache

Cached query embeddings to avoid repeat API calls. Same query searched 3 times = 1 API call + 2 cache hits.

| Column | What it's for |
|----------------------|------------------------------------------------|
| `query_text`         | Normalized query (lowercase + trim) for exact-match lookup |
| `embedding`          | The computed query embedding — also used for semantic cache with HNSW index |
| `embedding_model_id` | Which model generated this embedding |
| `hit_count`          | How many times this cache entry was reused |
| `last_used_at`       | For cleanup — delete entries unused for N days |

```sql
CREATE TABLE query_cache (
  id              bigserial    PRIMARY KEY,
  query_text      text         NOT NULL UNIQUE,
  embedding       vector(1536),
  embedding_model_id text      REFERENCES embedding_models(id),
  hit_count       int          NOT NULL DEFAULT 0,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  last_used_at    timestamptz  NOT NULL DEFAULT now()
);
```

### History

#### audit_log

Change tracking. Append-only, partitioned by year. No FK to documents — audit survives even if documents are hard-deleted.

| Column | What it's for |
|---|---|
| Change
| `document_id` | Which document changed (no FK — intentional, survives deletion) |
| `operation` | What happened: create, update, delete, restore |
| `agent` | Who made the change |
| `diff` | JSONB — old values before the change, for rollback |
| Partitioning
| `created_at` | Partition key (partitioned by year for scale) |

```sql
CREATE TABLE audit_log (
  id              bigserial,
  document_id     bigint,
  operation       text         NOT NULL,
  agent           text         NOT NULL,
  diff            jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)

  -- Add filter columns as needed (e.g. domain, tenant_id)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_log_2026 PARTITION OF audit_log
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE audit_log_2027 PARTITION OF audit_log
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
```

#### document_versions

Full content snapshots before each update. Unlike audit_log (which stores diffs), this stores complete content at each point in time.

| Column | What it's for |
|------------------|---------------------------------------------|
| `document_id`    | Which document this version belongs to |
| `version_number` | Incrementing counter (1, 2, 3...) |
| `content`        | Complete content at this version |
| `content_hash`   | SHA-256 of this version's content |
| `agent`          | Who triggered the update that created this snapshot |

```sql
CREATE TABLE document_versions (
  id              bigserial    PRIMARY KEY,
  document_id     bigint       NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_number  int          NOT NULL,
  content         text         NOT NULL,
  content_hash    text,
  agent           text,
  created_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT unique_document_versions_doc_version UNIQUE (document_id, version_number)
);
```

### Security

#### agents

Registry of who can access the system. Foundation for per-agent auth, rate limiting, and RBAC.

| Column           | What it's for |
|------------------|---------------|
| Identity
| `id`             | Agent identifier (e.g. 'claude-code', 'admin', 'sage') |
| `display_name`   | Human-readable name |
| Auth
| `api_key_hash`   | Hashed API key for authentication (UNIQUE) |
| `is_active`      | Disable an agent without deleting it |
| Permissions
| `permissions`    | JSONB — what this agent can do: read types, write types, delete access |
| Activity
| `last_seen_at`   | When this agent last made a request |

```sql
CREATE TABLE agents (
  id              text         PRIMARY KEY,
  display_name    text         NOT NULL,
  permissions     jsonb        NOT NULL DEFAULT '{}',
  api_key_hash    text         UNIQUE,
  is_active       boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  last_seen_at    timestamptz
);
```

#### document_permissions

Per-document access control. Different users/agents see different documents.

| Column | What it's for |
|------------------|---------------------------------------------|
| `document_id`    | Which document this permission applies to |
| `principal_type` | Who: user, group, role, tenant |
| `principal_id`   | Specific identifier of who is granted access |
| `permission`     | What level: read, write, admin |

```sql
CREATE TABLE document_permissions (
  id              bigserial    PRIMARY KEY,
  document_id     bigint       NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  principal_type  text         NOT NULL,
  principal_id    text         NOT NULL,
  permission      text         NOT NULL DEFAULT 'read',

  CONSTRAINT unique_doc_permissions UNIQUE (document_id, principal_type, principal_id)
);
```

### Ingestion

#### ingestion_queue

Async file processing pipeline. Decouples "upload" from "process" so large files don't block.

| Column | What it's for |
|------------------------|------------------------------------------------|
| `source_type`          | What kind of file: pdf, audio, image, etc. |
| `source_url`           | Where the file is stored |
| `target_category`      | Where the resulting document goes (domain, type, category — project-specific) |
| `target_document_type` | What document type to assign the result |
| `target_name`          | Desired document name (optional — auto-generate if null) |
| `status`               | Pipeline state: pending → processing → completed/failed |
| `error_message`        | If failed, why |
| `document_id`          | Set after processing creates the document (links result to queue entry) |

```sql
CREATE TABLE ingestion_queue (
  id              bigserial    PRIMARY KEY,
  source_type     text         NOT NULL,
  source_url      text         NOT NULL,
  target_category text,                            -- where the result goes (domain, type, etc.)
  target_document_type text,                       -- what type to assign the result
  target_name     text,
  status          text         NOT NULL DEFAULT 'pending',
  error_message   text,
  document_id     bigint       REFERENCES documents(id),
  agent           text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,

  CONSTRAINT check_ingestion_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);
```

### Evaluation

#### search_evaluations

Raw search logs. Every search recorded silently — the raw data for all quality analysis.

| Column | What it's for |
|--------------------|------------------------------------------|
| Query
| `query_text`       | What was searched |
| `search_mode`      | Which search type: vector, keyword, hybrid |
| `agent`            | Which agent performed the search |
| Results
| `result_count`     | How many results returned |
| `results`          | JSONB array of {doc_id, score, document_type} — what came back |
| `document_types`   | Which doc types appeared — for per-type quality analysis |
| `source_types`     | Which source types appeared — for per-format analysis |
| Quality
| `feedback`         | Explicit quality signal: relevant, irrelevant, partial, null |
| Performance
| `response_time_ms` | End-to-end search latency |

```sql
CREATE TABLE search_evaluations (
  id              bigserial    PRIMARY KEY,
  query_text      text         NOT NULL,
  search_mode     text         NOT NULL,
  result_count    int          NOT NULL DEFAULT 0,
  results         jsonb,
  agent           text,
  feedback        text,
  response_time_ms int,
  document_types  text[],
  source_types    text[],
  created_at      timestamptz  NOT NULL DEFAULT now()
);
```

#### eval_golden_dataset

Known-correct test cases. "If someone searches X, they should find document Y." The foundation of measurable evaluation.

| Column             | What it's for |
|--------------------|---------------|
| `query`            | The test query: "What is the database schema?" |
| `expected_doc_ids` | Which documents should appear in results |
| `expected_answer`  | Optional: reference answer for generation quality testing |
| `tags`             | Categorize difficulty: simple, conceptual, exact-term, multi-doc, out-of-scope |

```sql
CREATE TABLE eval_golden_dataset (
  id              bigserial    PRIMARY KEY,
  query           text         NOT NULL,
  expected_doc_ids int[]       NOT NULL,
  expected_answer text,
  tags            text[]       DEFAULT '{}',
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);
```

#### search_evaluation_aggregates

Daily summaries. Raw search logs (50+ rows/day) crunched into one row per day. Keeps trends without unbounded growth.

| Column                 | What it's for |
|------------------------|---------------|
| Time
| `date`                 | Which day this summary covers (UNIQUE) |
| Volume
| `search_count`         | Total searches that day |
| `avg_result_count`     | Average results per search |
| Quality
| `zero_result_count`    | How many searches found nothing |
| `zero_result_rate`     | zero_result_count / search_count |
| `avg_score`            | Average top-result score |
| Performance
| `avg_response_time_ms` | Average latency |
| Breakdowns (JSONB)
| `searches_by_mode`     | {hybrid: 45, vector: 3, keyword: 2} |
| `top_document_types`   | Which types appeared most in results |
| `feedback_counts`      | {relevant: 5, irrelevant: 1, none: 44} |

```sql
CREATE TABLE search_evaluation_aggregates (
  id              bigserial    PRIMARY KEY,
  date            date         NOT NULL UNIQUE,
  search_count    int          NOT NULL DEFAULT 0,
  avg_result_count float       NOT NULL DEFAULT 0,
  avg_response_time_ms float   NOT NULL DEFAULT 0,
  zero_result_count int        NOT NULL DEFAULT 0,
  zero_result_rate float       NOT NULL DEFAULT 0,
  avg_score       float,
  searches_by_mode jsonb       NOT NULL DEFAULT '{}',
  top_document_types jsonb     NOT NULL DEFAULT '{}',
  feedback_counts jsonb        NOT NULL DEFAULT '{}',
  created_at      timestamptz  NOT NULL DEFAULT now()
);
```

#### eval_runs

Stored results from each golden dataset evaluation run. Tracks improvement over time — every change measured against previous runs.

| Column                   | What it's for |
|--------------------------|---------------|
| Run info
| `run_date`               | When this eval was executed |
| `config`                 | JSONB snapshot of settings: threshold, chunking, model, RRF k. Reproduce any run. |
| `test_case_count`        | How many test cases were run |
| Metrics
| `hit_rate`               | % of queries that found at least one expected doc |
| `first_result_accuracy`  | % of queries where #1 result was correct |
| `recall`                 | % of expected docs that were actually found |
| `zero_result_rate`       | % of queries that returned nothing |
| `avg_response_time_ms`   | Average search latency |
| Detail (for drill-down)
| `results_by_tag`         | JSONB per-tag breakdown |
| `missed_queries`         | JSONB: which queries failed and what they got instead |
| `per_query_results`      | JSONB: full detail for every test case |

```sql
CREATE TABLE eval_runs (
  id              bigserial    PRIMARY KEY,
  run_date        timestamptz  NOT NULL DEFAULT now(),
  config          jsonb        NOT NULL,
  test_case_count int          NOT NULL,
  hit_rate        float        NOT NULL,
  first_result_accuracy float  NOT NULL,
  recall          float        NOT NULL,
  zero_result_rate float       NOT NULL,
  avg_response_time_ms float   NOT NULL,
  results_by_tag  jsonb,
  missed_queries  jsonb,
  per_query_results jsonb
);
```

---

## Indexes

### documents

```sql
-- Active document lookups (skip soft-deleted)
CREATE INDEX index_documents_active ON documents (id) WHERE deleted_at IS NULL;

-- Listing active documents by recency
CREATE INDEX index_documents_created_at ON documents (created_at DESC) WHERE deleted_at IS NULL;

-- Keyword search
CREATE INDEX gin_documents_search_vector ON documents USING GIN (search_vector);

-- Add indexes on any columns you filter by frequently.
-- Examples: domain, document_type, project, owner, tenant_id, etc.
-- Use partial indexes (WHERE column IS NOT NULL) for sparse columns.
```

### document_chunks

```sql
-- Global vector search
CREATE INDEX hnsw_document_chunks_embedding ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Per-partition vector indexes (one per filter value you search by)
-- Adjust the WHERE clause and index name to match your project's partition column.
-- Example: if you filter by tenant_id, domain, category, etc.
-- CREATE INDEX hnsw_chunks_<partition_value> ON document_chunks
--   USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
--   WHERE <partition_column> = '<value>';

-- Chunk reassembly
CREATE INDEX index_document_chunks_document_id ON document_chunks (document_id, chunk_index);

-- Embedding model tracking
CREATE INDEX index_document_chunks_model ON document_chunks (embedding_model_id);
```

### query_cache

```sql
-- Semantic cache lookup
CREATE INDEX hnsw_query_cache_embedding ON query_cache
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Cleanup stale entries
CREATE INDEX index_query_cache_last_used ON query_cache (last_used_at);
```

### audit_log

```sql
-- Lookup by document
CREATE INDEX index_audit_log_document_id ON audit_log (document_id, created_at DESC);

-- Rate limiting / per-agent analytics
CREATE INDEX index_audit_log_agent ON audit_log (agent, created_at DESC);
```

### document_versions

```sql
-- Version history per document
CREATE INDEX index_document_versions_document ON document_versions (document_id, created_at DESC);
```

### search_evaluations

```sql
-- Analytics over time (DESC for "most recent first" queries)
CREATE INDEX index_search_evaluations_created ON search_evaluations (created_at DESC);

-- Identify zero-result queries
CREATE INDEX index_search_evaluations_no_results ON search_evaluations (created_at DESC)
  WHERE result_count = 0;

-- Find searches by feedback type
CREATE INDEX index_search_evaluations_feedback ON search_evaluations (feedback)
  WHERE feedback IS NOT NULL;
```

### eval_golden_dataset

```sql
-- Filter test cases by tag
CREATE INDEX index_eval_golden_tags ON eval_golden_dataset USING gin(tags);
```

### search_evaluation_aggregates

```sql
-- Time-range queries on daily trends
CREATE INDEX index_search_evaluation_aggregates_date ON search_evaluation_aggregates (date DESC);
```

---

## Functions

### Document Operations

#### document_create

Insert document + chunks + audit in one atomic transaction. Returns the new document ID.

```sql
-- Parameters:
--   p_content text, p_content_hash text, p_source_type text, p_agent text,
--   p_embedding_model_id text,
--   p_chunk_contents text[], p_chunk_embeddings text[], p_chunk_strategy text,
--   + any project-specific columns (name, domain, description, etc.)
-- Returns: bigint (new document ID)
-- Does: INSERT document → INSERT chunks → INSERT audit (all in one transaction)
```

#### document_update

Update content + replace all chunks + save version snapshot + audit.

```sql
-- Parameters:
--   p_id bigint, p_content text, p_content_hash text, p_agent text,
--   p_embedding_model_id text,
--   p_chunk_contents text[], p_chunk_embeddings text[], p_chunk_strategy text,
--   + any project-specific columns to update
-- Returns: void
-- Does: Save old content to document_versions → UPDATE document → DELETE old chunks → INSERT new chunks → INSERT audit
```

#### document_update_fields

Update metadata columns without changing content. No re-embedding needed.

```sql
-- Parameters:
--   p_id bigint, p_agent text,
--   + any columns to update (only non-NULL params are applied)
-- Returns: void
-- Does: UPDATE document columns → if partition column changed, UPDATE chunks too → INSERT audit
-- Note: no re-embedding needed since content didn't change
```

#### document_delete

Soft-delete a document.

```sql
-- Parameters: p_id bigint, p_agent text
-- Returns: void
-- Does: Save content to audit diff → SET deleted_at = now() → DELETE chunks → INSERT audit
```

#### document_restore

Undo a soft-delete.

```sql
-- Parameters: p_id bigint, p_agent text
-- Returns: void
-- Does: SET deleted_at = NULL → INSERT audit
-- Note: chunks must be regenerated separately (call document_update with same content)
```

#### document_purge

Hard-delete documents past grace period.

```sql
CREATE OR REPLACE FUNCTION document_purge(
  p_older_than interval DEFAULT '30 days'
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM documents
  WHERE deleted_at IS NOT NULL
    AND deleted_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

### Search

#### match_documents

Vector search — find chunks by embedding similarity, return documents.

```sql
-- Parameters:
--   q_emb vector(1536),            -- query embedding (adjust dimensions to your model)
--   p_threshold float DEFAULT 0.5, -- minimum cosine similarity
--   p_max_results int DEFAULT 10,  -- top-K results
--   + any filter parameters for your project (domain, tenant_id, category, etc.)
-- Returns: TABLE with document columns + similarity float
```

**DISTINCT ON pitfall:** When deduplicating chunks to one-per-document, PostgreSQL's
`DISTINCT ON (doc_id)` forces `ORDER BY doc_id` as the leading sort column. If you apply
`LIMIT` in the same query, results are clipped by document ID order, not similarity.
Fix: wrap `DISTINCT ON` in a subquery, then sort by similarity and limit in the outer query.

#### match_documents_keyword

Keyword search — find documents by full-text matching.

```sql
-- Parameters:
--   p_query text,                   -- search terms
--   p_max_results int DEFAULT 10,
--   + any filter parameters
-- Returns: Same columns as match_documents, with rank instead of similarity
```

#### match_documents_hybrid

Combined vector + keyword search with RRF rank fusion.

```sql
-- Parameters:
--   q_emb vector(1536),            -- query embedding
--   q_text text,                   -- query text (for keyword component)
--   p_threshold float DEFAULT 0.5, -- cosine similarity threshold (vector component only)
--   p_max_results int DEFAULT 10,
--   p_rrf_k int DEFAULT 60,        -- RRF smoothing constant
--   + any filter parameters
-- Returns: Same columns, with score (RRF fused score)
-- Note: Threshold applies to vector cosine similarity pre-fusion, not to fused score
```

#### retrieve_context

Smart retrieval — full document for small docs, chunk + neighbors for large docs.

```sql
-- Parameters:
--   p_document_id bigint, p_matched_chunk_index int,
--   p_context_window int DEFAULT 4000, p_neighbor_count int DEFAULT 1
-- Returns: TABLE (document_id, document_name, retrieval_mode text, content, matched_section)
```

### Evaluation & Maintenance

#### aggregate_search_evaluations

Compute daily summary from raw search_evaluations rows.

```sql
CREATE OR REPLACE FUNCTION aggregate_search_evaluations(
  p_date date DEFAULT (current_date - interval '1 day')::date
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
  -- Main aggregates
  SELECT
    count(*)::int,
    coalesce(avg(result_count), 0),
    coalesce(avg(response_time_ms), 0),
    count(*) FILTER (WHERE result_count = 0)::int,
    CASE WHEN count(*) > 0
      THEN count(*) FILTER (WHERE result_count = 0)::float / count(*)
      ELSE 0
    END,
    avg((results->0->>'score')::float)
  INTO
    v_search_count, v_avg_result_count, v_avg_response_time_ms,
    v_zero_result_count, v_zero_result_rate, v_avg_score
  FROM search_evaluations
  WHERE created_at::date = p_date;

  IF v_search_count = 0 THEN RETURN; END IF;

  -- Searches by mode (separate query)
  SELECT coalesce(jsonb_object_agg(search_mode, mode_count), '{}')
  INTO v_searches_by_mode
  FROM (
    SELECT search_mode, count(*) AS mode_count
    FROM search_evaluations
    WHERE created_at::date = p_date
    GROUP BY search_mode
  ) modes;

  -- Document types (separate query)
  SELECT coalesce(jsonb_object_agg(doc_type, type_count), '{}')
  INTO v_top_document_types
  FROM (
    SELECT unnest(document_types) AS doc_type, count(*) AS type_count
    FROM search_evaluations
    WHERE created_at::date = p_date
    GROUP BY doc_type
  ) dtypes;

  -- Feedback counts (separate query)
  SELECT jsonb_build_object(
    'relevant', count(*) FILTER (WHERE feedback = 'relevant'),
    'irrelevant', count(*) FILTER (WHERE feedback = 'irrelevant'),
    'partial', count(*) FILTER (WHERE feedback = 'partial'),
    'none', count(*) FILTER (WHERE feedback IS NULL)
  )
  INTO v_feedback_counts
  FROM search_evaluations
  WHERE created_at::date = p_date;

  -- Upsert daily aggregate
  INSERT INTO search_evaluation_aggregates (
    date, search_count, avg_result_count, avg_response_time_ms,
    zero_result_count, zero_result_rate, avg_score,
    searches_by_mode, top_document_types, feedback_counts
  ) VALUES (
    p_date, v_search_count, v_avg_result_count,
    v_avg_response_time_ms, v_zero_result_count,
    v_zero_result_rate, v_avg_score,
    v_searches_by_mode, v_top_document_types,
    v_feedback_counts
  )
  ON CONFLICT (date) DO UPDATE SET
    search_count = EXCLUDED.search_count,
    avg_result_count = EXCLUDED.avg_result_count,
    avg_response_time_ms = EXCLUDED.avg_response_time_ms,
    zero_result_count = EXCLUDED.zero_result_count,
    zero_result_rate = EXCLUDED.zero_result_rate,
    avg_score = EXCLUDED.avg_score,
    searches_by_mode = EXCLUDED.searches_by_mode,
    top_document_types = EXCLUDED.top_document_types,
    feedback_counts = EXCLUDED.feedback_counts;
END;
$$;
```

#### cleanup_search_evaluations

Delete raw search evaluation rows older than N days. Run AFTER aggregation.

```sql
CREATE OR REPLACE FUNCTION cleanup_search_evaluations(
  p_older_than interval DEFAULT '30 days'
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM search_evaluations WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

#### cleanup_query_cache

Remove stale cached query embeddings.

```sql
CREATE OR REPLACE FUNCTION cleanup_query_cache(
  p_older_than interval DEFAULT '7 days'
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM query_cache WHERE last_used_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

#### cleanup_document_versions

Keep only last N versions per document.

```sql
CREATE OR REPLACE FUNCTION cleanup_document_versions(
  p_keep_count int DEFAULT 10
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM document_versions
  WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY version_number DESC) AS row_num
      FROM document_versions
    ) ranked
    WHERE row_num > p_keep_count
  );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

#### create_audit_partition_if_needed

Auto-create next year's audit_log partition.

```sql
CREATE OR REPLACE FUNCTION create_audit_partition_if_needed()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_next_year int := EXTRACT(YEAR FROM now())::int + 1;
  v_partition_name text := 'audit_log_' || v_next_year;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = v_partition_name) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      v_partition_name,
      v_next_year || '-01-01',
      (v_next_year + 1) || '-01-01'
    );
  END IF;
END;
$$;
```

---

## Triggers

### Auto-update updated_at on documents

```sql
CREATE OR REPLACE FUNCTION trg_documents_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION trg_documents_set_updated_at();
```

---

## Row-Level Security

Enable RLS on every table. Apply to all tables in your schema:

```sql
-- Enable RLS
ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;

-- Service role (your backend/MCP server): full access
CREATE POLICY "Service role full access" ON <table_name>
  FOR ALL TO service_role USING (true);

-- Anon (unauthenticated): no access
CREATE POLICY "Anon no access" ON <table_name>
  FOR ALL TO anon USING (false);
```

Apply this pattern to every table: documents, document_chunks, audit_log, document_versions, query_cache, embedding_models, search_evaluations, eval_golden_dataset, search_evaluation_aggregates, eval_runs, ingestion_queue, and any project-specific tables.

For multi-tenant systems, add per-user policies:

```sql
-- Users can only read documents they have permission for
CREATE POLICY "Users read permitted docs" ON documents
  FOR SELECT USING (
    id IN (
      SELECT document_id FROM document_permissions
      WHERE principal_id = auth.uid()::text
    )
  );
```

---

## Extensions

Required Postgres extensions for a RAG system:

| Extension    | Purpose                                         | Required? |
|--------------|--------------------------------------------------|-----------|
| `vector`     | pgvector — vector storage, HNSW indexes, cosine distance | Yes |
| `pgcrypto`   | SHA-256 hashing (`digest()`) for content_hash, version snapshots | Yes |
| `pgtap`      | Database unit testing framework (pgTAP)          | Recommended |

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgtap;  -- for database tests
```

Additional extensions may be auto-enabled by your hosting platform (e.g. Supabase enables `pg_graphql`, `pg_stat_statements`, `uuid-ossp`, `supabase_vault`).

---

## Realtime

If your database supports realtime subscriptions (e.g. Supabase Realtime), enable it on the `documents` table so clients can react to changes without polling:

```sql
-- Supabase: add documents to the realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE documents;
```

Only enable on tables that need live updates. Chunks, audit, and eval tables don't need realtime — they're derived or append-only.

---

## Scheduled Jobs

Maintenance functions need to run on a schedule. If your platform supports `pg_cron`:

```sql
-- Enable the extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Daily: aggregate raw search logs into daily summaries
SELECT cron.schedule('aggregate-search-evals', '0 2 * * *',
  $$SELECT aggregate_search_evaluations()$$);

-- Daily: clean raw search logs older than 30 days (run AFTER aggregation)
SELECT cron.schedule('cleanup-search-evals', '0 3 * * *',
  $$SELECT cleanup_search_evaluations()$$);

-- Daily: hard-delete soft-deleted documents past 30-day grace period
SELECT cron.schedule('purge-deleted-docs', '0 4 * * *',
  $$SELECT document_purge()$$);

-- Weekly: remove stale cached query embeddings
SELECT cron.schedule('cleanup-query-cache', '0 5 * * 0',
  $$SELECT cleanup_query_cache()$$);

-- Weekly: keep only last 10 versions per document
SELECT cron.schedule('cleanup-doc-versions', '0 5 * * 0',
  $$SELECT cleanup_document_versions()$$);

-- Yearly: create next year's audit_log partition
SELECT cron.schedule('create-audit-partition', '0 0 1 12 *',
  $$SELECT create_audit_partition_if_needed()$$);
```

If `pg_cron` is not available, run these via external cron (e.g. `crontab`, GitHub Actions, or a scheduled script calling each function via your database client).
