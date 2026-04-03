# Ledger — Database Indexes, Extensions, and Infrastructure

> 56 indexes, 7 extensions, triggers, RLS, realtime, and cron job status.
>
> Updated: 2026-04-03. Parent doc: `ledger-architecture-database.md`

---

## Table of Contents

- [Indexes (56 total)](#indexes-56-total)
- [Extensions](#extensions)
- [Triggers](#triggers)
- [Row-Level Security](#row-level-security)
- [Relationships](#relationships)
- [Realtime](#realtime)
- [Scheduled Jobs (Cron)](#scheduled-jobs-cron)

---

## Indexes (56 total)

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

### audit_log (4 x 3 = 12 with partitions)

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

-- eval_runs (1)
CREATE UNIQUE INDEX eval_runs_pkey                     ON eval_runs USING btree (id);

-- ingestion_queue (2)
CREATE UNIQUE INDEX ingestion_queue_pkey                ON ingestion_queue USING btree (id);
CREATE INDEX index_ingestion_queue_status               ON ingestion_queue USING btree (status, created_at) WHERE (status = ANY (ARRAY['pending', 'processing']));

-- embedding_models (1)
CREATE UNIQUE INDEX embedding_models_pkey               ON embedding_models USING btree (id);
```

---

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

| Trigger          | Table       | Event  | Timing | Function                         |
|------------------|-------------|--------|--------|----------------------------------|
| `set_updated_at` | `documents` | UPDATE | BEFORE | `trg_documents_set_updated_at()` |

---

## Row-Level Security

RLS enabled on all 14 tables. Current policy: service_role gets full access, anon gets nothing. Per-agent policies planned for Phase 6.

**Policy pattern** (same on every table):

```sql
-- Block anonymous access
CREATE POLICY "Anon no access" ON <table> FOR ALL USING (false);

-- Allow service_role full access
CREATE POLICY "Service role full access" ON <table> FOR ALL USING (true);
```

| Table                          | RLS | Anon Blocked | Service Role |
|--------------------------------|-----|--------------|--------------|
| `documents`                    | Yes | Yes          | Yes          |
| `document_chunks`              | Yes | Yes          | Yes          |
| `document_versions`            | Yes | Yes          | Yes          |
| `embedding_models`             | Yes | Yes          | Yes          |
| `query_cache`                  | Yes | Yes          | Yes          |
| `audit_log`                    | Yes | Yes          | Yes          |
| `audit_log_2026`               | Yes | Yes          | Yes          |
| `audit_log_2027`               | Yes | Yes          | Yes          |
| `agents`                       | Yes | Yes          | Yes          |
| `ingestion_queue`              | Yes | Yes          | Yes          |
| `search_evaluations`           | Yes | Yes          | Yes          |
| `search_evaluation_aggregates` | Yes | Yes          | Yes          |
| `eval_golden_dataset`          | Yes | Yes          | Yes          |
| `eval_runs`                    | Yes | Yes          | Yes          |

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

---

## Realtime

Enabled on `documents` table only (via Supabase publication `supabase_realtime`). No listener code yet — planned for Phase 5 (Event-Driven Sync).

---

## Scheduled Jobs (Cron)

**`pg_cron` extension is not installed.** None of the maintenance functions run on a schedule:

| Function                          | Recommended Schedule        | Status             |
|-----------------------------------|-----------------------------|---------------------|
| `aggregate_search_evaluations()`  | Daily                       | **Not scheduled**  |
| `cleanup_search_evaluations()`    | Daily (after aggregation)   | **Not scheduled**  |
| `cleanup_query_cache()`           | Weekly                      | **Not scheduled**  |
| `cleanup_document_versions()`     | Weekly                      | **Not scheduled**  |
| `document_purge()`                | Daily                       | **Not scheduled**  |
| `create_audit_partition_if_needed()` | Yearly                   | **Not scheduled**  |

To enable: install `pg_cron` via Supabase Dashboard → Database → Extensions, then schedule jobs. Phase 7 (Observability) covers this.
