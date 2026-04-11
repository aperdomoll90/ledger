# Production RAG System — Architecture Reference

> A complete guide to building Retrieval-Augmented Generation systems. Explains what each piece is, why it exists, and how it connects to the rest. Based on 2025-2026 industry practices.

---

## Table of Contents

- [What is a RAG System?](#what-is-a-rag-system)
- [Starting a New RAG Project](#starting-a-new-rag-project) — decision guide, build order, cost estimation
- [System Overview](#system-overview) — architecture diagram, feature inventory
  - [Ingestion](#ingestion--how-knowledge-gets-into-the-system) | [Storage](#storage--where-knowledge-lives) | [Search](#search--what-happens-when-someone-searches) | [Evaluation](#evaluation--how-we-know-if-search-is-working) | [Observability](#observability--monitoring-the-system-in-production) | [Access Control](#access-control--who-can-see-what) | [Security](#security--protecting-the-system-at-every-layer)
- **Core Pipeline:**
  - [Ingestion Pipeline](reference-rag-core-ingestion.md) — extraction, chunking, enrichment, embedding, transactional write
  - [Storage Layer](reference-rag-core-database-schemas.md) — ERD, table schemas, indexes, design decisions
  - [Query Pipeline](reference-rag-core-query-pipeline.md) — search modes, multi-stage retrieval, scoring
- **Quality:**
  - [Evaluation](reference-rag-quality-evaluation.md) — metrics, golden dataset, eval pipeline, feedback loop, infrastructure
  - [Quality Improvement](reference-rag-quality-improvement.md) — levers, A/B testing, interpreting results
- **Security & Access:**
  - [Access Control](reference-rag-security-access-control.md) — patterns, multi-tenant, implementation
  - [Security](reference-rag-security-defenses.md) — threats, defenses, defense-in-depth
- **Operations:**
  - [Observability](reference-rag-operations-observability.md) — monitoring, alerting, tools
  - [Scaling & Caching](reference-rag-operations-scaling.md) — index tuning, rate limiting, five-layer caching, invalidation
  - [Deployment & Infrastructure](reference-rag-operations-deployment.md)
- **Interface:**
  - [API Layer](reference-rag-interface-api.md) — how agents talk to the system
- [Production Defaults (2026)](#production-defaults-2026)
- [Ledger Implementation](#ledger-implementation) — current pipeline, chunk context enrichment, reranking

---

## What is a RAG System?

A RAG (Retrieval-Augmented Generation) system gives AI agents access to knowledge they weren't trained on. Instead of relying only on what the model learned during training, the agent can **search** a knowledge base and use what it finds to give accurate, grounded answers.

**The core idea:** When someone asks a question, find the relevant documents first, then give them to the AI along with the question. The AI generates its answer based on real data, not guesses.

**Without RAG:** "What's our database schema?" → AI guesses based on training data (probably wrong)
**With RAG:** "What's our database schema?" → Search finds the architecture doc → AI reads it → accurate answer

### Why not just put everything in the AI's context?

AI models have limited context windows (how much text they can process at once). Even with 1M token windows, you can't load every document for every query — it's slow, expensive, and the AI gets confused with too much irrelevant context. RAG solves this by finding **only the relevant pieces** and sending just those.

## Starting a New RAG Project

Decision guide based on your project's characteristics:

### What's your corpus size?

| Corpus size | What to prioritize |
|---|---|
| **< 100 docs** | Simple setup. pgvector, paragraph chunking, hybrid search. Skip reranking, skip chunk context enrichment. Focus on getting eval working first. |
| **100 - 10K docs** | Full pipeline. Add reranking, chunk context enrichment, query cache. Tune threshold with golden dataset. |
| **10K - 100K docs** | Performance matters. Per-domain indexes, semantic cache, embedding cache for re-ingestion. Monitor latency. |
| **100K+ docs** | Scale matters. Consider dedicated vector DB (Qdrant/Milvus), sharding, quantization, read replicas. |

### What type of content?

| Content type | Chunking strategy | Special considerations |
|---|---|---|
| **Structured docs** (markdown, wiki) | Header-based or recursive | Headings are natural chunk boundaries |
| **Prose** (articles, reports) | Recursive character | 512 tokens, 50-100 overlap |
| **Code** | Code-aware (AST-based) | Split on function/class boundaries, preserve structure |
| **Mixed formats** (PDF, audio, images) | Recursive + extraction pipeline | Need ingestion queue, multi-format extraction |
| **Short content** (notes, rules, < 500 tokens) | No chunking needed | One chunk per document, skip the complexity |

### What query patterns?

| Pattern | Search strategy |
|---|---|
| **Conceptual** ("how does auth work?") | Vector search is essential |
| **Exact terms** ("pgvector HNSW error") | Keyword search is essential |
| **Both** | Hybrid search (production default) |
| **High precision needed** (agents act on top result) | Add reranking — biggest precision gain |

### Build order for any RAG project

```
1. Storage     → documents + chunks tables, basic indexes
2. Ingestion   → chunking + embedding + transactional writes
3. Search      → hybrid search (vector + keyword + RRF)
4. API         → tools/endpoints for search + CRUD
5. Eval        → auto-logging + golden dataset (BEFORE tuning)
6. Tune        → reranking, chunk context enrichment, threshold tuning
7. Security    → auth, rate limiting, content sanitization
8. Scale       → caching, per-domain indexes, monitoring
```

### Cost Estimation

Ballpark costs for OpenAI text-embedding-3-small ($0.02 per 1M tokens):

| Corpus size | Initial embedding cost | Monthly search cost (100 queries/day) |
|---|---|---|
| **100 docs** (avg 2K tokens) | ~$0.004 | ~$0.12 (with 70% cache hit rate) |
| **1K docs** (avg 2K tokens) | ~$0.04 | ~$0.12 |
| **10K docs** (avg 2K tokens) | ~$0.40 | ~$0.12 |
| **100K docs** (avg 2K tokens) | ~$4.00 | ~$0.12 |

Search cost is dominated by query embedding, not corpus size. Cache dramatically reduces cost — 70% hit rate means only 30 queries/day actually call the API.

**LLM generation cost** (if using RAG for answer generation): depends on context size and model. ~$0.01-0.10 per query for Claude/GPT with 2-5K token context.

---

## System Overview

A RAG system has three pipelines, a storage layer, and cross-cutting concerns:

```
                    ┌─────────────────────────┐
                    │     DOCUMENT SOURCES     │
                    │  PDF, text, audio, web   │
                    └────────────┬────────────┘
                                 │
                                 ▼
 ┌──────────────────────────────────────────────────────────┐
 │                    INGESTION PIPELINE                     │
 │                                                          │
 │  Extract → Hash → Chunk → Enrich → Embed → Store        │
 └──────────────────────────┬───────────────────────────────┘
                            │
                            ▼
 ┌──────────────────────────────────────────────────────────┐
 │                     STORAGE LAYER                        │
 │                                                          │
 │  ┌────────────┐ ┌────────┐ ┌───────┐ ┌──────────────┐  │
 │  │ Documents  │ │ Chunks │ │ Cache │ │ Eval + Audit │  │
 │  │ (content)  │ │ (index)│ │(query)│ │  (tracking)  │  │
 │  └────────────┘ └────────┘ └───────┘ └──────────────┘  │
 └──────────────────────────┬───────────────────────────────┘
                            │
                            ▼
 ┌──────────────────────────────────────────────────────────┐
 │                     QUERY PIPELINE                       │
 │                                                          │
 │  Cache Check → Embed → Hybrid Search → Rerank → Deliver │
 │                        (vector+keyword)                  │
 └──────────────────────────┬───────────────────────────────┘
                            │
                            ▼
                    ┌─────────────────────────┐
                    │     AGENT / USER        │
                    │  Receives context +     │
                    │  generates response     │
                    └─────────────────────────┘

 CROSS-CUTTING (spans all layers):
 ┌────────────┬──────────┬───────────────┬──────────────────┐
 │  Security  │   Eval   │ Observability │  Access Control  │
 └────────────┴──────────┴───────────────┴──────────────────┘
```

Each layer can be understood and improved independently. A chunking improvement doesn't require changing search. A new embedding model doesn't require changing the database schema.

### Feature Inventory — What a Production RAG System Needs

Every feature grouped by function. Each entry: what it is, where it lives in a system, and a brief how/why.

#### Ingestion — How knowledge gets into the system

Steps in order as data moves through the pipeline:

| Feature                      | What is it |
|------------------------------|------------|
| Extraction & preparation
| **1. Extraction**            | Convert source files (PDF, audio, images, web) into plain text with structure preserved. |
| **2. Content hashing**       | SHA-256 of text. If hash matches what's stored, skip everything below — nothing changed. |
| Chunking & enrichment
| **3. Chunking**              | Split text into smaller pieces so embeddings are accurate to individual topics. Default: 512 tokens, 50-100 overlap. |
| **4. Token counting**        | Count tokens per chunk for context window budgeting later. |
| **5. Chunk context enrichment** | LLM adds one-line context summary per chunk before embedding (also known as "contextual retrieval"). Captures meaning + position. 49% fewer failed retrievals. |
| Embedding & storage
| **6. Embedding cache check** | Check if this content was already embedded. Hit → reuse vector, skip API call. |
| **7. Embedding**             | Convert chunk text to vector (array of numbers) representing meaning via embedding API. |
| **8. Vector formatting**     | Convert number[] to string format Postgres expects: `[0.02,-0.01,0.04]`. |
| **9. Transactional write**   | Save document + chunks + audit in one atomic transaction. If any step fails, nothing commits. |

#### Storage — Where knowledge lives

| Feature                          | What it is |
|----------------------------------|------------|
| Tables
| **Documents table**              | Source of truth. One row per document, full content, all fields as real columns. |
| **Chunks table**                 | Search index derived from documents. Each doc has 1+ chunks with embeddings. Regenerate anytime. |
| **Embedding models table**       | Registry tracking which model produced which embeddings. Prevents mixing incompatible vectors. |
| **Query cache table**            | Cached query embeddings keyed by normalized text. Same query = 1 API call, rest are cache hits. |
| **Agents table**                 | Agent registry for auth, permissions, rate limiting. Who can access the system and what they can do. |
| **Audit log table**              | Every change tracked: who, what, when, old values. Append-only, partitioned by time, survives deletion. |
| **Document versions table**      | Full content saved before each update. Roll back to any version. |
| Indexes
| **Vector search index (HNSW)**   | Makes "search by meaning" fast. Pre-organizes vectors so only nearby ones are checked. |
| **Per-partition vector index**   | One search index per domain/tenant. Searching one partition skips all others. |
| **Keyword search index (GIN)**   | Makes "search by exact words" fast. Maps words to rows. Handles stemming ("running" → "run"). |
| **Cache similarity index**       | Makes query cache smarter. Similar queries share cached vectors, not just identical ones. |
| Constraints & patterns
| **Document-chunk separation**    | Content in documents, search index in chunks. Chunks are derived — change strategy without touching data. |
| **Soft delete**                  | `deleted_at` timestamp. Undo mistakes, hard-delete after grace period. |

#### Search — What happens when someone searches

When a query comes in, it moves through these steps in order:

| Feature                   | What it is |
|---------------------------|------------|
| Prepare the query
| **1. Query caching**      | Check if this query (or a similar one) was searched before. Hit → skip embedding, reuse cached vector. |
| **2. Query embedding**    | Convert query text to a vector using the same embedding model as the chunks. |
| Retrieve candidates (hybrid search — vector + keyword in parallel)
| **3. Vector search**      | Find chunks whose meaning is similar to the query. Handles "how does auth work" → finds OAuth docs. |
| **4. Keyword search**     | In parallel. Find chunks containing the exact query words. Handles "pgvector HNSW" → finds those terms. |
| **5. RRF fusion**         | Combine vector + keyword results into one ranked list. Documents found by both methods rank highest. |
| Rank and filter
| **6. Reranking**          | A second model reads each (query, document) pair together and re-scores. Much more accurate than step 3-4 alone. Biggest precision gain. |
| Deliver
| **7. Smart retrieval**    | Small doc → return full content. Large doc → return matched chunk + neighbors. Saves tokens. |

#### Evaluation — How we know if search is working

Without evaluation you're guessing. Eval records what happens, measures quality with known-correct test cases, and tracks improvement over time. When you change something (threshold, chunking, model), eval tells you if it got better or worse.

| Feature                   | What it is |
|---------------------------|------------|
| Data collection
| **Auto-logging**          | Every search silently logged: query, results, scores, timing. Raw material for all analysis. |
| **Explicit feedback**     | User says "wrong" or "perfect". Most accurate signal, optional — no friction on normal searches. |
| **Implicit feedback**     | Detect problems from patterns: zero results, repeated searches, low scores, unused results. |
| **Per-type tracking**     | Track which document types search well vs poorly. Shows what needs better chunking or descriptions. |
| Testing
| **Golden dataset**        | Curated set of known-correct query/expected-doc pairs. Run periodically to get a measurable score. |
| **Eval runner**           | Script that runs golden dataset, computes metrics, saves to eval_runs table, compares to previous run. |
| Metrics
| **Precision**             | % of returned results that are relevant. Low = too much noise in results. |
| **Recall**                | % of relevant docs that were found. Low = search is missing documents. |
| **First-result accuracy** | Is #1 the right one? Most important when agents act on the top result. |
| Infrastructure
| **Eval run storage**      | Every eval run saved to database with config, metrics, per-query detail. Track improvement over time. |
| **Auto-compare**          | Each run automatically compared to previous. Highlights improvements and regressions. |
| **Regression detection**  | Flag when metrics drop — warning at >2%, block deploy at >5% from baseline. |
| **Daily aggregation**     | Raw search logs crunched into daily summaries. Keep trends, purge raw data after 30 days. |
| **Scheduled automation**  | Cron: daily aggregation + cleanup. Weekly: eval suite run. Monthly: golden dataset growth. |

#### Observability — Monitoring the system in production

Know what's happening — performance, cost, errors, degradation. Without observability you won't know something broke until a user complains.

| Feature                 | What it is |
|-------------------------|------------|
| Performance
| **Latency tracking**    | p50/p95/p99 response times. Which component is the bottleneck? |
| **Cache hit rate**      | % queries served from cache. Target: 60-80% at maturity. |
| Cost
| **Cost tracking**       | Embedding + LLM tokens per day, cost per query. Where is money going? |
| Health
| **Score distributions** | Median scores over time. Downward trend = something degraded. |
| **Embedding drift**     | Monthly comparison of embedding averages. Large shift = content changed, may need re-embedding. |
| Maintenance
| **Auto-cleanup**        | Scheduled jobs: remove stale cache entries, keep last N versions, purge soft-deleted docs. |

#### Access Control — Who can see what

Ensures agents and users only see documents they're authorized to access. Must be enforced before the LLM sees the content — if the AI reads unauthorized data, it may leak it in its response.

| Feature                   | What it is |
|---------------------------|------------|
| Database level
| **Row-Level Security**    | Database policies filter rows per user/role automatically. Strongest guarantee. |
| Query level
| **Pre-filter at search**  | Permission WHERE clauses added to search queries. Unauthorized docs never appear in results. |
| **Document permissions**  | Per-document access table: who (user/group/role) can read/write/admin each document. |
| Principle
| **Enforce at retrieval**  | Always check permissions before context reaches the LLM, never after generation. |

#### Security — Protecting the system at every layer

RAG systems have unique attack surfaces because untrusted content (documents) becomes LLM input. Security must be applied at every layer, not bolted on at the end. Full reference: `docs/research/2026-03-31-rag-security-best-practices.md`

| Threat                           | What it is |
|----------------------------------|------------|
| Ingestion threats
| **Prompt injection via content** | Attacker embeds instructions in a document. When retrieved, LLM follows them. Primary RAG attack vector. |
| **Content poisoning**            | Insert misleading documents to degrade search quality. 5 poisoned docs in millions = 90% attack success. |
| **Input validation**             | Malicious file uploads, hidden content in PDFs, SQL injection through vector store queries. |
| Storage threats
| **Embedding inversion**          | Extracting original text from stored embeddings. New techniques (2026) achieve zero-shot inversion. |
| **Audit tampering**              | Modifying audit entries to cover tracks. Needs append-only enforcement, not just convention. |
| **Infrastructure exposure**      | Database credentials, API keys, unencrypted vectors at rest or in transit. |
| Search & retrieval threats
| **Data exfiltration**            | Sensitive content (API keys, PII, credentials) in documents leaks through LLM responses. |
| **Bulk extraction**              | Attacker crafts queries to systematically extract all stored content via search results. |
| API & cost threats
| **Denial of service**            | Flood searches to burn embedding/LLM API credits. No rate limiting = unlimited cost exposure. |
| **Tool abuse**                   | Agent calls delete/update in loops, or bulk-modifies content. |
| Supply chain threats
| **Embedding model provider**     | Provider sees all your content during embedding API calls. Self-host for sensitive data. |
| **LLM provider**                 | Provider sees all retrieved context during generation. Zero-data-retention agreements required. |

| Defense                          | What it is |
|----------------------------------|------------|
| Ingestion defenses
| **Content sanitization**         | Strip instruction-like patterns, hidden content, anomalous embeddings at ingestion time. |
| **Provenance tracking**          | Record who created each document, when, from what source. Trust scoring per source. |
| **Content classification**       | Flag documents containing PII, credentials, or sensitive data at ingestion. |
| Retrieval defenses
| **Instruction hierarchy**        | LLM treats retrieved content as DATA, never as INSTRUCTION. Reduces attack success 73% → 23%. |
| **Retrieval guardrails**         | Post-retrieval, pre-LLM check: does this context contain sensitive data? |
| **PII redaction**                | Detect and redact personally identifiable information before sending context to LLM. |
| Output defenses
| **Output guardrails**            | Post-generation check: groundedness, sensitive data filtering, response validation. |
| **Canary tokens**                | Dummy documents in corpus. If LLM outputs their content, retrieval is leaking. |
| Infrastructure defenses
| **Per-agent authentication**     | JWT or API key per agent, not shared service_role key. Principle of least privilege. |
| **Rate limiting**                | Cap searches/writes per agent per hour. Cost-aware throttling tracking actual spend. |
| **Encryption**                   | AES-256 at rest, TLS 1.3 in transit. Secrets rotation via Vault/KMS. |
| **Audit immutability**           | Append-only audit log — no UPDATE/DELETE even for service_role. |

---

## 1. Ingestion Pipeline

**Job:** Take raw documents and prepare them for search. Extract text, split into searchable pieces, enrich with context, convert to embeddings, and store atomically.

**9-step pipeline:** Extract → Hash → Chunk → Count tokens → Enrich (LLM context summary) → Cache check → Embed → Format → Transactional write

> Full detail: **[reference-rag-core-ingestion.md](reference-rag-core-ingestion.md)**

---

## 2. Storage Layer

**Job:** Store documents, chunks, embeddings, and supporting data. The database is the source of truth.

**Key patterns:** Document-chunk separation (content vs search index), denormalized filter columns for HNSW index compatibility, append-only audit with no FK. 15 tables across storage, caching, history, security, ingestion, and evaluation.

> Full detail: **[reference-rag-core-database-schemas.md](reference-rag-core-database-schemas.md)**

---

## 3. Query Pipeline

**Job:** When someone searches, find the best documents and return them. Narrows thousands of documents to the 5-10 most relevant in milliseconds.

**Three search modes:** Vector (by meaning), keyword/BM25 (by exact words), hybrid (both combined, production default). **Four-stage retrieval:** Retrieve → Fuse (RRF) → Rerank (cross-encoder) → Assemble context. Reranking is the single biggest precision improvement in most RAG systems.

> Full detail: **[reference-rag-core-query-pipeline.md](reference-rag-core-query-pipeline.md)**

---

## 4. Evaluation

**Job:** Measure whether search is actually working and track improvement over time. Without evaluation you're guessing.

**Three levels:** Retrieval quality (did search find the right docs?), generation quality (did the AI give a good answer?), end-to-end (did the user get what they needed?). **Core components:** Auto-logging, golden dataset, eval runner, regression detection, scheduled automation, CI/CD gating.

> Full detail: **[reference-rag-quality-evaluation.md](reference-rag-quality-evaluation.md)**

---

## 5. Quality Improvement

**Job:** Make search better over time using data, not guesses. The eval system tells you *where* quality is weak. Quality improvement tells you *what to change* and *how to test it*.

**9 tuning levers** ordered by impact (reranker > chunk context enrichment > chunking strategy > embedding model > chunk size > threshold > RRF k > top-K > overlap). Covers A/B testing methodology, interpreting results, priority order for new systems, and implementation pitfalls.

> Full detail: **[reference-rag-quality-improvement.md](reference-rag-quality-improvement.md)**

---

## 6. Observability

**Job:** Know what's happening in production. Performance, cost, errors, degradation.

**Key metrics:** Search latency (p50/p95/p99), embedding latency, cost per query/day, cache hit rate (target 60-80%), zero-result rate (target <5%), score distributions, error rates, embedding drift. Three-tier alerting (warning, error, critical).

> Full detail: **[reference-rag-operations-observability.md](reference-rag-operations-observability.md)**

---

## 7. Access Control

**Job:** Ensure agents and users only see documents they're authorized to access. Enforce at retrieval time, before context reaches the LLM.

**Filtering patterns:** Pre-filter (WHERE clauses), post-filter (retrieve then check), Row-Level Security (database-enforced). **Auth models:** RBAC, ABAC, ReBAC. **Multi-tenant isolation:** database per tenant, schema per tenant, or row-level (RLS).

> Full detail: **[reference-rag-security-access-control.md](reference-rag-security-access-control.md)**

---

## 8. Scaling

**Job:** Keep search fast as the dataset grows.

**Scale thresholds:** <100K vectors (pgvector, no tuning), 100K-1M (HNSW tuning + caching), 1M-10M (partitioning/replicas), 10M+ (dedicated vector DB). **Five-layer cache architecture** (query embedding → search results → re-ranked context → summarized chunks → full LLM response) can reduce API costs 60-70% and latency 90%+. **Rate limiting:** proactive pacing (Bottleneck) + reactive retry (SDK).

> Full detail: **[reference-rag-operations-scaling.md](reference-rag-operations-scaling.md)**

---

## 9. Security

**Job:** Protect the system from RAG-specific attacks. Stored documents are an attack surface because they get retrieved and fed to the LLM as context.

**Threat categories:** Ingestion (prompt injection, content poisoning, malicious uploads), retrieval (data exfiltration, bulk extraction), output (hallucination, data leakage), infrastructure (credentials, encryption, audit tampering), API/cost (denial of service, tool abuse), supply chain (provider data exposure, model drift). Defense-in-depth at every layer.

> Full detail: **[reference-rag-security-defenses.md](reference-rag-security-defenses.md)**

---

## 10. API Layer

**Job:** Provide the interface that agents and applications use to interact with the RAG system.

**Protocols:** MCP (for AI agents), REST API (for web/mobile), SDK/Library (for backend), CLI (for admin/cron). **Standard tool set:** Search (hybrid, vector, keyword), CRUD, read, eval, admin. **Principles:** Validation at boundary, protection checks, structured errors, thin wrappers over business logic.

> Full detail: **[reference-rag-interface-api.md](reference-rag-interface-api.md)**

---

## 11. Deployment & Infrastructure

**Job:** Run the system reliably in production.

**Four components:** Database (Postgres + pgvector), MCP/API server, embedding API, cron jobs. Covers scheduled maintenance (cache cleanup, version cleanup, soft-delete purge, audit partitioning), backup strategy, environment configuration, and health checks.

> Full detail: **[reference-rag-operations-deployment.md](reference-rag-operations-deployment.md)**

---

## Production Defaults (2026)

If you're starting a new RAG system today, begin with these settings and tune from there:

| Component | Start with |
|---|---|
| **Chunking** | Recursive character, 512 tokens, 50-100 overlap |
| **Enrichment** | Chunk context enrichment (LLM context prepend per chunk) |
| **Embedding** | OpenAI text-embedding-3-small (budget) or Voyage-3-large (quality) |
| **Vector store** | pgvector + HNSW for < 5M vectors |
| **Search** | Hybrid: vector + BM25, RRF fusion (k=60) |
| **Reranking** | Cross-encoder on top 20 candidates |
| **Threshold** | Determine by sweep after pipeline changes (see eval docs); 0.25 is a reasonable starting point |
| **Caching** | Query embedding cache, semantic response cache at 0.90 threshold |
| **Evaluation** | Golden dataset 100+ examples, RAGAS metrics, auto-log all searches |
| **Monitoring** | Latency, cost, cache hit rate, zero-result rate |
| **Auth** | Per-agent JWT or API key, RLS on all tables |
| **Rate limiting** | Per-agent per-hour caps on searches and writes |
| **Encryption** | AES-256 at rest, TLS 1.3 in transit |
| **Backups** | Daily automated database backups |

---

## Ledger Implementation

How Ledger's RAG pipeline maps to the architecture above. Documents what exists, what's planned, and what each piece does.

### Current Pipeline

When a document is saved (`src/lib/documents/operations.ts`):

```
Document content (e.g. 10,000 chars)
        │
  chunkText() — recursive split (max 1000 chars, 200 char overlap)
        │
  for each chunk:
        │
        Send chunk + full document to LLM (gpt-4o-mini)
        "What is this chunk about in context of the whole document?"
        │
        LLM returns: "Auth middleware JWT validation step"
        │
        Store summary in context_summary column
        │
        Concatenate: summary + chunk text
        │
        generateEmbedding(combined text) — send to OpenAI
        │
        Store embedding (of combined text) in embedding column
```

The full document is stored in the `documents` table as plain text (for keyword search via Postgres `search_vector`). It is never embedded — only chunks are.

- **Vector search** hits chunks (by embedding similarity)
- **Keyword search** hits documents (by word matching)
- **Hybrid search** runs both, combines with RRF fusion, returns document IDs

**Chunk context enrichment** is active. Each chunk gets a one-line context summary from gpt-4o-mini before embedding, improving retrieval by ~49%. See spec `docs/superpowers/specs/2026-04-03-chunking-and-context-enrichment-design.md`.

**Bulk re-indexing:** After pipeline changes (new chunking strategy, enabling enrichment, new embedding model), re-index all documents through the current pipeline with `src/scripts/reindex.ts`:

```
npx tsx src/scripts/reindex.ts              # dry-run — shows what would change
npx tsx src/scripts/reindex.ts --execute    # re-index all documents
npx tsx src/scripts/reindex.ts --id 42 --execute  # re-index a single document
```

**Cost estimate:** One LLM call per chunk per document save. For a 10,000-char document chunked into 10 pieces (at 1000-char chunks), that's 10 LLM calls at ingestion. At gpt-4o-mini pricing (~$0.15/1M input tokens), roughly $0.003 per document. The cost is paid once — not on every search. Summaries only regenerate when document content changes (which already triggers re-chunking).

### Reranking (built, disabled — Phase 4.5.1)

**Current state:** Cohere cross-encoder reranker built and tested (`src/lib/search/reranker.ts`). Disabled due to privacy concern — personal knowledge base data sent to third party. Code remains for future local cross-encoder.

**Eval results with Cohere reranker:** +15.3% first-result accuracy, +10.5% recall, +0.119 MRR, +0.122 NDCG.

**How chunk context enrichment and reranking work together:**

- Chunk context enrichment makes chunks easier to *find* — improves recall and hit rate
- Reranking makes found results easier to *order* — improves MRR and first-result accuracy
- They're complementary: 49% fewer failed retrievals from chunk context enrichment alone, 67% with both
