# Ledger — Database Architecture

> Overview of Ledger's database: 13 tables, 17 functions, 56 indexes. Supabase (Postgres + pgvector).
>
> Updated: 2026-04-03. For full details, see the child docs linked below.

The database is the backbone of Ledger. Documents go in, get chunked and embedded for search, and every change is tracked. Postgres handles the business logic — TypeScript just prepares data (chunks, embeddings, hashes) and calls RPC functions. The database does the rest: transactions, auditing, versioning, access control.

---

## Table of Contents

- [Detail Documents](#detail-documents)
- [Tables (13)](#tables-13)
  - [By function](#by-function)
  - [How data flows between tables](#how-data-flows-between-tables)
  - [Two storage patterns](#two-storage-patterns)
  - [Two evaluation subsystems](#two-evaluation-subsystems)
- [Functions (17)](#functions-17)
- [Indexes (56)](#indexes-56)
- [Key Design Patterns](#key-design-patterns)
- [Infrastructure](#infrastructure)

---

## Detail Documents

| Document                                       | What it covers                                |
|------------------------------------------------|-----------------------------------------------|
| `ledger-architecture-database-tables.md`       | 13 table schemas — columns, types, SQL        |
| `ledger-architecture-database-functions.md`    | 17 Postgres functions — full SQL, active/unused status |
| `ledger-architecture-database-indexes.md`      | 56 indexes, extensions, triggers, RLS, realtime, cron |

---

## Tables (13)

### By function

| Category   | Table                          | Purpose                                                     | Used in Code? |
|------------|--------------------------------|-------------------------------------------------------------|---------------|
| Storage    | `documents`                    | Source of truth — full content, all fields as real columns   | Yes           |
| Storage    | `document_chunks`              | Search index — chunked content with embeddings              | Yes           |
| Storage    | `document_versions`            | Content snapshots before each update                        | Yes           |
| Storage    | `embedding_models`             | Model registry — tracks which model generated which vectors | Yes           |
| Caching    | `query_cache`                  | Cached query embeddings — avoids repeat OpenAI API calls    | Yes           |
| History    | `audit_log`                    | Append-only change tracking (partitioned by year)           | Yes           |
| Security   | `agents`                       | Agent registry (Phase 6 — table exists, not enforced)       | No            |
| Ingestion  | `ingestion_queue`              | Async file processing pipeline (Phase 4.6 — table only)    | No            |
| Evaluation | `search_evaluations`           | Raw search telemetry — every search auto-logged             | Yes           |
| Evaluation | `search_evaluation_aggregates` | Daily summaries of search telemetry                         | No (no cron)  |
| Evaluation | `eval_golden_dataset`          | 144 curated test cases (query + tags) for search evaluation | Yes           |
| Evaluation | `eval_golden_judgments`        | Graded relevance judgments per (query, doc) — TREC 0–3 scale| Yes           |
| Evaluation | `eval_runs`                    | Stored eval results — metrics, config, per-query detail     | Yes           |

### How data flows between tables

```
documents ──< document_chunks     (1:N, CASCADE delete)
documents ──< document_versions   (1:N, snapshot before update)
documents ──< audit_log           (1:N, no FK — survives deletion)
documents >── embedding_models    (N:1, which model embedded this doc)

query_cache >── embedding_models  (N:1, which model generated the cached embedding)
ingestion_queue >── documents     (N:1, links to created doc on completion)

search_evaluations ──> search_evaluation_aggregates  (daily cron crunches raw → summary)
eval_golden_dataset ──< eval_golden_judgments        (1:N, CASCADE — one judgment per doc per query)
eval_golden_judgments >── documents                  (N:1, CASCADE — judgments follow the doc)
eval_golden_dataset ──> eval_runs                    (test cases scored → results stored)
```

### Two storage patterns

**Documents table** — stores full text. Has a keyword index (`search_vector`, auto-generated tsvector) for word matching. No AI embedding — the full document is never sent to OpenAI.

**Document chunks table** — stores pieces of each document (max 2000 chars, 200 char overlap). Each chunk has an AI embedding (1536-number vector from OpenAI). Linked to parent document by `document_id`.

How search uses both:
- Vector search → hits chunks (by embedding similarity)
- Keyword search → hits documents (by word matching)
- Both return the same document ID

### Two evaluation subsystems

**Production monitoring (passive).** `search_evaluations` records every search silently — query, results, latency. `search_evaluation_aggregates` crunches those into daily summaries. These have no concept of "correct" — just raw data.

**Controlled evaluation (manual).** `eval_golden_dataset` holds 144 curated queries with tags. `eval_golden_judgments` holds the answer key as graded relevance judgments (TREC 4-level: 0 not relevant, 1 related, 2 relevant, 3 highly relevant) — one row per (query, doc) pair, with `judged_at`, `judged_by`, and `notes` for audit. `eval_runs` stores graded metric results. These compare search output against known-correct answers using `hit_threshold=2` for rate metrics (hit rate, first-result, recall, MRR) and the full `2^grade - 1` gain function for NDCG.

They're independent but designed to feed each other: spot failures in production logs → add to golden set → next eval run catches it.

---

## Functions (17)

| Category      | Count | What they do                                                  |
|---------------|-------|---------------------------------------------------------------|
| Document ops  | 6     | create, update, update_fields, delete, restore, purge         |
| Search        | 4     | vector, keyword, hybrid (RRF), smart retrieval                |
| Maintenance   | 7     | aggregation, cleanup (3 tables), partition, trigger, purge    |

All document writes go through RPC functions — never direct `.update()` on the documents table. The functions handle transactions (document + chunks + audit = atomic), version snapshots, and domain syncing.

See `ledger-architecture-database-functions.md` for full SQL.

---

## Indexes (56)

| Table                          | Count | Key indexes                                           |
|--------------------------------|-------|-------------------------------------------------------|
| `documents`                    | 12    | GIN on search_vector (keyword search), btree on domain/type/project |
| `document_chunks`              | 10    | 6 HNSW indexes (1 global + 5 per-domain) for vector search |
| `audit_log` + partitions       | 12    | btree on document_id, agent, domain (x3 for parent + 2 partitions) |
| `query_cache`                  | 4     | HNSW on embedding (semantic cache), btree on last_used_at |
| `document_versions`            | 3     | btree on document_id + version_number                 |
| `search_evaluations`           | 4     | btree on created_at, feedback, zero-result filter     |
| `search_evaluation_aggregates` | 3     | btree + unique on date                                |
| Other (4 tables)               | 8     | PKs, GIN on tags, status filter on ingestion_queue    |

See `ledger-architecture-database-indexes.md` for full SQL.

---

## Key Design Patterns

- **Document-chunk separation** — content in `documents`, search index in `document_chunks`. Full documents are too big for embeddings to capture meaning well, so they get split into focused chunks. The full text stays intact for keyword search and display.

- **Denormalized domain on chunks** — domain is copied from the parent document onto each chunk. Redundant, but necessary — HNSW vector indexes can't filter via subqueries, so the domain must be on the chunk row itself. Synced automatically by `document_update_fields`.

- **Soft delete** — deleting a document sets `deleted_at` instead of removing the row. All queries filter `WHERE deleted_at IS NULL`. After 30 days, `document_purge` removes it for real. This gives you a window to undo mistakes.

- **Partitioned audit** — `audit_log` is partitioned by year so it scales without slowing down queries. Has no FK to documents — intentional, so the audit trail survives even when a document is permanently deleted.

- **Transactional writes** — creating or updating a document inserts the document row, all chunk rows, and an audit log entry in one atomic operation via RPC. If any step fails, nothing is committed. No orphaned chunks, no missing audit entries.

- **SHA-256 hashing** — every document's content is hashed. When you update a document, the hash tells you whether the content actually changed. If it didn't, skip re-chunking and re-embedding — saves OpenAI API calls and time.

- **No JSONB metadata** — every field is a real column with CHECK constraints. This means the database enforces valid values (you can't set domain to "invalid"), queries are fast (indexed columns vs JSONB lookups), and the schema is self-documenting. JSONB is only used where structure is genuinely dynamic: audit diffs, eval run details, agent permissions.

---

## Infrastructure

| Component     | Status                                                        |
|---------------|---------------------------------------------------------------|
| RLS           | Enabled on all 14 tables. Service role = full access, anon = blocked. Per-agent policies Phase 6. |
| Extensions    | pgvector 0.8.0, pgcrypto 1.3, pgtap 1.3.3 + 4 Supabase auto-enabled |
| Triggers      | 1 — `set_updated_at` on documents (BEFORE UPDATE)            |
| Realtime      | Enabled on `documents` only. No listener code yet (Phase 5). |
| pg_cron       | **Not installed.** 6 maintenance functions exist but none are scheduled. Phase 7. |
