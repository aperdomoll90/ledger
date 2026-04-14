# Ledger — Architecture Overview

> Last updated: 2026-04-14 (Session 42)

## Table of Contents

- [System Layers](#system-layers)
- [Architecture Documents](#architecture-documents)
- [Database](#database)
- [TypeScript](#typescript)
- [Rate Limiter](#rate-limiter)
- [MCP Tools](#mcp-tools)
- [Search](#search)
- [RAG Pipeline](#rag-pipeline-current)
- [Evaluation](#evaluation)
- [Documents](#documents)
- [Observability](#observability)
- [Repo Structure](#repo-structure)

## System Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  INGESTION — "How knowledge gets in"                            │
│  Extract text → Chunk (recursive)                               │
│  → [Rate Limiter] → Contextual Retrieval (gpt-4o-mini)         │
│  → [Rate Limiter] → Embed (text-embedding-3-small)             │
│  → Store (atomic RPC)                                           │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  STORAGE — "Where knowledge lives"                              │
│  documents (content) + document_chunks (search index)           │
│  + query_cache, audit_log, versions, eval tables                │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  SEARCH — "How knowledge gets to the agent"                     │
│  [Rate Limiter] → Query Embedding                               │
│  → Vector + Keyword → RRF Fusion                                │
│  → [Rate Limiter] → (Rerank) → Smart Retrieval                 │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP TOOLS — "The API agents call"                              │
│  16 tools: 3 search + 5 CRUD + 2 read + 6 deprecated           │
└─────────────────────────────────────────────────────────────────┘

Cross-cutting: Rate Limiting │ Error Handling │ Access Control │ Evaluation │ Observability │ Cost Tracking
```

**Design:** TypeScript is a thin client. It prepares data (chunk text, generate embeddings, hash content) and calls Postgres RPC functions. The database handles all business logic — transactions, audit trails, version snapshots, constraint enforcement.

## Architecture Documents

| Document                                            | What it covers                                                             |
|-----------------------------------------------------|----------------------------------------------------------------------------|
| **`ledger-architecture`** (this doc)                | System overview, how layers connect                                        |
| **`ledger-architecture-database`** (#138)           | 16 tables, columns, constraints, indexes                                   |
| **`ledger-architecture-database-functions`** (#139) | 24 Postgres functions — signatures, params, what they do                   |
| **`ledger-architecture-typescript`** (#140)          | 9 library modules, interfaces, dependency graph                            |
| **`ledger-architecture-mcp-tools`** (#141)          | 16 MCP tools — params, when to use each                                    |
| **`ledger-architecture-rag-features`** (#145)       | RAG feature map — every capability by function, where it lives             |

## Database

**16 tables** — `documents` (source of truth), `document_chunks` (search index), `audit_log` (change tracking, partitioned by year), `agents` (registry), `embedding_models` (model registry), `query_cache` (embedding cache), `semantic_cache` (layer 2 result cache), `document_versions` (content snapshots), `search_evaluations` (quality metrics), `search_evaluation_aggregates` (daily summaries), `eval_golden_dataset` (144 test cases), `eval_golden_judgments` (graded relevance), `eval_runs` (stored eval results), `ingestion_queue` (file processing pipeline), plus 2 audit partitions.

**24 Postgres functions** — 6 document operations (create, update, update_fields, delete, purge, restore), 4 search (vector, keyword, hybrid RRF, retrieve_context), 3 caching (semantic_cache_lookup, semantic_cache_store, semantic_cache_cleanup), 4 eval helpers (judgment CRUD, golden count), 7 utilities (auto-partition, cache cleanup, version cleanup, updated_at trigger, eval aggregation, eval cleanup, purge).

**Key patterns:**
- Document-chunk separation: content in `documents`, search index in `document_chunks`
- Soft delete: `deleted_at` column, 30-day grace, `document_purge` for hard delete
- Transactional writes: document + chunks + audit = atomic via RPC
- Denormalized domain on chunks: HNSW indexes can't use subqueries
- Two-step DISTINCT ON deduplication: inner subquery deduplicates chunks to one-per-document (forced ID ordering), outer query re-sorts by similarity and limits (Session 34 fix)

See: `ledger-architecture-database` (#138), `ledger-architecture-database-functions` (#139)

## TypeScript

**6 library modules** in `src/lib/`:

| Module                         | Responsibility                          | Depends on                 |
|--------------------------------|-----------------------------------------|----------------------------|
| `document-classification.ts`   | Types, interfaces, client types         | Nothing (root)             |
| `rate-limiter.ts`              | Proactive rate limiting (Bottleneck)    | Nothing (standalone)       |
| `embeddings.ts`                | Chunking, OpenAI embeddings, cache      | classification, rate-limiter |
| `document-fetching.ts`         | Read operations (direct SELECT)         | document-classification    |
| `document-operations.ts`       | Write operations (Postgres RPC)         | classification, embeddings |
| `ai-search.ts`                 | Vector, keyword, hybrid search          | classification, embeddings |

Additional modules:
- `chunk-context-enrichment.ts` — Contextual Retrieval (gpt-4o-mini context summaries per chunk), uses rate-limiter
- `reranker.ts` — Cohere cross-encoder reranking (built, disabled for privacy), uses rate-limiter

**Structural typing:** Library files use `ISupabaseClientProps`/`IOpenAIClientProps` instead of importing from heavy packages. Prevents Vitest heap OOM.

**Error handling (S37):** All 30 external API call sites audited. OpenAI calls wrapped with try/catch and input context. Cache operations log to stderr on failure (non-fatal). RPC errors include document IDs and query text. Fetching functions log to stderr instead of returning silent null/[].

Additional modules:
- `semantic-cache.ts` — Helpers for layer 2 semantic cache (parameter normalization, result parsing)

See: `ledger-architecture-typescript` (#140)

## Semantic Cache

Layer 2 cache: stores full search results keyed by query embedding similarity. When a query is semantically similar to a previously cached query (cosine similarity > 0.90), returns the cached results directly with zero additional database calls. Added in Session 37.

**How it works:**
1. After embedding the query (layer 1, query_cache), check `semantic_cache` table via HNSW nearest neighbor search
2. If a cached entry matches (same search mode, same parameters, similarity > 0.90, not expired), return its `cached_results` JSONB directly
3. If no match, run the full search pipeline, then store the results in the cache for future queries

**Cache invalidation (two mechanisms):**
- **Reverse index:** When a document is updated or deleted, `document_update` and `document_delete` RPCs delete all cache entries whose `source_doc_ids` array contains that document ID. Uses GIN index for fast lookup.
- **TTL:** Every entry expires after 7 days. `semantic_cache_cleanup()` purges expired entries.

**Applies to:** `searchByVector` and `searchHybrid`. Does not apply to `searchByKeyword` (no embedding to compare). Skipped when the reranker is enabled (different result ordering).

**Table:** `semantic_cache` (10 columns, HNSW + GIN + BTREE indexes)
**RPC functions:** `semantic_cache_lookup`, `semantic_cache_store`, `semantic_cache_cleanup`
**Spec:** `docs/superpowers/specs/2026-04-10-semantic-cache-design.md`

## Rate Limiter

Provider-agnostic proactive rate limiting using Bottleneck. Prevents 429 (Too Many Requests) errors by controlling request flow before they reach external APIs. Added in Session 37 after S36 bulk sync failure.

**Two layers of defense:**
1. **Proactive pacing** (Bottleneck): token bucket with reservoir, concurrency cap, minimum spacing. Prevents most 429s.
2. **Reactive retry** (OpenAI SDK built-in, maxRetries: 5): catches any that slip through with exponential backoff.

**Two singleton instances:**

| Instance         | Provider | Protects                                                          | Budget   |
|------------------|----------|-------------------------------------------------------------------|----------|
| `openaiLimiter`  | OpenAI   | `generateEmbedding()`, `generateContextSummaries()`               | Shared   |
| `cohereLimiter`  | Cohere   | `rerankResults()` (idle until reranker re-enabled)                | Separate |

**Adaptive header reading:** After each successful OpenAI call, reads `x-ratelimit-remaining-requests` from response headers. If remaining is lower than the reservoir thinks, adjusts downward automatically.

**Ingestion call flow:**
```
content → chunking → [openaiLimiter] → Contextual Retrieval
                                             │
                                      [openaiLimiter] → embedding → Supabase
```

**Search call flow:**
```
query → [openaiLimiter] → query embedding → hybrid search → [cohereLimiter] → rerank
```

**Spec:** `docs/superpowers/specs/2026-04-09-rate-aware-api-client-design.md`

## MCP Tools

**16 tools** (10 new + 6 deprecated wrappers):

| Category   | Tools                                                                                             |
|------------|---------------------------------------------------------------------------------------------------|
| Search     | `search_documents` (hybrid, default), `search_by_meaning` (vector), `search_by_keyword` (exact)   |
| CRUD       | `add_document`, `update_document`, `update_document_fields`, `delete_document`, `restore_document` |
| Read       | `list_documents`, `get_document_context` (smart retrieval)                                         |
| Deprecated | `search_notes`, `add_note`, `list_notes`, `update_note`, `update_metadata`, `delete_note`          |

**Protection checks** at MCP layer: immutable → block, protected/guarded → require `confirmed: true`, open → proceed.

See: `ledger-architecture-mcp-tools` (#141)

## Search

Three modes, all backed by Postgres functions:

| Mode             | Function                    | How it works                                       |
|------------------|-----------------------------|----------------------------------------------------|
| Hybrid (default) | `match_documents_hybrid`    | Vector + keyword, combined via RRF fusion          |
| Vector only      | `match_documents`           | Cosine similarity on chunk embeddings (HNSW)       |
| Keyword only     | `match_documents_keyword`   | Full-text search on tsvector (GIN)                 |

**Threshold:** 0.38 cosine similarity (applied to vector component before fusion, not to RRF score). Tuned via `eval:sweep` in Session 33.

**Smart retrieval:** `retrieve_context` returns full document for small docs, matched chunk + neighbors for large docs.

## RAG Pipeline (Current)

1. Query → [Rate Limiter] → OpenAI embedding (layer 1: `query_cache` handles this)
2. [Semantic Cache] → Check for similar cached query (layer 2, cosine > 0.90)
3. If cache HIT: return cached results (skip steps 4-5)
4. Hybrid search: HNSW vector (threshold 0.38) + GIN keyword → RRF fusion (k=60)
5. Optional Cohere reranking ([Rate Limiter] → built, disabled for privacy)
6. Store results in semantic cache (non-blocking)
7. Smart retrieval: full doc or chunk + neighbors

**Ingestion pipeline:**
1. Hash content (SHA-256 change detection)
2. Recursive chunking (1000 char max, 200 char overlap, headers → paragraphs → sentences → chars)
3. [Rate Limiter] → Contextual Retrieval (gpt-4o-mini generates 2-3 sentence summary per chunk)
4. [Rate Limiter] → Embed: `summary + "\n\n" + chunk.content` via text-embedding-3-small (1536 dims)
5. Atomic RPC write: document + all chunks + audit in one transaction

**Ingestion performance optimizations (benchmarked S38):**
Three optimizations reduce large-document ingestion from ~12 min to ~30 sec (25x speedup, 95% token reduction):

| Optimization             | What it does                                                              | Impact          |
|--------------------------|---------------------------------------------------------------------------|-----------------|
| Truncated context        | Document summary + header path + neighbors instead of full doc per chunk  | 65% faster, 95% fewer tokens |
| Parallel enrichment      | 10 concurrent LLM calls (requires truncated context to avoid TPM limit)   | 96% faster (combined with truncated) |
| Batch embeddings         | All chunks in 1-2 API calls instead of N sequential calls                 | Embedding 94% faster |

Key insight: truncated context must come first. It reduces per-call tokens from ~18K to ~1K, which unblocks parallelism by removing the TPM (Tokens Per Minute) bottleneck.

Benchmark script: `src/scripts/benchmark-ingestion.ts`. Results: `docs/benchmark-results.json`.

## Evaluation

- **144 golden test cases** (132 normal + 12 out-of-scope) with **1,146 graded judgments**
- **Tags:** simple, conceptual, exact-term, multi-doc, cross-domain, out-of-scope
- **Graded relevance:** TREC 4-level (0-3), `eval_golden_judgments` table, `HIT_THRESHOLD=2`
- **Metrics:** hit rate, first-result accuracy, recall, MRR, NDCG (`gain = 2^g - 1`), zero-result rate, out-of-scope accuracy
- **Advanced:** 95% confidence intervals (bootstrap), score calibration, coverage analysis
- **CLI:** `ledger eval` (run + save), `ledger eval --dry-run`, `ledger eval:sweep`, `ledger eval:judge` (interactive grading)
- **Auto-compare:** each run compared to previous, severity levels (ok/warning/block/critical)

**Current baseline (run 14, Session 36):** hit rate 96.2%, first-result 62.9%, recall 84.9%, MRR 0.749, NDCG 0.738

## Documents

**5 domains:** system, persona, workspace, project, general
**4 protection levels:** open, guarded, protected, immutable
**Sync:** driven by `is_auto_load` flag, not by domain

Every document has a unique `name` (NOT NULL, CHECK constraint enforces lowercase + hyphens). All fields are real columns with CHECK constraints — no JSONB metadata.

## Observability

Pipeline observability using self-hosted **Langfuse** (open-source LLM observability platform). Built on **distributed tracing**, a pattern from Google's Dapper paper (2010), standardized via **OpenTelemetry (OTel)**. Core concepts:

- A **trace** is one end-to-end operation (e.g., ingesting a document)
- **Spans** are timed sub-steps within a trace (e.g., chunking, enrichment, embedding)
- **Generations** are a Langfuse-specific span type for LLM calls, with token counts and cost

This is the same pattern used by Netflix, Uber, and Stripe for service observability. Langfuse adapts it for LLM pipelines, adding token usage and cost as first-class concepts alongside timing. Because it builds on OpenTelemetry, the instrumentation is vendor-neutral: swapping Langfuse for Datadog or Grafana Tempo means changing the exporter, not the instrumentation code.

**Infrastructure:** 6 Docker containers (web, worker, Postgres, ClickHouse, Redis, MinIO). Single exposed port: 9100. All other services internal to Docker network.

**SDK integration:** Three packages (`@langfuse/tracing`, `@langfuse/openai`, `@langfuse/otel`). OpenAI client wrapped via `observeOpenAI()` for automatic LLM/embedding call capture. Manual spans for non-API steps (chunking, DB writes).

**Graceful degradation:** When Langfuse env vars are absent, observability is silently disabled. Ledger works exactly as before. Observability is opt-in, not a dependency.

**What it tracks vs what the eval system tracks:**

| Concern               | Eval system                                  | Langfuse                                     |
|-----------------------|----------------------------------------------|----------------------------------------------|
| Core question         | "Are the right documents coming back?"       | "How long did it take and what did it cost?" |
| Metrics               | Hit rate, MRR, NDCG, recall                  | Latency per span, token usage, cost, errors  |
| Update frequency      | Periodic eval runs                           | Every pipeline invocation (always-on)        |

**Phasing:**

| Phase   | Scope                                                        | Status         |
|---------|--------------------------------------------------------------|----------------|
| Phase 1 | Ingestion traces (create/update document)                   | In progress    |
| Phase 2 | Search traces (query embedding, cache, search, RRF)         | Deferred       |
| Phase 3 | Eval traces (golden queries, eval runs)                     | Deferred       |
| Phase 4 | Alerting (budget thresholds, latency anomalies)             | Deferred       |

**Spec:** `docs/superpowers/specs/2026-04-14-observability-langfuse-design.md`

## Repo Structure

```
src/
├── cli.ts                         → Entry point (commander, 18 commands)
├── mcp-server.ts                  → MCP server (16 tools)
├── commands/                      → CLI command handlers
├── lib/
│   ├── documents/
│   │   ├── classification.ts      → Types and interfaces (root)
│   │   ├── fetching.ts            → Read operations
│   │   └── operations.ts          → Write operations
│   ├── search/
│   │   ├── ai-search.ts           → Vector, keyword, hybrid search
│   │   ├── embeddings.ts          → Chunking, embeddings, cache
│   │   ├── chunk-context-enrichment.ts → Contextual Retrieval summaries
│   │   ├── reranker.ts            → Cohere cross-encoder reranking
│   │   └── semantic-cache.ts      → Layer 2 cache helpers
│   ├── eval/
│   │   ├── eval.ts                → Scoring, metrics, comparison
│   │   ├── eval-store.ts          → Persistence (save/load runs)
│   │   ├── eval-advanced.ts       → CI, calibration, coverage
│   │   └── eval-judge-session.ts  → Interactive grading CLI
│   ├── config.ts                  → Config loading
│   ├── rate-limiter.ts            → Proactive rate limiting (Bottleneck)
│   ├── observability.ts           → Langfuse tracing init, helpers, shutdown
│   └── errors.ts                  → Typed errors, exit codes
├── scripts/
│   ├── reindex.ts                 → Bulk re-chunk + re-embed
│   ├── batch-grade.ts             → Batch grading script
│   ├── benchmark-ingestion.ts     → Ingestion performance benchmarks (5 modes)
│   ├── sync-local-docs.ts         → Bulk doc sync + create (bypasses MCP)
│   ├── drop-golden-query.ts       → Remove golden dataset entries
│   └── convert-judgments-to-graded.ts → One-time migration
├── migrations/                    → 000-009 SQL migrations
└── docker/
    └── langfuse/                  → Langfuse docker-compose + env template

tests/                             → 220 tests (16 files)
```
