# Ledger — Database Table Schemas

> Full schema for all 13 tables. Column types, constraints, SQL. Generated from live Supabase.
>
> Updated: 2026-04-03. Parent doc: `ledger-architecture-database.md`

---

## Table of Contents

- Storage
  - [documents](#documents)
  - [document_chunks](#document_chunks)
  - [document_versions](#document_versions)
  - [embedding_models](#embedding_models)
- Caching
  - [query_cache](#query_cache)
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
  - [eval_runs](#eval_runs)

---

## Storage

### documents

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

### document_chunks

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
| `context_summary`    | text         | YES      |                | LLM-generated context prepend (Phase 4)              |
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

### document_versions

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

### embedding_models

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

## Caching

### query_cache

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

---

## History

### audit_log

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

## Security

### agents

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

## Ingestion

### ingestion_queue

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

## Evaluation

### search_evaluations

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

### search_evaluation_aggregates

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

### eval_golden_dataset

Known-correct query/expected-doc pairs for automated evaluation. 56 test cases across 6 categories.

| Column               | Type         | Nullable | Default        | Purpose                                              |
|----------------------|--------------|----------|----------------|------------------------------------------------------|
| `id`                 | bigserial    | NO       | auto           | Primary key                                          |
| `query`              | text         | NO       |                | The test search query                                |
| `expected_doc_ids`   | integer[]    | NO       |                | Document IDs that should appear in results           |
| `expected_answer`    | text         | YES      |                | Expected answer text (for generation eval, unused)   |
| `tags`               | text[]       | YES      | '{}'           | Categories: simple, conceptual, exact-term, multi-doc, cross-domain, out-of-scope |
| `created_at`         | timestamptz  | NO       | now()          | Creation timestamp                                   |
| `updated_at`         | timestamptz  | NO       | now()          | Last update                                          |

```sql
CREATE TABLE eval_golden_dataset (
  id                 bigserial    PRIMARY KEY,
  query              text         NOT NULL,
  expected_doc_ids   integer[]    NOT NULL,
  expected_answer    text,
  tags               text[]       DEFAULT '{}',
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);
```

---

### eval_runs

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
| `missed_queries`                        | jsonb        | YES      |         | Failed queries: {query, tags, expected, got, gotScores}   |
| `per_query_results`                     | jsonb        | YES      |         | Full detail per test case                                 |

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
