# Ledger v2 — Schema Rewrite

> Date: 2026-03-29 | Status: Design | Project: Ledger

## Problem

Ledger v1's `documents` table stores almost everything in a JSONB `metadata` column. Fields that are queried constantly (domain, type, project, protection) live in JSONB where Postgres can't track statistics, enforce constraints, or build proper indexes. Chunked notes are hacked into the same table as multiple rows pretending to be one note.

## Solution

Rewrite the schema from scratch:
1. Promote all fields to real columns — no JSONB metadata
2. Separate documents from chunks (document-chunk pattern)
3. Replace `upsert_key` with `name` column (proper unique identifier, NOT NULL)
4. Add `search_vector` for hybrid search (Phase 2 foundation)
5. Add `agents` table (Phase 4 foundation)
6. Partition `audit_log` by time (Phase 5 foundation)
7. Add soft delete via `deleted_at` (Phase 5 foundation)
8. Enable Realtime publication + replica identity (Phase 3 foundation)

---

## Access Patterns

The 10 most common queries. Schema must serve these well.

| # | Query                 | Frequency                         | Tables              | Filters                                        | Sort |
|---|-------                |-----------                        |--------             |---------                                       |------|
| 1 | Semantic search       | Every search_notes call           | document_chunks → documents | domain, document_type, project + vector similarity | similarity DESC |
| 2 | Keyword search        | Every search_notes call (hybrid)  | documents               | search_vector @@ query                         | ts_rank DESC |
| 3 | List recent documents     | Every list_notes call             | documents               | domain, document_type, project, deleted_at IS NULL | created_at DESC |
| 4 | Find by name          | Every upsert (add_note with name) | documents               | name = exact                                   | — |
| 5 | Find by ID            | Every update/delete               | documents               | id = exact                                     | — |
| 6 | Fetch syncable documents  | Sync/pull and session start       | documents               | is_auto_load = true                            | — |
| 8 | Duplicate check       | Every add_note without name       | document_chunks         | vector similarity > 0.6                        | similarity DESC |
| 9 | Read full document        | After search finds a match        | documents               | id = exact                                     | — |
| 10 | List by agent        | Observability/rate limiting       | audit_log           | agent, created_at range                        | created_at DESC |

---

## Overview

### 9 Tables

| Table                  | Purpose                                                                              | Rows at scale              |
|------------------------|--------------------------------------------------------------------------------------|----------------------------|
| `documents`            | Source of truth — one row per document, all fields as real columns, full content      | Thousands                  |
| `document_chunks`      | Search index — small text pieces with embeddings for vector/keyword search            | Thousands (1-10x documents)|
| `audit_log`            | Change tracking — partitioned by year, records every create/update/delete for rollback| Tens of thousands          |
| `agents`               | Agent registry — who can access Ledger, with what permissions, API key hashes         | Tens                       |
| `embedding_models`     | Model registry — which AI models produce embeddings, their dimensions, default model  | Single digits              |
| `query_cache`          | Embedding cache — stores computed query embeddings to avoid re-calling OpenAI         | Hundreds                   |
| `document_versions`    | Full snapshots — complete content at each version for history and rollback             | Thousands                  |
| `search_evaluations`   | Search quality metrics — what was searched, what came back, was it useful              | Thousands                  |
| `ingestion_queue`      | File processing pipeline — pending PDFs, audio, images waiting to be extracted        | Transient                  |

**Why these tables exist:**

- **`documents` + `document_chunks`** — separation of content from search. Your data (documents) is always complete in one row. The search index (chunks) is derived — can be rebuilt anytime. This is the industry-standard RAG pattern used by LangChain, LlamaIndex, and Pinecone.
- **`audit_log`** — every change is recorded with the old values. If an agent overwrites your CLAUDE.md, the audit log has the previous version. Partitioned by year so it doesn't slow down as it grows.
- **`agents`** — registers who interacts with Ledger. Enables per-agent rules like "Dom can write preference notes but can't delete architecture notes" or "Sage is read-only." Not enforced yet (Phase 6), but the registry is ready.
- **`embedding_models`** — tracks which AI model generated which embeddings. Critical because mixing embeddings from different models gives garbage search results — the numbers mean different things. When you switch models, this table tells you which chunks need re-embedding.
- **`query_cache`** — when you search "how does auth work" three times, the embedding is computed once and reused. Saves API calls and money.
- **`document_versions`** — full content snapshots (not just diffs). The audit_log stores what changed; document_versions stores what it looked like at each point. Like git commits for your documents.
- **`search_evaluations`** — logs each search: what was queried, what came back, was it useful. Without this you're guessing if search works well. Enables measuring retrieval precision and finding searches that return nothing.
- **`ingestion_queue`** — when you upload a PDF or audio file, it goes in the queue. A processor extracts text, creates the document, generates chunks. Decouples "upload" from "process" so large files don't block.

### Conventions

- **Content hashing:** SHA-256 everywhere via pgcrypto — `encode(digest(content, 'sha256'), 'hex')`. Used for `documents.content_hash` and `document_versions.content_hash`. Same algorithm as Git and AWS.
- **Denormalized domain on chunks:** `document_chunks.domain` is copied from the parent document. Required because HNSW vector indexes can't use subqueries in WHERE clauses. Standard pattern used by Pinecone, Weaviate, Qdrant.
- **Soft delete:** `deleted_at` column on documents. All queries filter `WHERE deleted_at IS NULL`. Hard delete via `document_purge` after 30-day grace period.
- **Version snapshots:** `document_update` automatically saves the old content to `document_versions` before overwriting. Kept to last 10 via `cleanup_document_versions`.
- **Flat search returns:** Search functions (`match_documents`, `match_documents_keyword`, `match_documents_hybrid`) return flat columns — no JSONB `metadata` wrapper. The `documents` table has real columns; search functions return them directly. TypeScript reads `result.domain`, not `result.metadata.domain`. Only `audit_log.diff` uses JSONB (audit diffs are genuinely variable-shape data).

### 14 Postgres Functions

(Updated from 13 — added `cleanup_document_versions`)

| Function                            | What it does                                                              | Why it exists                                                    |
|-------------------------------------|---------------------------------------------------------------------------|------------------------------------------------------------------|
| `document_create`                   | Insert document + chunks + audit in one transaction                       | All-or-nothing: if audit fails, the document doesn't get created |
| `document_update`                   | Update content + replace chunks + audit in one transaction                | No orphaned chunks or missing audit trails                       |
| `document_update_fields`            | Update document columns (typed params) + sync chunks domain + audit       | Type-safe field updates without content/chunk changes             |
| `document_delete`                   | Soft delete + remove chunks + audit in one transaction                    | Content saved in audit for rollback before marking deleted        |
| `document_purge`                    | Hard delete documents older than grace period (default 30 days)           | Cleanup after soft delete grace period expires                   |
| `document_restore`                  | Undo a soft delete                                                        | "I didn't mean to delete that" — restores the document           |
| `match_documents`                   | Vector search — find chunks by embedding similarity, return documents     | Semantic search: "how does auth work" finds OAuth notes          |
| `match_documents_keyword`           | Keyword search — find documents by exact text matching                    | Exact search: "pgvector HNSW" finds those exact words            |
| `match_documents_hybrid`            | Combined vector + keyword search with RRF rank fusion                     | Best of both: meaning matches + word matches, combined           |
| `retrieve_context`                  | Smart retrieval — full document for small, chunk + neighbors for large    | Don't waste tokens sending 50K chars when 2K is enough           |
| `create_audit_partition_if_needed`  | Auto-create next year's audit_log partition                               | Prevents "no partition for 2028" errors                          |
| `cleanup_query_cache`               | Remove cached queries not used in 7 days                                  | Keeps cache from growing forever                                 |
| `cleanup_document_versions`         | Keep only last N versions per document (default 10)                       | Prevents version history from growing forever                    |
| `trg_documents_set_updated_at`      | Trigger: auto-update `updated_at` on every document change                | You never manually set updated_at — Postgres handles it          |

---

## Schema

### documents table — source of truth

Every document is exactly one row. Content is always complete (never split across rows).

```sql
CREATE TABLE documents (
  -- Identity
  id                    bigserial    PRIMARY KEY,
  name                  text         NOT NULL UNIQUE,

  -- Classification
  domain                text         NOT NULL,
  document_type             text         NOT NULL,
  project               text,
  protection            text         NOT NULL DEFAULT 'open',

  -- Ownership
  owner_type            text         NOT NULL DEFAULT 'user',
  owner_id              text,

  -- Behavior
  is_auto_load          boolean      NOT NULL DEFAULT false,

  -- Content
  content               text         NOT NULL,
  description           text,
  content_hash          text,

  -- Full-text search (Phase 2 foundation)
  search_vector         tsvector     GENERATED ALWAYS AS (
                          to_tsvector('english',
                            coalesce(name, '') || ' ' ||
                            coalesce(description, '') || ' ' ||
                            coalesce(content, '')
                          )
                        ) STORED,

  -- File delivery
  file_path             text,
  file_permissions      text,

  -- Source tracking (multi-format ingestion)
  source_type           text         NOT NULL DEFAULT 'text',   -- text, pdf, docx, spreadsheet, code, image, audio, video, web, email, slides, handwriting
  source_url            text,                                    -- original file: Supabase Storage URL, file path, or web URL

  -- Provenance
  agent                 text,
  status                text,
  skill_ref             text,

  -- Embedding tracking
  embedding_model_id    text         REFERENCES embedding_models(id),
  schema_version        int          NOT NULL DEFAULT 1,

  -- Content metrics (used for retrieval strategy and analytics)
  content_length        int          GENERATED ALWAYS AS (length(content)) STORED,
  chunk_count           int          NOT NULL DEFAULT 1,
  retrieval_count       int          NOT NULL DEFAULT 0,

  -- Soft delete (Phase 5 foundation)
  deleted_at            timestamptz,

  -- Timestamps
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT check_documents_domain CHECK (domain IN ('system', 'persona', 'workspace', 'project', 'general')),
  CONSTRAINT check_documents_protection CHECK (protection IN ('open', 'guarded', 'protected', 'immutable')),
  CONSTRAINT check_documents_owner_type CHECK (owner_type IN ('system', 'user', 'team')),
  CONSTRAINT check_documents_status CHECK (status IS NULL OR status IN ('idea', 'planning', 'active', 'done')),
  CONSTRAINT check_documents_source_type CHECK (source_type IN ('text', 'pdf', 'docx', 'spreadsheet', 'code', 'image', 'audio', 'video', 'web', 'email', 'slides', 'handwriting'))
);
```

### embedding_models table — model registry

Tracks which embedding models are available and their properties. Notes and chunks reference this instead of storing model strings on every row.

```sql
CREATE TABLE embedding_models (
  id              text         PRIMARY KEY,          -- e.g. 'openai/text-embedding-3-small'
  provider        text         NOT NULL,             -- 'openai', 'cohere', 'local'
  model_name      text         NOT NULL,             -- 'text-embedding-3-small'
  dimensions      int          NOT NULL,             -- 1536
  is_default      boolean      NOT NULL DEFAULT false,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

-- Seed the current model
INSERT INTO embedding_models (id, provider, model_name, dimensions, is_default)
VALUES ('openai/text-embedding-3-small', 'openai', 'text-embedding-3-small', 1536, true);
```

### document_chunks table — search index

Chunks exist for embedding-based search. Every document has at least one chunk. Chunks are derived from the document's content — they can be regenerated at any time.

**Denormalized `domain` column:** The `domain` field is copied from the parent document onto each chunk. This is intentional denormalization — HNSW vector indexes cannot use subqueries in their WHERE clause (`WHERE document_id IN (SELECT ...)` fails). To create per-domain vector indexes, the filter column must be on the same table as the embedding. This is the standard pattern used by Pinecone, Weaviate, and Qdrant — filter metadata lives alongside the vector. When a document's domain changes, the `document_update_metadata` function updates chunks too.

```sql
CREATE TABLE document_chunks (
  id              bigserial    PRIMARY KEY,
  document_id         bigint       NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index     int          NOT NULL,
  content         text         NOT NULL,
  domain          text         NOT NULL,                           -- denormalized from parent document for per-domain vector indexes
  embedding       vector(1536),
  content_type    text         NOT NULL DEFAULT 'text',            -- 'text', 'image_description', 'table_extraction', 'code_block', 'transcript', 'slide_text'
  embedding_model_id text      REFERENCES embedding_models(id),   -- which model generated this embedding
  chunk_strategy  text,                                            -- 'header', 'paragraph', 'sentence', 'semantic', 'forced'
  overlap_chars   int          NOT NULL DEFAULT 0,                 -- chars shared with previous chunk for context continuity
  created_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT unique_document_chunks_doc_index UNIQUE (document_id, chunk_index)
);
```

### query_cache table — embedding cache

Caches query embeddings to avoid re-computing the same query twice. When a user searches "how does sync work" multiple times, the embedding is computed once and reused.

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

### audit_log table — change tracking (partitioned by year)

Append-only, no FK to documents (survives deletion). Partitioned from day one per Sage's recommendation — audit tables grow fast.

```sql
CREATE TABLE audit_log (
  id              bigserial,
  document_id         bigint,
  domain          text,
  operation       text         NOT NULL,
  agent           text         NOT NULL,
  diff            jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create partitions for current and next year
CREATE TABLE audit_log_2026 PARTITION OF audit_log
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE audit_log_2027 PARTITION OF audit_log
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
```

### agents table — agent registry (Phase 4 foundation)

Ready for per-agent authentication and permissions. Not actively used until Phase 4 but the table exists.

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

-- Seed the default admin agent
INSERT INTO agents (id, display_name, permissions)
VALUES ('admin', 'Admin', '{"can_write_types": ["*"], "can_read_types": ["*"], "can_delete": true}');

INSERT INTO agents (id, display_name, permissions)
VALUES ('claude-code', 'Claude Code', '{"can_write_types": ["*"], "can_read_types": ["*"], "can_delete": true}');
```

### document_versions table — full snapshots

Every time a document's content changes, the old version is saved here. Unlike audit_log (which stores diffs), this stores the complete content at each point in time.

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

### search_evaluations table — search quality metrics

Logs each search with what was retrieved and whether the result was useful. Enables measuring retrieval precision ("did the right documents come back?") and identifying searches that return nothing.

```sql
CREATE TABLE search_evaluations (
  id              bigserial    PRIMARY KEY,
  query_text      text         NOT NULL,
  search_mode     text         NOT NULL,          -- 'vector', 'keyword', 'hybrid'
  result_count    int          NOT NULL DEFAULT 0,
  results         jsonb,                           -- array of { document_id, similarity/rank, was_used }
  agent           text,
  feedback        text,                            -- 'relevant', 'irrelevant', 'partial', null (no feedback)
  response_time_ms int,
  created_at      timestamptz  NOT NULL DEFAULT now()
);
```

### ingestion_queue table — file processing pipeline

Tracks files waiting to be processed (PDF extraction, audio transcription, etc.). Processing happens asynchronously — file is uploaded, queued, processed, then a document is created.

```sql
CREATE TABLE ingestion_queue (
  id              bigserial    PRIMARY KEY,
  source_type     text         NOT NULL,           -- 'pdf', 'audio', 'image', etc.
  source_url      text         NOT NULL,           -- where the file is stored (Supabase Storage URL)
  target_domain   text         NOT NULL DEFAULT 'general',
  target_document_type text    NOT NULL DEFAULT 'knowledge',
  target_name     text,                            -- desired document name (null = auto-generate)
  status          text         NOT NULL DEFAULT 'pending',
  error_message   text,
  document_id     bigint       REFERENCES documents(id),  -- set after processing creates the document
  agent           text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,

  CONSTRAINT check_ingestion_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);
```

---

Also add `retrieval_count` to documents and `overlap_chars` to chunks:

---

## Indexes

### documents table

```sql
-- Classification filtering (queries 1-3, 6)
CREATE INDEX index_documents_domain ON documents (domain);
CREATE INDEX index_documents_document_type ON documents (document_type);
CREATE INDEX index_documents_project ON documents (project) WHERE project IS NOT NULL;
CREATE INDEX index_documents_domain_document_type ON documents (domain, document_type);

-- Sync (query 6) — is_auto_load drives both sync and context loading
CREATE INDEX index_documents_is_auto_load ON documents (is_auto_load) WHERE is_auto_load = true;

-- Ownership (Phase 4 — multi-user filtering)
CREATE INDEX index_documents_owner ON documents (owner_type, owner_id) WHERE owner_id IS NOT NULL;

-- Listing active documents (query 3)
CREATE INDEX index_documents_created_at ON documents (created_at DESC) WHERE deleted_at IS NULL;

-- Soft delete — find active documents quickly
CREATE INDEX index_documents_active ON documents (id) WHERE deleted_at IS NULL;

-- Full-text search (Phase 2 — keyword/hybrid search)
CREATE INDEX gin_documents_search_vector ON documents USING GIN (search_vector);

-- Skill linking
CREATE INDEX index_documents_skill_ref ON documents (skill_ref) WHERE skill_ref IS NOT NULL;
```

### document_chunks table

```sql
-- Global vector search — finds similar chunks across all documents
CREATE INDEX hnsw_document_chunks_embedding ON document_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Per-domain vector indexes (multi-index strategy)
-- Searching within one domain only scans that domain's chunks, not all chunks
-- Per-domain vector indexes (multi-index strategy)
-- Uses denormalized domain column on chunks — HNSW indexes can't use subqueries
CREATE INDEX hnsw_document_chunks_persona ON document_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE domain = 'persona';

CREATE INDEX hnsw_document_chunks_system ON document_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE domain = 'system';

CREATE INDEX hnsw_document_chunks_workspace ON document_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE domain = 'workspace';

CREATE INDEX hnsw_document_chunks_project ON document_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE domain = 'project';

CREATE INDEX hnsw_document_chunks_general ON document_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE domain = 'general';

-- Chunk reassembly by note (query 9)
CREATE INDEX index_document_chunks_document_id ON document_chunks (document_id, chunk_index);

-- Embedding model tracking
CREATE INDEX index_document_chunks_model ON document_chunks (embedding_model_id);
```

### query_cache table

```sql
-- Fast lookup by query text
-- (UNIQUE constraint on query_text already creates an index)

-- Cleanup: find stale cache entries
CREATE INDEX index_query_cache_last_used ON query_cache (last_used_at);
```

### audit_log table

```sql
-- Lookup by note
CREATE INDEX index_audit_log_document_id ON audit_log (document_id, created_at DESC);

-- Rate limiting — count operations per agent per hour (Phase 4)
CREATE INDEX index_audit_log_agent ON audit_log (agent, created_at DESC);

-- Domain filtering
CREATE INDEX index_audit_log_domain ON audit_log (domain, created_at DESC);
```


```sql
-- Find all documents in a collection

```

### document_versions table

```sql
-- Get version history for a document, newest first
CREATE INDEX index_document_versions_document ON document_versions (document_id, version_number DESC);
```

### search_evaluations table

```sql
-- Analytics: search quality over time
CREATE INDEX index_search_evaluations_created ON search_evaluations (created_at DESC);

-- Find searches with no results (quality issues)
CREATE INDEX index_search_evaluations_no_results ON search_evaluations (created_at DESC)
  WHERE result_count = 0;

-- Find searches by feedback type
CREATE INDEX index_search_evaluations_feedback ON search_evaluations (feedback)
  WHERE feedback IS NOT NULL;
```

### ingestion_queue table

```sql
-- Find pending items to process
CREATE INDEX index_ingestion_queue_status ON ingestion_queue (status, created_at)
  WHERE status IN ('pending', 'processing');
```

---

## Triggers

```sql
-- Auto-update updated_at on documents
CREATE OR REPLACE FUNCTION trg_documents_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION trg_documents_set_updated_at();
```

### Auto-partition audit_log

Automatically creates next year's partition so we never run out of space.

```sql
CREATE OR REPLACE FUNCTION create_audit_partition_if_needed()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_next_year    int := EXTRACT(YEAR FROM now())::int + 1;
  v_partition    text := 'audit_log_' || v_next_year;
  v_start        text := v_next_year || '-01-01';
  v_end          text := (v_next_year + 1) || '-01-01';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_partition
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      v_partition, v_start, v_end
    );
  END IF;
END;
$$;
```

### Cache cleanup

Removes stale query cache entries that haven't been used recently.

```sql
CREATE OR REPLACE FUNCTION cleanup_query_cache(
  p_older_than interval DEFAULT '7 days'
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM query_cache WHERE last_used_at < now() - p_older_than;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
```

### Version history cleanup

Keeps only the last N versions per document. Prevents document_versions from growing forever.

```sql
CREATE OR REPLACE FUNCTION cleanup_document_versions(
  p_keep_count int DEFAULT 10
) RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM document_versions
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
        ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY version_number DESC) AS row_num
      FROM document_versions
    ) ranked
    WHERE row_num > p_keep_count
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;
```

---

## Postgres Functions (transactional operations)

Every write operation wraps note + chunks + audit in a single transaction.

### document_create — insert document + chunks + audit

```sql
CREATE OR REPLACE FUNCTION document_create(
  p_name                text,
  p_domain              text,
  p_document_type       text,
  p_project             text,
  p_protection          text,
  p_owner_type          text,
  p_owner_id            text,
  p_is_auto_load        boolean,
  p_content             text,
  p_description         text,
  p_content_hash        text,
  p_source_type         text DEFAULT 'text',
  p_source_url          text DEFAULT NULL,
  p_file_path           text DEFAULT NULL,
  p_file_permissions    text DEFAULT NULL,
  p_agent               text DEFAULT NULL,
  p_status              text DEFAULT NULL,
  p_skill_ref           text DEFAULT NULL,
  p_embedding_model_id  text DEFAULT NULL,
  p_chunk_contents      text[] DEFAULT NULL,
  p_chunk_embeddings    vector(1536)[] DEFAULT NULL,
  p_chunk_strategy      text DEFAULT 'paragraph'
) RETURNS bigint AS $$
DECLARE
  v_doc_id bigint;
  i int;
BEGIN
  INSERT INTO documents (
    name, domain, document_type, project, protection,
    owner_type, owner_id, is_auto_load,
    content, description, content_hash,
    source_type, source_url,
    file_path, file_permissions,
    agent, status, skill_ref,
    embedding_model_id
  ) VALUES (
    p_name, p_domain, p_document_type, p_project, p_protection,
    p_owner_type, p_owner_id, p_is_auto_load,
    p_content, p_description, p_content_hash,
    p_source_type, p_source_url,
    p_file_path, p_file_permissions,
    p_agent, p_status, p_skill_ref,
    p_embedding_model_id
  ) RETURNING id INTO v_doc_id;

  IF p_chunk_contents IS NOT NULL THEN
    FOR i IN 1..array_length(p_chunk_contents, 1) LOOP
      INSERT INTO document_chunks (document_id, chunk_index, content, domain, embedding, embedding_model_id, chunk_strategy)
      VALUES (v_doc_id, i - 1, p_chunk_contents[i], p_domain, p_chunk_embeddings[i], p_embedding_model_id, p_chunk_strategy);
    END LOOP;

    UPDATE documents SET chunk_count = array_length(p_chunk_contents, 1) WHERE id = v_doc_id;
  END IF;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (v_doc_id, p_domain, 'create', COALESCE(p_agent, 'unknown'), NULL, now());

  RETURN v_doc_id;
END;
$$ LANGUAGE plpgsql;
```

### document_update — update content + version snapshot + replace chunks + audit

```sql
CREATE OR REPLACE FUNCTION document_update(
  p_id                  bigint,
  p_content             text,
  p_content_hash        text,
  p_agent               text DEFAULT NULL,
  p_description         text DEFAULT NULL,
  p_status              text DEFAULT NULL,
  p_chunk_contents      text[] DEFAULT NULL,
  p_chunk_embeddings    vector(1536)[] DEFAULT NULL,
  p_chunk_strategy      text DEFAULT 'paragraph'
) RETURNS void AS $$
DECLARE
  v_old_content  text;
  v_old_domain   text;
  v_version_num  int;
  i int;
BEGIN
  -- Read old values
  SELECT content, domain INTO v_old_content, v_old_domain
  FROM documents WHERE id = p_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document % not found', p_id;
  END IF;

  -- Save old version to document_versions (SHA-256 via pgcrypto)
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_num
  FROM document_versions WHERE document_id = p_id;

  INSERT INTO document_versions (document_id, version_number, content, content_hash, agent)
  VALUES (p_id, v_version_num, v_old_content, encode(digest(v_old_content, 'sha256'), 'hex'), COALESCE(p_agent, 'unknown'));

  -- Update the document
  UPDATE documents SET
    content = p_content,
    content_hash = p_content_hash,
    agent = COALESCE(p_agent, agent),
    description = COALESCE(p_description, description),
    status = COALESCE(p_status, status)
  WHERE id = p_id;

  -- Replace chunks
  IF p_chunk_contents IS NOT NULL THEN
    DELETE FROM document_chunks WHERE document_id = p_id;

    FOR i IN 1..array_length(p_chunk_contents, 1) LOOP
      INSERT INTO document_chunks (document_id, chunk_index, content, domain, embedding, embedding_model_id, chunk_strategy)
      VALUES (p_id, i - 1, p_chunk_contents[i], v_old_domain, p_chunk_embeddings[i], NULL, p_chunk_strategy);
    END LOOP;

    UPDATE documents SET chunk_count = array_length(p_chunk_contents, 1) WHERE id = p_id;
  END IF;

  -- Audit entry
  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_old_domain, 'update', COALESCE(p_agent, 'unknown'),
    jsonb_build_object('content', v_old_content), now());
END;
$$ LANGUAGE plpgsql;
```

**Hashing:** Uses `encode(digest(content, 'sha256'), 'hex')` via pgcrypto for all content hashing — same algorithm as `documents.content_hash`. SHA-256 is the production standard (used by Git, AWS, content-addressable storage).

### document_update_fields — update document columns (typed params) + audit

Uses individual typed parameters instead of JSONB — Postgres validates types at call time. Pass only the fields you want to change; everything else stays as-is via COALESCE. If domain changes, automatically syncs the denormalized domain on chunks.

```sql
CREATE OR REPLACE FUNCTION document_update_fields(
  p_id                bigint,
  p_agent             text DEFAULT NULL,
  p_name              text DEFAULT NULL,
  p_domain            text DEFAULT NULL,
  p_document_type     text DEFAULT NULL,
  p_project           text DEFAULT NULL,
  p_protection        text DEFAULT NULL,
  p_owner_type        text DEFAULT NULL,
  p_owner_id          text DEFAULT NULL,
  p_is_auto_load      boolean DEFAULT NULL,
  p_description       text DEFAULT NULL,
  p_source_type       text DEFAULT NULL,
  p_source_url        text DEFAULT NULL,
  p_file_path         text DEFAULT NULL,
  p_file_permissions  text DEFAULT NULL,
  p_status            text DEFAULT NULL,
  p_skill_ref         text DEFAULT NULL,
  p_embedding_model_id text DEFAULT NULL
) RETURNS void AS $$
DECLARE
  v_old         record;
  v_domain      text;
  v_agent       text;
  v_changes     jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_old FROM documents WHERE id = p_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document % not found', p_id;
  END IF;

  UPDATE documents SET
    name             = COALESCE(p_name, name),
    domain           = COALESCE(p_domain, domain),
    document_type    = COALESCE(p_document_type, document_type),
    project          = COALESCE(p_project, project),
    protection       = COALESCE(p_protection, protection),
    owner_type       = COALESCE(p_owner_type, owner_type),
    owner_id         = COALESCE(p_owner_id, owner_id),
    is_auto_load     = COALESCE(p_is_auto_load, is_auto_load),
    description      = COALESCE(p_description, description),
    source_type      = COALESCE(p_source_type, source_type),
    source_url       = COALESCE(p_source_url, source_url),
    file_path        = COALESCE(p_file_path, file_path),
    file_permissions = COALESCE(p_file_permissions, file_permissions),
    agent            = COALESCE(p_agent, agent),
    status           = COALESCE(p_status, status),
    skill_ref        = COALESCE(p_skill_ref, skill_ref),
    embedding_model_id = COALESCE(p_embedding_model_id, embedding_model_id)
  WHERE id = p_id;

  v_domain := COALESCE(p_domain, v_old.domain);
  v_agent := COALESCE(p_agent, v_old.agent, 'unknown');

  -- If domain changed, sync to chunks (denormalized column)
  IF p_domain IS NOT NULL AND p_domain IS DISTINCT FROM v_old.domain THEN
    UPDATE document_chunks SET domain = p_domain WHERE document_id = p_id;
  END IF;

  -- Build record of what changed (old values) for audit
  IF p_name IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('name', v_old.name); END IF;
  IF p_domain IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('domain', v_old.domain); END IF;
  IF p_document_type IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('document_type', v_old.document_type); END IF;
  IF p_project IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('project', v_old.project); END IF;
  IF p_protection IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('protection', v_old.protection); END IF;
  IF p_status IS NOT NULL THEN v_changes := v_changes || jsonb_build_object('status', v_old.status); END IF;

  -- Audit entry with old values of changed fields
  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_domain, 'update_fields', v_agent, v_changes, now());
END;
$$ LANGUAGE plpgsql;
```

**Why typed parameters instead of JSONB:** With all fields as real columns, there's no metadata blob to pass. Individual parameters give TypeScript type-safety and let Postgres validate at call time. `DEFAULT NULL` on every parameter means you only pass what you're changing.

### document_delete — soft delete + audit

Documents are not removed immediately. `deleted_at` is set. A cleanup job (`document_purge`) removes them after the grace period. The audit entry captures ALL fields needed to fully recreate the document if restored.

```sql
CREATE OR REPLACE FUNCTION document_delete(
  p_id     bigint,
  p_agent  text
) RETURNS void AS $$
DECLARE
  v_content  text;
  v_domain   text;
  v_fields   jsonb;
BEGIN
  SELECT content, domain,
    jsonb_build_object(
      'name', name, 'domain', domain, 'document_type', document_type,
      'project', project, 'protection', protection,
      'description', description, 'agent', agent, 'status', status,
      'file_path', file_path, 'file_permissions', file_permissions,
      'skill_ref', skill_ref,
      'owner_type', owner_type, 'owner_id', owner_id,
      'is_auto_load', is_auto_load, 'source_type', source_type,
      'source_url', source_url, 'embedding_model_id', embedding_model_id,
      'content_hash', content_hash, 'schema_version', schema_version,
      'created_at', created_at
    )
  INTO v_content, v_domain, v_fields
  FROM documents WHERE id = p_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document % not found', p_id;
  END IF;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_domain, 'delete', p_agent,
    jsonb_build_object('content', v_content, 'fields', v_fields), now());

  UPDATE documents SET deleted_at = now() WHERE id = p_id;

  DELETE FROM document_chunks WHERE document_id = p_id;
END;
$$ LANGUAGE plpgsql;
```

### document_purge — hard delete after grace period

```sql
CREATE OR REPLACE FUNCTION document_purge(
  p_older_than  interval DEFAULT '30 days'
) RETURNS int AS $$
DECLARE
  v_count int;
BEGIN
  DELETE FROM documents
  WHERE deleted_at IS NOT NULL
    AND deleted_at < now() - p_older_than;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;
```

### document_restore — undo soft delete

```sql
CREATE OR REPLACE FUNCTION document_restore(
  p_id    bigint,
  p_agent text
) RETURNS void AS $$
DECLARE
  v_domain text;
BEGIN
  SELECT domain INTO v_domain FROM documents WHERE id = p_id AND deleted_at IS NOT NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document % not found or not deleted', p_id;
  END IF;

  -- Restore the document
  UPDATE documents SET deleted_at = NULL WHERE id = p_id;

  -- Re-generate chunks would need to happen in TypeScript (needs OpenAI)
  -- For now, just restore the note — chunks will be regenerated on next update

  -- Audit the restore
  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_domain, 'restore', p_agent, NULL, now());
END;
$$ LANGUAGE plpgsql;
```

### match_documents — semantic search via chunks, return flat document columns

All search functions return the same flat columns — no JSONB metadata wrapper. The `documents` table has real columns; search functions return them directly.

```sql
CREATE OR REPLACE FUNCTION match_documents(
  q_emb           vector(1536),
  p_threshold     float,
  p_max_results   int,
  p_domain        text DEFAULT NULL,
  p_document_type text DEFAULT NULL,
  p_project       text DEFAULT NULL
) RETURNS TABLE (
  id              bigint,
  content         text,
  name            text,
  domain          text,
  document_type   text,
  project         text,
  protection      text,
  description     text,
  agent           text,
  status          text,
  file_path       text,
  skill_ref       text,
  owner_type      text,
  owner_id        text,
  is_auto_load    boolean,
  content_hash    text,
  similarity      float
) AS $$
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
$$ LANGUAGE plpgsql;
```

### match_documents_keyword — full-text keyword search

```sql
CREATE OR REPLACE FUNCTION match_documents_keyword(
  p_query         text,
  p_max_results   int DEFAULT 10,
  p_domain        text DEFAULT NULL,
  p_document_type text DEFAULT NULL,
  p_project       text DEFAULT NULL
) RETURNS TABLE (
  id              bigint,
  content         text,
  name            text,
  domain          text,
  document_type   text,
  project         text,
  protection      text,
  description     text,
  agent           text,
  status          text,
  file_path       text,
  skill_ref       text,
  owner_type      text,
  owner_id        text,
  is_auto_load    boolean,
  content_hash    text,
  rank            float
) AS $$
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
$$ LANGUAGE plpgsql;
```

### match_documents_hybrid — combined vector + keyword search with RRF fusion

```sql
CREATE OR REPLACE FUNCTION match_documents_hybrid(
  q_emb             vector(1536),
  q_text            text,
  p_threshold       float DEFAULT 0.5,
  p_max_results     int DEFAULT 10,
  p_domain          text DEFAULT NULL,
  p_document_type   text DEFAULT NULL,
  p_project         text DEFAULT NULL,
  p_rrf_k           int DEFAULT 60
) RETURNS TABLE (
  id              bigint,
  content         text,
  name            text,
  domain          text,
  document_type   text,
  project         text,
  protection      text,
  description     text,
  agent           text,
  status          text,
  file_path       text,
  skill_ref       text,
  owner_type      text,
  owner_id        text,
  is_auto_load    boolean,
  content_hash    text,
  score           float
) AS $$
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
$$ LANGUAGE plpgsql;
```

### retrieve_context — smart retrieval based on document size

After search finds matching documents, this function decides HOW MUCH content to return to the LLM. Small documents return in full. Large documents return only the matched chunks plus surrounding context.

The `content_length` generated column on documents makes this decision instant — no need to measure the text at query time.

```sql
CREATE OR REPLACE FUNCTION retrieve_context(
  p_document_id       bigint,
  p_matched_chunk_index int,          -- which chunk matched the search
  p_context_window    int DEFAULT 4000, -- max characters to return
  p_neighbor_count    int DEFAULT 1     -- how many chunks before/after to include
) RETURNS TABLE (
  document_id     bigint,
  document_name   text,
  retrieval_mode  text,               -- 'full' or 'chunked'
  content         text,
  matched_section text
) AS $$
DECLARE
  v_doc record;
BEGIN
  SELECT d.id, d.name, d.content, d.content_length, d.chunk_count
  INTO v_doc
  FROM documents d
  WHERE d.id = p_document_id AND d.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document % not found', p_document_id;
  END IF;

  -- Small document: return everything
  IF v_doc.content_length <= p_context_window THEN
    RETURN QUERY SELECT
      v_doc.id,
      v_doc.name,
      'full'::text,
      v_doc.content,
      v_doc.content::text;   -- matched_section = full content
    RETURN;
  END IF;

  -- Large document: return matched chunk + neighbors
  RETURN QUERY SELECT
    v_doc.id,
    v_doc.name,
    'chunked'::text,
    v_doc.content,            -- full content available if LLM needs more
    string_agg(c.content, E'\n\n' ORDER BY c.chunk_index)
  FROM document_chunks c
  WHERE c.document_id = p_document_id
    AND c.chunk_index BETWEEN
      GREATEST(0, p_matched_chunk_index - p_neighbor_count)
      AND LEAST(v_doc.chunk_count - 1, p_matched_chunk_index + p_neighbor_count)
  GROUP BY v_doc.id, v_doc.name, v_doc.content;

  RETURN;
END;
$$ LANGUAGE plpgsql;
```

**How it works:**

| Document size | What the LLM gets | Why |
|---|---|---|
| Under 4,000 chars | Full document content | Small enough to fit in context — no reason to truncate |
| Over 4,000 chars | The matched chunk + 1 chunk before + 1 chunk after | Focused context around the match, plus enough surrounding text for understanding |

Both modes also return the full `content` field — the LLM can request more context if the chunked section isn't enough. The `retrieval_mode` field tells the calling code which strategy was used.

**The `p_context_window` parameter** lets you adjust the threshold. With a 200K-token model (like Claude), you could set it to 50,000 and almost always get full documents. With a smaller model, keep it at 4,000.

**The `p_neighbor_count` parameter** controls how many chunks before and after the match to include. Default 1 means: matched chunk + the section before + the section after = 3 chunks of context.

---

## Realtime Setup (Phase 3 foundation)

```sql
-- Enable Realtime on documents table
ALTER PUBLICATION supabase_realtime ADD TABLE documents;

-- Send full row data on UPDATE/DELETE (needed for conflict detection)
ALTER TABLE documents REPLICA IDENTITY FULL;
```

---

## RLS (Row Level Security)

```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE query_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_models ENABLE ROW LEVEL SECURITY;

-- Service role: full access (used by MCP server)
CREATE POLICY "Service role full access" ON documents FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON document_chunks FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON audit_log FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON agents FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON document_versions FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON search_evaluations FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON ingestion_queue FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON query_cache FOR ALL TO service_role USING (true);
CREATE POLICY "Service role full access" ON embedding_models FOR ALL TO service_role USING (true);

-- Anon key: no access
CREATE POLICY "Anon no access" ON documents FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON document_chunks FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON audit_log FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON agents FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON document_versions FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON search_evaluations FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON ingestion_queue FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON query_cache FOR ALL TO anon USING (false);
CREATE POLICY "Anon no access" ON embedding_models FOR ALL TO anon USING (false);
```

---

## Migration Path

**Side-by-side migration** — create new tables alongside old `notes` table, migrate data, verify, then drop old tables. Ledger stays live throughout.

1. **Backup** — `ledger backup` for safety
2. **Create new tables** — `documents`, `document_chunks`, `embedding_models`, `audit_log` (new partitioned), `agents`, `query_cache`, `document_versions`, `search_evaluations`, `ingestion_queue` alongside existing `notes` table
3. **Create indexes, triggers, functions** — all pointing to new tables
4. **Set up RLS + Realtime** — on new tables
5. **Seed data** — default embedding model + default agents
6. **Run migration script** — `src/scripts/migrate-v2.ts` reads directly from `notes` table, maps old fields to new columns, generates chunks + embeddings, writes to `documents` + `document_chunks` via `document_create` RPC
7. **Verify** — count matches (130 documents), search works on new tables, MCP tools work
8. **Switch TypeScript** — point code from old `notes` table to new `documents` table
9. **Verify again** — end-to-end testing with new schema
10. **Drop old tables** — `DROP TABLE notes CASCADE;` + old `audit_log` + old functions (only after everything confirmed working)

**Why not drop-and-recreate:** Ledger MCP tools stay live during migration. Context is preserved. If migration fails, old tables are untouched. Can compare old vs new data side by side.

---

## What Changes in TypeScript

Full spec: `docs/superpowers/specs/2026-03-30-typescript-architecture.md`

### New files (replace old `notes.ts`)

| File | Responsibility |
|------|---------------|
| `src/lib/document-classification.ts` | Types, domains, protection, inference, validation |
| `src/lib/document-operations.ts` | Create, update, delete, restore (calls Postgres RPC) |
| `src/lib/document-fetching.ts` | getById, getByName, list, fetchSyncable |
| `src/lib/ai-search.ts` | Vector, keyword, hybrid search + smart retrieval |
| `src/lib/embeddings.ts` | Embedding generation, chunking, caching, hashing |

### Deleted files

| File | Why |
|------|-----|
| `src/lib/notes.ts` | Replaced by 5 new files above |
| `src/lib/audit.ts` | Postgres functions handle audit |
| `src/lib/backfill.ts` | Replaced by migration script |

### Updated files

| File | Changes |
|------|---------|
| `src/mcp-server.ts` | New `*_documents` tools + deprecated `*_notes` tools |

---

## Implementation-Phase Features (TypeScript, not schema)

These require application code, not just database changes. Schema supports them, code builds on top.

### Semantic Chunking

Split documents by topic using embeddings, not just by headers/paragraphs. When a paragraph shifts topic, that's a chunk boundary. Requires calling the embedding API per candidate split point and comparing similarity. The `chunk_strategy` column on `document_chunks` records which strategy was used ('header', 'paragraph', 'semantic', etc.) so we can compare results.

### Cross-Encoder Re-ranking

After initial retrieval (vector + keyword), run results through a cross-encoder model (Cohere Rerank, Jina Reranker, or a local model) that scores each result against the original query more accurately than embedding similarity alone. This is a second-pass refinement — expensive per result but only runs on the top 10-20 candidates.

### Query Routing

Analyze the search query to decide which search mode to use:
- "What is OAuth?" → vector search (semantic meaning)
- "opAddNote" → keyword search (exact code identifier)
- "how does the hook system work" → hybrid (both meaning and keywords matter)

Routing logic lives in TypeScript. The schema supports all three modes — routing just picks which Postgres function to call.

### JWT Agent Authentication

Replace service_role key with per-agent JWTs. Each agent gets a signed token containing `{ agent_id: "claude-code" }`. RLS policies read the claim via `auth.jwt()->'agent_id'`. The `agents` table is ready — this phase adds the token generation, validation, and RLS policy enforcement.

---

## Pre-DDL Checklist (from data modeling reference)

- [x] 10 most important queries written before schema
- [x] 3NF — no transitive dependencies, no repeated data
- [x] No JSONB for queryable fields — every filtered field is a column
- [x] All identifiers: snake_case, lowercase, < 63 chars
- [x] No reserved words (document_type not type, name not key)
- [x] Tables: plural nouns
- [x] FK: document_id with ON DELETE CASCADE, embedding_model_id with FK
- [x] Booleans: is_auto_load, is_active
- [x] Timestamps: timestamptz with _at suffix
- [x] All columns NOT NULL unless nullable has domain reason
- [x] CHECK constraints on domain, protection, owner_type, status, source_type
- [x] updated_at trigger
- [x] Every FK column indexed
- [x] Vector: HNSW with vector_cosine_ops, m=16, ef_construction=64
- [x] Multi-index: per-domain partial HNSW indexes
- [x] Full-text: tsvector generated column + GIN index
- [x] Audit table partitioned by year with auto-partition function
- [x] Soft delete with partial index on active rows
- [x] Realtime publication + REPLICA IDENTITY FULL
- [x] Embedding model registry (embedding_models table)
- [x] Query cache table for embedding reuse
- [x] Cache cleanup function
- [x] Multi-format source tracking (source_type, source_url on documents)
- [x] Chunk content types (content_type on document_chunks)
- [x] Chunk overlap tracking (overlap_chars on document_chunks)
- [x] Document retrieval count (retrieval_count on documents)
- [x] Smart retrieval function (retrieve_context — full vs chunked)
- [x] Document versioning (document_versions — full snapshots + cleanup function)
- [x] Search evaluation metrics (search_evaluations table)
- [x] Ingestion pipeline queue (ingestion_queue table)
