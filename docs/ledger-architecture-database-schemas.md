# Ledger — Database Schemas

> Ground-truth schema reference generated from live Supabase. 15 tables, organized by function. Updated: 2026-04-09 (Phase 4.6.2 graded relevance).
>
> For generic RAG patterns, see `reference-rag-database-schemas.md`. This doc covers what Ledger actually has deployed.

---

## Table of Contents

- [Tables](#tables)
  - Storage
    - [documents](#documents)
    - [document_chunks](#document_chunks)
    - [document_versions](#document_versions)
    - [embedding_models](#embedding_models)
  - Caching
    - [query_cache](#query_cache)
    - [semantic_cache](#semantic_cache)
  - History
    - [audit_log](#audit_log) (partitioned: audit_log_2026, audit_log_2027)
  - Security
    - [agents](#agents)
  - Ingestion
    - [ingestion_queue](#ingestion_queue)
  - Evaluation
    - [search_evaluations](#search_evaluations)
    - [search_evaluation_aggregates](#search_evaluation_aggregates)
    - [eval_golden_dataset](#eval_golden_dataset)
    - [eval_golden_judgments](#eval_golden_judgments)
    - [eval_runs](#eval_runs)
- [Relationships](#relationships)
- [Extensions](#extensions)
- [Triggers](#triggers)
- [Row-Level Security](#row-level-security)
- [Functions Summary](#functions-17-custom)
  - [Document Operations](#document-operations-6)
  - [Search](#search-4)
  - [Evaluation & Maintenance](#evaluation--maintenance-7)
- [Indexes](#indexes-56-total)
- [Realtime](#realtime)
- [Scheduled Jobs (Cron)](#scheduled-jobs-cron)
- [Function SQL](#function-sql)
- [Active vs Unused](#active-vs-unused)

---

## Tables

### Storage

#### documents

Source of truth. One row per document, full content, all fields as real columns. No JSONB metadata.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `name`               | text         | NO       |                | Unique identifier (CHECK: lowercase + hyphens)       |
| `domain`             | text         | NO       |                | CHECK: system, persona, workspace, project, general  |
| `document_type`      | text         | NO       |                | Free-form (architecture, reference, knowledge, etc.) |
| `project`            | text         | YES      |                | Project association (NULL for non-project docs)      |
| `protection`         | text         | NO       | 'open'         | CHECK: open, guarded, protected, immutable           |
| `owner_type`         | text         | NO       | 'user'         | CHECK: system, user, team                            |
| `owner_id`           | text         | YES      |                | Owner identifier (NULL for system-owned)             |
| `is_auto_load`       | boolean      | NO       | false          | Load into agent context every session                |
| `content`            | text         | NO       |                | Full document text — never split across rows         |
| `description`        | text         | YES      |                | One-line summary for search previews                 |
| `content_hash`       | text         | YES      |                | SHA-256 for change detection                         |
| `search_vector`      | tsvector     | YES      |                | GENERATED from name + description + content          |
| `source_type`        | text         | NO       | 'text'         | CHECK: text, pdf, docx, spreadsheet, code, image, audio, video, web, email, slides, handwriting |
| `source_url`         | text         | YES      |                | Original source URL                                  |
| `file_path`          | text         | YES      |                | Local file path for sync                             |
| `file_permissions`   | text         | YES      |                | File permission string                               |
| `agent`              | text         | YES      |                | Who created/last modified                            |
| `status`             | text         | YES      |                | CHECK: idea, planning, active, done (or NULL)        |
| `skill_ref`          | text         | YES      |                | Associated skill identifier                          |
| `embedding_model_id` | text         | YES      |                | FK → embedding_models                                |
| `schema_version`     | integer      | NO       | 1              | Schema version for migrations                        |
| `content_length`     | integer      | YES      |                | GENERATED: length(content)                           |
| `chunk_count`        | integer      | NO       | 1              | Number of chunks this doc was split into             |
| `retrieval_count`    | integer      | NO       | 0              | How often found in searches                          |
| `deleted_at`         | timestamptz  | YES      |                | NULL = active, set = soft-deleted                    |
| `created_at`         | timestamptz  | NO       | now()          | Creation timestamp                                   |
| `updated_at`         | timestamptz  | NO       | now()          | Auto-updated by trigger                              |

```sql
CREATE TABLE documents (
  id                 bigserial    PRIMARY KEY,
  name               text         NOT NULL UNIQUE,
  domain             text         NOT NULL,
  document_type      text         NOT NULL,
  project            text,
  protection         text         NOT NULL DEFAULT 'open',
  owner_type         text         NOT NULL DEFAULT 'user',
  owner_id           text,
  is_auto_load       boolean      NOT NULL DEFAULT false,
  content            text         NOT NULL,
  description        text,
  content_hash       text,
  search_vector      tsvector     GENERATED ALWAYS AS (
                       to_tsvector('english', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || content)
                     ) STORED,
  source_type        text         NOT NULL DEFAULT 'text',
  source_url         text,
  file_path          text,
  file_permissions   text,
  agent              text,
  status             text,
  skill_ref          text,
  embedding_model_id text         REFERENCES embedding_models(id),
  schema_version     integer      NOT NULL DEFAULT 1,
  content_length     integer      GENERATED ALWAYS AS (length(content)) STORED,
  chunk_count        integer      NOT NULL DEFAULT 1,
  retrieval_count    integer      NOT NULL DEFAULT 0,
  deleted_at         timestamptz,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT check_documents_name_format
    CHECK (name ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$'),
  CONSTRAINT check_documents_domain
    CHECK (domain = ANY (ARRAY['system', 'persona', 'workspace', 'project', 'general'])),
  CONSTRAINT check_documents_protection
    CHECK (protection = ANY (ARRAY['open', 'guarded', 'protected', 'immutable'])),
  CONSTRAINT check_documents_owner_type
    CHECK (owner_type = ANY (ARRAY['system', 'user', 'team'])),
  CONSTRAINT check_documents_source_type
    CHECK (source_type = ANY (ARRAY['text', 'pdf', 'docx', 'spreadsheet', 'code', 'image', 'audio', 'video', 'web', 'email', 'slides', 'handwriting'])),
  CONSTRAINT check_documents_status
    CHECK (status IS NULL OR status = ANY (ARRAY['idea', 'planning', 'active', 'done']))
);
```

---

#### document_chunks

Search index. Derived from documents — each document has 1+ chunks. Can be regenerated anytime.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `document_id`        | bigint       | NO       |                | FK → documents (ON DELETE CASCADE)                   |
| `chunk_index`        | integer      | NO       |                | Position in document (UNIQUE with document_id)       |
| `content`            | text         | NO       |                | Chunk text                                           |
| `content_type`       | text         | NO       | 'text'         | text, image_description, table_extraction, code_block, transcript, slide_text |
| `embedding`          | vector(1536) | YES      |                | OpenAI embedding (pgvector)                          |
| `embedding_model_id` | text         | YES      |                | FK → embedding_models                                |
| `chunk_strategy`     | text         | YES      |                | header, paragraph, sentence, semantic, forced        |
| `overlap_chars`      | integer      | NO       | 0              | Characters shared with previous chunk                |
| `domain`             | text         | NO       | 'general'      | Denormalized from parent — HNSW indexes need it      |
| `context_summary`    | text         | YES      |                | LLM-generated context prepend — chunk context enrichment (Phase 4.5.2) |
| `token_count`        | integer      | YES      |                | Token count for budget tracking (Phase 4)            |
| `created_at`         | timestamptz  | NO       | now()          | Creation timestamp                                   |

```sql
CREATE TABLE document_chunks (
  id                 bigserial    PRIMARY KEY,
  document_id        bigint       NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index        integer      NOT NULL,
  content            text         NOT NULL,
  content_type       text         NOT NULL DEFAULT 'text',
  embedding          vector(1536),
  embedding_model_id text         REFERENCES embedding_models(id),
  chunk_strategy     text,
  overlap_chars      integer      NOT NULL DEFAULT 0,
  domain             text         NOT NULL DEFAULT 'general',
  context_summary    text,
  token_count        integer,
  created_at         timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (document_id, chunk_index),
  CONSTRAINT check_document_chunks_domain
    CHECK (domain = ANY (ARRAY['system', 'persona', 'workspace', 'project', 'general']))
);
```

---

#### document_versions

Full content snapshots before each update. Enables rollback.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `document_id`        | bigint       | NO       |                | FK → documents                                       |
| `version_number`     | integer      | NO       |                | UNIQUE with document_id                              |
| `content`            | text         | NO       |                | Full content at this version                         |
| `content_hash`       | text         | YES      |                | SHA-256 of versioned content                         |
| `agent`              | text         | YES      |                | Who made the change                                  |
| `created_at`         | timestamptz  | NO       | now()          | When this version was saved                          |

```sql
CREATE TABLE document_versions (
  id                 bigserial    PRIMARY KEY,
  document_id        bigint       NOT NULL REFERENCES documents(id),
  version_number     integer      NOT NULL,
  content            text         NOT NULL,
  content_hash       text,
  agent              text,
  created_at         timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (document_id, version_number)
);
```

---

#### embedding_models

Model registry. Tracks which embedding model generated which vectors.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | text         | NO       |                | PK (e.g. 'openai/text-embedding-3-small')            |
| `provider`           | text         | NO       |                | Provider name (openai, cohere, ollama)               |
| `model_name`         | text         | NO       |                | Model identifier                                     |
| `dimensions`         | integer      | NO       |                | Vector dimensions (1536 for text-embedding-3-small)  |
| `is_default`         | boolean      | NO       | false          | Whether this is the default model                    |
| `created_at`         | timestamptz  | NO       | now()          | Registration timestamp                               |

```sql
CREATE TABLE embedding_models (
  id                 text         PRIMARY KEY,
  provider           text         NOT NULL,
  model_name         text         NOT NULL,
  dimensions         integer      NOT NULL,
  is_default         boolean      NOT NULL DEFAULT false,
  created_at         timestamptz  NOT NULL DEFAULT now()
);
```

---

### Caching

#### query_cache

Cached query embeddings. Avoids repeat OpenAI API calls for the same search.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `query_text`         | text         | NO       |                | UNIQUE — the search query                            |
| `embedding`          | vector(1536) | YES      |                | Cached embedding (HNSW indexed for semantic cache)   |
| `embedding_model_id` | text         | YES      |                | Which model generated this embedding                 |
| `hit_count`          | integer      | NO       | 0              | Times this cache entry was reused                    |
| `created_at`         | timestamptz  | NO       | now()          | When cached                                          |
| `last_used_at`       | timestamptz  | NO       | now()          | Last access (for cleanup)                            |

```sql
CREATE TABLE query_cache (
  id                 bigserial    PRIMARY KEY,
  query_text         text         NOT NULL UNIQUE,
  embedding          vector(1536),
  embedding_model_id text         REFERENCES embedding_models(id),
  hit_count          integer      NOT NULL DEFAULT 0,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  last_used_at       timestamptz  NOT NULL DEFAULT now()
);
```

#### semantic_cache

Layer 2 cache: stores full search results keyed by query embedding similarity. When a semantically similar query arrives (cosine > 0.90), returns cached results directly, skipping the entire search pipeline. Invalidated automatically when source documents change.

| Column               | Type         | Nullable | Default                       | Purpose                                              |
|----------------------|--------------|----------|-------------------------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto                          | Primary key                                          |
| `query_text`         | text         | NO       |                               | Original query (for debugging/observability)         |
| `query_embedding`    | vector(1536) | NO       |                               | Query vector for HNSW similarity lookup              |
| `search_mode`        | text         | NO       |                               | 'vector', 'keyword', or 'hybrid'                    |
| `search_params`      | jsonb        | NO       |                               | Serialized search parameters (threshold, limit, filters) |
| `cached_results`     | jsonb        | NO       |                               | Full ISearchResultProps[] objects                    |
| `source_doc_ids`     | int[]        | NO       |                               | Reverse index: doc IDs in results (GIN indexed)     |
| `embedding_model_id` | text         | NO       |                               | Version key (cache miss on model change)            |
| `created_at`         | timestamptz  | NO       | now()                         | When cached                                          |
| `expires_at`         | timestamptz  | NO       | now() + interval '7 days'     | TTL expiry (safety net behind active invalidation)  |

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

---

### History

#### audit_log

Append-only change tracking. Partitioned by year. No FK to documents — survives deletion.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Part of composite PK (id, created_at)                |
| `document_id`        | bigint       | YES      |                | No FK — intentional (survives hard delete)           |
| `domain`             | text         | YES      |                | Document domain at time of change                    |
| `operation`          | text         | NO       |                | create, update, update_fields, delete, restore       |
| `agent`              | text         | NO       |                | Who made the change                                  |
| `diff`               | jsonb        | YES      |                | Old values for rollback                              |
| `created_at`         | timestamptz  | NO       | now()          | Partition key                                        |

**Partitions:** `audit_log_2026`, `audit_log_2027` (identical schema, auto-created via `create_audit_partition_if_needed`)

```sql
CREATE TABLE audit_log (
  id                 bigserial,
  document_id        bigint,
  domain             text,
  operation          text         NOT NULL,
  agent              text         NOT NULL,
  diff               jsonb,
  created_at         timestamptz  NOT NULL DEFAULT now(),

  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_log_2026 PARTITION OF audit_log
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE TABLE audit_log_2027 PARTITION OF audit_log
  FOR VALUES FROM ('2027-01-01') TO ('2028-01-01');
```

---

### Security

#### agents

Agent registry. Foundation for Phase 6 (RBAC, per-agent auth).

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | text         | NO       |                | PK (e.g. 'claude-code', 'stan')                     |
| `display_name`       | text         | NO       |                | Human-readable name                                  |
| `permissions`        | jsonb        | NO       | '{}'           | Permission map (Phase 6)                             |
| `api_key_hash`       | text         | YES      |                | Hashed API key for auth (Phase 6)                    |
| `is_active`          | boolean      | NO       | true           | Whether agent can access the system                  |
| `created_at`         | timestamptz  | NO       | now()          | Registration timestamp                               |
| `last_seen_at`       | timestamptz  | YES      |                | Last activity timestamp                              |

```sql
CREATE TABLE agents (
  id                 text         PRIMARY KEY,
  display_name       text         NOT NULL,
  permissions        jsonb        NOT NULL DEFAULT '{}',
  api_key_hash       text,
  is_active          boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  last_seen_at       timestamptz
);
```

---

### Ingestion

#### ingestion_queue

Async file processing pipeline. Table exists — no processing code yet (Phase 4.6).

| Column                | Type         | Nullable | Default        | Purpose                                              |
|-----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                  | bigserial    | NO       | auto           | Primary key                                          |
| `source_type`         | text         | NO       |                | File format (pdf, audio, image, etc.)                |
| `source_url`          | text         | NO       |                | Where to fetch the file                              |
| `target_domain`       | text         | NO       | 'general'      | Domain for the created document                      |
| `target_document_type`| text         | NO       | 'knowledge'    | Document type for the created document               |
| `target_name`         | text         | YES      |                | Optional name override                               |
| `status`              | text         | NO       | 'pending'      | pending, processing, completed, failed               |
| `error_message`       | text         | YES      |                | Error details on failure                             |
| `document_id`         | bigint       | YES      |                | FK → documents (set on completion)                   |
| `agent`               | text         | YES      |                | Who queued this                                      |
| `created_at`          | timestamptz  | NO       | now()          | When queued                                          |
| `started_at`          | timestamptz  | YES      |                | When processing began                                |
| `completed_at`        | timestamptz  | YES      |                | When processing finished                             |

```sql
CREATE TABLE ingestion_queue (
  id                   bigserial    PRIMARY KEY,
  source_type          text         NOT NULL,
  source_url           text         NOT NULL,
  target_domain        text         NOT NULL DEFAULT 'general',
  target_document_type text         NOT NULL DEFAULT 'knowledge',
  target_name          text,
  status               text         NOT NULL DEFAULT 'pending',
  error_message        text,
  document_id          bigint       REFERENCES documents(id),
  agent                text,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  started_at           timestamptz,
  completed_at         timestamptz,

  CONSTRAINT check_ingestion_status
    CHECK (status = ANY (ARRAY['pending', 'processing', 'completed', 'failed']))
);
```

---

### Evaluation

#### search_evaluations

Raw search telemetry. Every search auto-logged by `logSearchEvaluation()` in `ai-search.ts`.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `query_text`         | text         | NO       |                | The search query                                     |
| `search_mode`        | text         | NO       |                | vector, keyword, hybrid                              |
| `result_count`       | integer      | NO       | 0              | Number of results returned                           |
| `results`            | jsonb        | YES      |                | Array of {id, score, document_type}                  |
| `agent`              | text         | YES      |                | Who searched (not currently populated)               |
| `feedback`           | text         | YES      |                | relevant, irrelevant, partial (not currently used)   |
| `response_time_ms`   | integer      | YES      |                | Search latency in milliseconds                       |
| `document_types`     | text[]       | YES      |                | Unique doc types in results                          |
| `source_types`       | text[]       | YES      |                | Unique source types in results                       |
| `created_at`         | timestamptz  | NO       | now()          | When the search happened                             |

```sql
CREATE TABLE search_evaluations (
  id                 bigserial    PRIMARY KEY,
  query_text         text         NOT NULL,
  search_mode        text         NOT NULL,
  result_count       integer      NOT NULL DEFAULT 0,
  results            jsonb,
  agent              text,
  feedback           text,
  response_time_ms   integer,
  document_types     text[],
  source_types       text[],
  created_at         timestamptz  NOT NULL DEFAULT now()
);
```

---

#### search_evaluation_aggregates

Daily summaries crunched from raw `search_evaluations`. Function `aggregate_search_evaluations()` exists but no cron calls it yet.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `date`               | date         | NO       |                | Summary date                                         |
| `search_count`       | integer      | NO       | 0              | Total searches that day                              |
| `avg_result_count`   | float        | NO       | 0              | Average results per search                           |
| `avg_response_time_ms`| float       | NO       | 0              | Average latency                                      |
| `zero_result_count`  | integer      | NO       | 0              | Searches that returned nothing                       |
| `zero_result_rate`   | float        | NO       | 0              | zero_result_count / search_count                     |
| `avg_score`          | float        | YES      |                | Average result score                                 |
| `searches_by_mode`   | jsonb        | NO       | '{}'           | {vector: N, keyword: N, hybrid: N}                   |
| `top_document_types` | jsonb        | NO       | '{}'           | Most frequently returned doc types                   |
| `feedback_counts`    | jsonb        | NO       | '{}'           | {relevant: N, irrelevant: N, partial: N}             |
| `created_at`         | timestamptz  | NO       | now()          | When aggregated                                      |

```sql
CREATE TABLE search_evaluation_aggregates (
  id                   bigserial       PRIMARY KEY,
  date                 date            NOT NULL,
  search_count         integer         NOT NULL DEFAULT 0,
  avg_result_count     double precision NOT NULL DEFAULT 0,
  avg_response_time_ms double precision NOT NULL DEFAULT 0,
  zero_result_count    integer         NOT NULL DEFAULT 0,
  zero_result_rate     double precision NOT NULL DEFAULT 0,
  avg_score            double precision,
  searches_by_mode     jsonb           NOT NULL DEFAULT '{}',
  top_document_types   jsonb           NOT NULL DEFAULT '{}',
  feedback_counts      jsonb           NOT NULL DEFAULT '{}',
  created_at           timestamptz     NOT NULL DEFAULT now()
);
```

---

#### eval_golden_dataset

Curated test queries for automated evaluation. 144 test cases across 19 tags. Pairs with `eval_golden_judgments` for graded relevance — the dataset holds queries, the judgments table holds per-doc grades.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `query`              | text         | NO       |                | The test search query                                |
| `expected_answer`    | text         | YES      |                | Expected answer text (for generation eval, unused)   |
| `tags`               | text[]       | YES      | '{}'           | Categories                                           |
| `created_at`         | timestamptz  | NO       | now()          | Creation timestamp                                   |
| `updated_at`         | timestamptz  | NO       | now()          | Last update                                          |

```sql
CREATE TABLE eval_golden_dataset (
  id                 bigserial    PRIMARY KEY,
  query              text         NOT NULL,
  expected_answer    text,
  tags               text[]       DEFAULT '{}',
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);
```

> **Phase 4.6.2 migration:** The legacy `expected_doc_ids integer[]` column was removed. Prior binary judgments were converted to grade-3 rows in `eval_golden_judgments` before the column was dropped.

---

#### eval_golden_judgments

Graded relevance judgments — one row per (query, document) pair, using the TREC 4-level scale (0 not relevant, 1 related, 2 relevant, 3 highly relevant). Replaces the binary `expected_doc_ids` pattern. Enables NDCG with `gain = 2^grade - 1` and a `hit_threshold=2` rule across rate metrics.

| Column         | Type         | Nullable | Default        | Purpose                                                              |
|----------------|--------------|----------|----------------|----------------------------------------------------------------------|
| `id`           | bigserial    | NO       | auto           | Primary key                                                          |
| `golden_id`    | bigint       | NO       |                | FK → `eval_golden_dataset.id` ON DELETE CASCADE                      |
| `document_id`  | bigint       | NO       |                | FK → `documents.id` ON DELETE CASCADE                                |
| `grade`        | smallint     | NO       |                | TREC grade. `CHECK (grade BETWEEN 0 AND 3)`                          |
| `judged_at`    | timestamptz  | NO       | now()          | Audit — when this judgment was recorded                              |
| `judged_by`    | text         | NO       | 'adrian'       | Audit — who judged (forward-compat for multi-judge)                  |
| `notes`        | text         | YES      |                | Free-form reasoning for tricky boundary calls                        |

```sql
CREATE TABLE eval_golden_judgments (
  id            bigserial    PRIMARY KEY,
  golden_id     bigint       NOT NULL REFERENCES eval_golden_dataset(id) ON DELETE CASCADE,
  document_id   bigint       NOT NULL REFERENCES documents(id)           ON DELETE CASCADE,
  grade         smallint     NOT NULL CHECK (grade BETWEEN 0 AND 3),
  judged_at     timestamptz  NOT NULL DEFAULT now(),
  judged_by     text         NOT NULL DEFAULT 'adrian',
  notes         text,
  UNIQUE (golden_id, document_id)
);
```

Grading rubric and metric definitions: see `ledger-architecture-database-tables.md` → `eval_golden_judgments`.

---

#### eval_runs

Stored results from each golden dataset evaluation run. Tracks improvement over time.

| Column                                  | Type         | Nullable | Default | Purpose                                                   |
|-----------------------------------------|--------------|----------|---------|-----------------------------------------------------------|
| `id`                                    | bigserial    | NO       | auto    | Primary key                                               |
| `run_date`                              | timestamptz  | NO       | now()   | When this eval was executed                               |
| `config`                                | jsonb        | NO       |         | Settings snapshot: threshold, chunking, model, RRF k      |
| `test_case_count`                       | integer      | NO       |         | Number of test cases run                                  |
| `hit_rate`                              | float        | NO       |         | % queries that found at least one expected doc            |
| `first_result_accuracy`                 | float        | NO       |         | % queries where #1 result was correct                     |
| `recall`                                | float        | NO       |         | % expected docs actually found                            |
| `zero_result_rate`                      | float        | NO       |         | % queries that returned nothing                           |
| `avg_response_time_ms`                  | float        | NO       |         | Average search latency                                    |
| `mean_reciprocal_rank`                  | float        | YES      |         | Where the first correct doc ranks (1/position)            |
| `normalized_discounted_cumulative_gain` | float        | YES      |         | How well all relevant docs are ranked (0-1)               |
| `confidence_intervals`                  | jsonb        | YES      |         | 95% CI for all metrics (bootstrap, point/lower/upper/width) |
| `score_calibration`                     | jsonb        | YES      |         | Relevant vs irrelevant score distributions + separation   |
| `coverage_analysis`                     | jsonb        | YES      |         | Queries per tag, unique docs tested, undertested flags    |
| `results_by_tag`                        | jsonb        | YES      |         | Per-tag breakdown {tag: {total, hits, firstHits}}         |
| `missed_queries`                        | jsonb        | YES      |         | Failed queries: {query, tags, expected, got, gotScores}                 |
| `per_query_results`                     | jsonb        | YES      |         | Full detail: {query, tags, expectedDocIds, hit, position, reciprocalRank, NDCG, returnedIds, returnedScores} |

```sql
CREATE TABLE eval_runs (
  id                                    bigserial        PRIMARY KEY,
  run_date                              timestamptz      NOT NULL DEFAULT now(),
  config                                jsonb            NOT NULL,
  test_case_count                       integer          NOT NULL,
  hit_rate                              double precision NOT NULL,
  first_result_accuracy                 double precision NOT NULL,
  recall                                double precision NOT NULL,
  zero_result_rate                      double precision NOT NULL,
  avg_response_time_ms                  double precision NOT NULL,
  mean_reciprocal_rank                  double precision,
  normalized_discounted_cumulative_gain double precision,
  confidence_intervals                  jsonb,
  score_calibration                     jsonb,
  coverage_analysis                     jsonb,
  results_by_tag                        jsonb,
  missed_queries                        jsonb,
  per_query_results                     jsonb
);
```

---

## Relationships

```
documents ──< document_chunks     (1:N, CASCADE delete)
documents ──< document_versions   (1:N)
documents ──< audit_log           (1:N, no FK — survives deletion)
documents >── embedding_models    (N:1, optional)
document_chunks >── embedding_models (N:1, optional)
query_cache >── embedding_models  (N:1, optional)
ingestion_queue >── documents     (N:1, set on completion)
```

## Extensions

| Extension            | Version | Purpose                                      |
|----------------------|---------|----------------------------------------------|
| `vector`             | 0.8.0   | pgvector — vector storage + HNSW indexes     |
| `pgcrypto`           | 1.3     | SHA-256 hashing for content_hash             |
| `pgtap`              | 1.3.3   | Database unit testing framework              |
| `pg_graphql`         | 1.5.11  | Supabase GraphQL (auto-enabled)              |
| `pg_stat_statements` | 1.11    | Query performance stats (auto-enabled)       |
| `supabase_vault`     | 0.3.1   | Secrets management (auto-enabled)            |
| `uuid-ossp`          | 1.1     | UUID generation (auto-enabled)               |

---

## Triggers

| Trigger          | Table       | Event  | Timing | Function        |
|------------------|-------------|--------|--------|-----------------|
| `set_updated_at` | `documents` | UPDATE | BEFORE | `trg_documents_set_updated_at()` |

```sql
-- Trigger function
CREATE OR REPLACE FUNCTION trg_documents_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION trg_documents_set_updated_at();
```

---

## Row-Level Security

RLS enabled on all 15 tables. Current policy: service_role gets full access, anon gets nothing. Per-agent policies planned for Phase 6.

**Policy pattern** (same on every table except `eval_runs`):

```sql
-- Block anonymous access
CREATE POLICY "Anon no access" ON <table> FOR ALL USING (false);

-- Allow service_role full access
CREATE POLICY "Service role full access" ON <table> FOR ALL USING (true);
```

| Table                          | RLS | Anon Blocked | Service Role | Notes              |
|--------------------------------|-----|--------------|--------------|---------------------|
| `documents`                    | Yes | Yes          | Yes          |                     |
| `document_chunks`              | Yes | Yes          | Yes          |                     |
| `document_versions`            | Yes | Yes          | Yes          |                     |
| `embedding_models`             | Yes | Yes          | Yes          |                     |
| `query_cache`                  | Yes | Yes          | Yes          |                     |
| `audit_log`                    | Yes | Yes          | Yes          |                     |
| `audit_log_2026`               | Yes | Yes          | Yes          |                     |
| `audit_log_2027`               | Yes | Yes          | Yes          |                     |
| `agents`                       | Yes | Yes          | Yes          |                     |
| `ingestion_queue`              | Yes | Yes          | Yes          |                     |
| `search_evaluations`           | Yes | Yes          | Yes          |                     |
| `search_evaluation_aggregates` | Yes | Yes          | Yes          |                     |
| `eval_golden_dataset`          | Yes | Yes          | Yes          |                     |
| `eval_golden_judgments`        | Yes | Yes          | Yes          |                     |
| `eval_runs`                    | Yes | Yes          | Yes          |                     |

---

## Functions (21 custom)

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

### Evaluation & Maintenance (10)

| Function                          | Returns | Purpose                                             |
|-----------------------------------|---------|-----------------------------------------------------|
| `aggregate_search_evaluations`    | void    | Crunch raw search_evaluations into daily summaries   |
| `cleanup_search_evaluations`      | void    | Delete raw rows older than N days (after aggregation)|
| `cleanup_document_versions`       | void    | Keep only last N versions per document               |
| `cleanup_query_cache`             | void    | Remove stale cached query embeddings                 |
| `create_audit_partition_if_needed`| void    | Auto-create next year's audit_log partition           |
| `document_purge`                  | integer | (listed above — also serves as maintenance)          |
| `trg_documents_set_updated_at`    | trigger | Auto-set updated_at on document changes              |
| `judgment_create`                 | bigint  | Insert a graded judgment for (golden_id, document_id). Errors on duplicate. |
| `judgment_update`                 | void    | Update existing judgment's grade/notes, bumps `judged_at`. Errors if missing. |
| `judgment_delete`                 | void    | Remove a judgment. Idempotent on missing row.        |
| `count_golden_with_min_judgments` | bigint  | Count golden queries with >= N judgments. Progress display for eval:judge. |

---

## Indexes (61 total)

### documents (12)

```sql
CREATE UNIQUE INDEX documents_pkey                    ON documents USING btree (id);
CREATE UNIQUE INDEX documents_name_key                ON documents USING btree (name);
CREATE INDEX index_documents_domain                   ON documents USING btree (domain);
CREATE INDEX index_documents_document_type            ON documents USING btree (document_type);
CREATE INDEX index_documents_domain_document_type     ON documents USING btree (domain, document_type);
CREATE INDEX index_documents_project                  ON documents USING btree (project) WHERE (project IS NOT NULL);
CREATE INDEX index_documents_is_auto_load             ON documents USING btree (is_auto_load) WHERE (is_auto_load = true);
CREATE INDEX index_documents_owner                    ON documents USING btree (owner_type, owner_id) WHERE (owner_id IS NOT NULL);
CREATE INDEX index_documents_created_at               ON documents USING btree (created_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX index_documents_active                   ON documents USING btree (id) WHERE (deleted_at IS NULL);
CREATE INDEX gin_documents_search_vector              ON documents USING gin (search_vector);
CREATE INDEX index_documents_skill_ref                ON documents USING btree (skill_ref) WHERE (skill_ref IS NOT NULL);
```

### document_chunks (10)

```sql
CREATE UNIQUE INDEX document_chunks_pkey              ON document_chunks USING btree (id);
CREATE UNIQUE INDEX unique_document_chunks_doc_index  ON document_chunks USING btree (document_id, chunk_index);
CREATE INDEX index_document_chunks_document_id        ON document_chunks USING btree (document_id, chunk_index);
CREATE INDEX index_document_chunks_model              ON document_chunks USING btree (embedding_model_id);
CREATE INDEX hnsw_document_chunks_embedding           ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');
CREATE INDEX hnsw_document_chunks_general             ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (domain = 'general');
CREATE INDEX hnsw_document_chunks_persona             ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (domain = 'persona');
CREATE INDEX hnsw_document_chunks_project             ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (domain = 'project');
CREATE INDEX hnsw_document_chunks_system              ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (domain = 'system');
CREATE INDEX hnsw_document_chunks_workspace           ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64') WHERE (domain = 'workspace');
```

### audit_log (4 × 3 = 12 with partitions)

```sql
-- Parent (inherited by partitions)
CREATE UNIQUE INDEX audit_log_pkey                    ON ONLY audit_log USING btree (id, created_at);
CREATE INDEX index_audit_log_document_id              ON ONLY audit_log USING btree (document_id, created_at DESC);
CREATE INDEX index_audit_log_agent                    ON ONLY audit_log USING btree (agent, created_at DESC);
CREATE INDEX index_audit_log_domain                   ON ONLY audit_log USING btree (domain, created_at DESC);

-- Each partition (audit_log_2026, audit_log_2027) inherits the same 4 indexes
```

### query_cache (4)

```sql
CREATE UNIQUE INDEX query_cache_pkey                  ON query_cache USING btree (id);
CREATE UNIQUE INDEX query_cache_query_text_key        ON query_cache USING btree (query_text);
CREATE INDEX index_query_cache_last_used              ON query_cache USING btree (last_used_at);
CREATE INDEX hnsw_query_cache_embedding               ON query_cache USING hnsw (embedding vector_cosine_ops) WITH (m='16', ef_construction='64');
```

### document_versions (3)

```sql
CREATE UNIQUE INDEX document_versions_pkey            ON document_versions USING btree (id);
CREATE UNIQUE INDEX unique_document_versions_doc_version ON document_versions USING btree (document_id, version_number);
CREATE INDEX index_document_versions_document         ON document_versions USING btree (document_id, version_number DESC);
```

### search_evaluations (4)

```sql
CREATE UNIQUE INDEX search_evaluations_pkey           ON search_evaluations USING btree (id);
CREATE INDEX index_search_evaluations_created         ON search_evaluations USING btree (created_at DESC);
CREATE INDEX index_search_evaluations_feedback        ON search_evaluations USING btree (feedback) WHERE (feedback IS NOT NULL);
CREATE INDEX index_search_evaluations_no_results      ON search_evaluations USING btree (created_at DESC) WHERE (result_count = 0);
```

### search_evaluation_aggregates (3)

```sql
CREATE UNIQUE INDEX search_evaluation_aggregates_pkey ON search_evaluation_aggregates USING btree (id);
CREATE UNIQUE INDEX search_evaluation_aggregates_date_key ON search_evaluation_aggregates USING btree (date);
CREATE INDEX index_search_evaluation_aggregates_date  ON search_evaluation_aggregates USING btree (date DESC);
```

### Other tables

```sql
-- agents (2)
CREATE UNIQUE INDEX agents_pkey                       ON agents USING btree (id);
CREATE UNIQUE INDEX agents_api_key_hash_key           ON agents USING btree (api_key_hash);

-- eval_golden_dataset (2)
CREATE UNIQUE INDEX eval_golden_dataset_pkey           ON eval_golden_dataset USING btree (id);
CREATE INDEX index_eval_golden_tags                    ON eval_golden_dataset USING gin (tags);

-- eval_golden_judgments (5)
CREATE UNIQUE INDEX eval_golden_judgments_pkey         ON eval_golden_judgments USING btree (id);
CREATE UNIQUE INDEX eval_golden_judgments_unique       ON eval_golden_judgments USING btree (golden_id, document_id);
CREATE INDEX idx_golden_judgments_golden_id            ON eval_golden_judgments USING btree (golden_id);
CREATE INDEX idx_golden_judgments_document_id          ON eval_golden_judgments USING btree (document_id);
CREATE INDEX idx_golden_judgments_grade                ON eval_golden_judgments USING btree (grade);

-- eval_runs (1)
CREATE UNIQUE INDEX eval_runs_pkey                     ON eval_runs USING btree (id);

-- ingestion_queue (2)
CREATE UNIQUE INDEX ingestion_queue_pkey                ON ingestion_queue USING btree (id);
CREATE INDEX index_ingestion_queue_status               ON ingestion_queue USING btree (status, created_at) WHERE (status = ANY (ARRAY['pending', 'processing']));

-- embedding_models (1)
CREATE UNIQUE INDEX embedding_models_pkey               ON embedding_models USING btree (id);
```

---

## Realtime

Enabled on `documents` table only (via Supabase publication `supabase_realtime`). No listener code yet — planned for Phase 5 (Event-Driven Sync).

```sql
-- Verified via:
-- SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
-- Result: public.documents
```

---

## Scheduled Jobs (Cron)

**`pg_cron` extension is not installed.** None of the maintenance functions run on a schedule:

| Function                          | Recommended Schedule | Status         |
|-----------------------------------|----------------------|----------------|
| `aggregate_search_evaluations()`  | Daily                | **Not scheduled** |
| `cleanup_search_evaluations()`    | Daily (after aggregation) | **Not scheduled** |
| `cleanup_query_cache()`           | Weekly               | **Not scheduled** |
| `cleanup_document_versions()`     | Weekly               | **Not scheduled** |
| `document_purge()`                | Daily                | **Not scheduled** |
| `create_audit_partition_if_needed()` | Yearly            | **Not scheduled** |

To enable: install `pg_cron` via Supabase Dashboard → Database → Extensions, then schedule jobs. Phase 7 (Observability) covers this.

---

## Function SQL

### Document Operations

#### document_create

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

#### document_update

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

#### document_update_fields

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

#### document_delete

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

#### document_restore

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

#### document_purge

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

### Search

#### match_documents (vector)

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

#### match_documents_keyword

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

#### match_documents_hybrid (RRF fusion)

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

#### retrieve_context (smart retrieval)

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

### Evaluation & Maintenance

#### aggregate_search_evaluations

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

#### cleanup_search_evaluations

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

#### cleanup_document_versions

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

#### cleanup_query_cache

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

#### create_audit_partition_if_needed

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

---

## Active vs Unused

| Table                          | Used in Code? | Notes                                        |
|--------------------------------|---------------|----------------------------------------------|
| `documents`                    | Yes           | Core — all CRUD operations                   |
| `document_chunks`              | Yes           | Created by RPC functions during writes       |
| `document_versions`            | Yes           | Created by `document_update` RPC             |
| `embedding_models`             | Yes           | FK reference, queried during setup           |
| `query_cache`                  | Yes           | Read/write in `embeddings.ts`                |
| `audit_log` + partitions       | Yes           | Written by all RPC functions                 |
| `search_evaluations`           | Yes           | Written by `logSearchEvaluation()` every search |
| `eval_golden_dataset`          | Yes           | Read by eval runner (queries + tags)                                      |
| `eval_golden_judgments`        | Yes           | Read by eval runner (grades), written by `ledger eval:judge` via RPC      |
| `eval_runs`                    | Yes           | Written by `saveEvalRun()`, read by `loadPreviousRun()` in eval-store.ts  |
| `search_evaluation_aggregates` | **No**        | Table + function exist — no cron wired (Phase 7) |
| `agents`                       | **No**        | Table exists — enforcement in Phase 6        |
| `ingestion_queue`              | **No**        | Table exists — processing code in Phase 4.6  |
