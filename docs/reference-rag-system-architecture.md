# Production RAG System — Architecture Reference

> A complete guide to building Retrieval-Augmented Generation systems. Explains what each piece is, why it exists, and how it connects to the rest. Based on 2025-2026 industry practices.

---

## Table of Contents

- [What is a RAG System?](#what-is-a-rag-system)
- [Starting a New RAG Project](#starting-a-new-rag-project) — decision guide, build order, cost estimation
- [System Overview](#system-overview) — architecture diagram, feature inventory
  - [Ingestion](#ingestion--how-knowledge-gets-into-the-system) | [Storage](#storage--where-knowledge-lives) | [Search](#search--what-happens-when-someone-searches) | [Evaluation](#evaluation--how-we-know-if-search-is-working) | [Observability](#observability--monitoring-the-system-in-production) | [Access Control](#access-control--who-can-see-what) | [Security](#security--protecting-the-system-at-every-layer)
- **Detailed Sections:**
  1. [Ingestion Pipeline](#1-ingestion-pipeline)
  2. [Storage Layer](#2-storage-layer) — ERD, all table schemas, indexes
  3. [Query Pipeline](#3-query-pipeline) — search modes, multi-stage retrieval, scoring
  4. [Evaluation](#4-evaluation) — metrics, golden dataset, eval pipeline, feedback loop, production infrastructure
  5. [Quality Improvement](#5-quality-improvement) — levers, A/B testing, interpreting results
  6. [Observability](#6-observability) — monitoring, alerting, tools
  7. [Access Control](#7-access-control) — patterns, multi-tenant, implementation
  8. [Scaling](#8-scaling) — index tuning, caching, milestones
  9. [Security](#9-security) — threats, defenses, defense-in-depth
  10. [API Layer](#10-api-layer) — how agents talk to the system
  11. [Deployment & Infrastructure](#11-deployment--infrastructure)
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

**Job:** Take raw documents and prepare them for search.

**Why it exists:** You can't search a PDF directly by meaning. You need to extract the text, split it into searchable pieces, and convert those pieces into numbers that represent their meaning.

### Pipeline Flow

```
Source → Extract → Hash → Chunk → Count → Enrich → Cache Check → Embed → Format → Store

  PDF     "Revenue   SHA-256   [chunk1]  423     +context   cached?   [0.02,   "[0.02,  INSERT
  Web      grew 15%  match?    [chunk2]  tokens  summary    yes→skip  -0.01,   -0.01,   doc +
  Text     in Q3..." skip if   [chunk3]          prepend    no→API     0.04]    0.04]"   chunks
  Audio              same                                                                + audit
```

### Step 1: Extraction

Convert any file format to plain text while preserving structure.

| Source | Tool | What it extracts |
|---|---|---|
| PDF | Unstructured, LlamaParse | Text + headings + tables + page numbers |
| HTML/Web | Scrapers, Firecrawl | Clean text without nav/footer/ads |
| Audio | Whisper (OpenAI) | Transcription with timestamps |
| Images | Vision models, OCR | Descriptions or text content |
| Code | Language parsers | Functions, classes, with structure preserved |

**For text-only systems:** Skip this step entirely — content is already text.

### Step 2: Content Hashing

SHA-256 hash of the extracted text. Compare against stored hash:
- **Match** → content hasn't changed. Skip chunking, embedding, everything below. Saves time and API costs.
- **Different** → content changed. Proceed with re-processing.

### Step 3: Chunking

Split text into smaller pieces so embeddings are accurate to individual topics.

**Why chunk?** A chunk about "database indexing" will match a search about indexes much better than a 50-page architecture doc where indexing is mentioned once on page 37. Focused text = better embeddings = better search.

| Strategy | How it works | Best for | Config |
|---|---|---|---|
| **Recursive character** | Split hierarchically: paragraphs → sentences → words. Falls through to next level if a piece is still too big. | **Default for most content** | 512 tokens, 50-100 overlap |
| **Header-based** | Split on heading boundaries (H1-H6). Each section becomes a chunk. | Structured markdown/wiki docs | Respects heading hierarchy |
| **Semantic** | Embed each sentence. Split where cosine similarity between consecutive sentences drops. | Mixed-topic documents | Similarity threshold 0.75-0.85 |
| **Code-aware** | Parse AST. Split on function/class boundaries. | Source code | Language-specific parser |
| **Fixed-size** | Split every N tokens regardless of content. | Uniform processing, simple baseline | 512 tokens, 50-100 overlap |

**Production default:** Recursive character splitting at 512 tokens with 50-100 token overlap.

**Overlap explained:** Chunks share text at their boundaries. If a sentence spans two chunks, both chunks contain the full sentence. This prevents "lost context at the seam" — where important information falls between two chunks and neither has the full picture.

```
Chunk 1: "...database uses HNSW indexes for fast vector search."
                                    ↕ overlap ↕
Chunk 2: "HNSW indexes for fast vector search. They build a layered graph..."
```

### Step 4: Token Counting

Count tokens in each chunk. Stored as `token_count` on the chunk. Used later when assembling context for the LLM — you need to know how much space each chunk takes to stay within the context window budget.

### Step 5: Chunk Context Enrichment (Contextual Retrieval)

#### The problem

When a document gets chunked, each chunk loses its context. A chunk that says "It validates the token and returns the user ID" is meaningful when you're reading the full auth middleware document — you know "it" means the auth middleware. But stored alone as a chunk, "it" could mean anything. The embedding for that chunk is vague, so search struggles to match it to queries like "how does auth validation work?"

#### What chunk context enrichment does

Also known as "contextual retrieval" (Anthropic, 2024). We use "chunk context enrichment" because it more accurately describes the operation — enriching chunks with document context at ingestion time, before embedding. The industry name describes the goal (better retrieval), not the action.

Before embedding each chunk, you send the chunk + the full document to an LLM and ask: "What is this chunk about in the context of the whole document?" The LLM returns a short summary — one or two sentences. That summary gets prepended to the chunk text before embedding.

```
Without: "Revenue increased 15% year-over-year..."
With:    "From Acme Q3 2025 earnings report, financial section: Revenue increased 15%..."
```

A search for "Acme financial performance" will now find this chunk even though the original text never mentions "Acme" or "financial."

#### How it affects the embedding

The embedder doesn't have prompts. You just concatenate the summary + chunk into one string and pass that string as input. The embedder turns whatever text you give it into a 1536-number vector. It doesn't know or care that the first sentence is a summary and the rest is the original chunk. It just sees one piece of text — and produces a better vector because it had more context to work with.

Think of it like filing a document in a cabinet. Without context, the label says "validates token, returns user ID" — could go in any folder. With context, the label says "auth middleware — validates token, returns user ID" — you know exactly where to file it and exactly when to pull it out.

#### What gets stored

Three separate columns on the chunks table, each serving a different purpose:

| Column            | What it holds                                | Who uses it                    |
|-------------------|----------------------------------------------|--------------------------------|
| `context_summary` | The LLM-generated summary alone              | Developers (inspect, regenerate) |
| `content`         | The original chunk text alone                | The user (what they see in results) |
| `embedding`       | Vector of the combined summary + chunk text  | Search (finding matches)       |

The user never sees the summary. Search uses the enhanced embedding to find better matches, then returns the original chunk content.

The full document is never embedded as one piece — it's too big. Only chunks get embedded. The summary just enriches each chunk's embedding so it's more findable.

#### What chunk context enrichment does NOT do

- Does not change search logic — same vector search, same keyword search, same RRF fusion
- Does not help ranking — if the right doc is found at position 5, it stays at position 5 (that's what a reranker fixes)
- Does not change what the user sees — results still show the original chunk content
- Does not run at search time — summaries are generated once at ingestion and stored

#### Chunk context enrichment vs reranking

These are complementary, not competing:

- **Chunk context enrichment** makes chunks easier to *find* — improves recall and hit rate
- **Reranking** makes found results easier to *order* — improves MRR and first-result accuracy
- They stack: 49% fewer failed retrievals from chunk context enrichment alone, 67% with both combined

#### Impact and cost

**Impact:** 49% fewer failed retrievals. 67% with reranking added.

**Cost:** One LLM call per chunk during ingestion. Not free, but the cost is paid once per document write — not per search. Summaries only need regeneration when document content changes (which already triggers re-chunking).

### Step 6: Embedding Cache Check

Before calling the embedding API, check if identical content was already embedded:
- Key: `content_hash + embedding_model_id`
- **Hit** → reuse the cached vector. Skip API call. Saves money.
- **Miss** → proceed to Step 7.

Particularly valuable during re-ingestion: if you update a document's metadata but not its content, the chunks don't need re-embedding.

### Step 7: Embedding

Convert each chunk's text to a vector (array of numbers) via an embedding API.

| Model | Dimensions | Quality | Cost | When to use |
|---|---|---|---|---|
| **OpenAI text-embedding-3-small** | 1536 | Good | $0.02/M tokens | Budget-friendly default |
| **Voyage-3-large** | 1024 | Best commercial | $0.06/M tokens | When quality matters most |
| **Cohere embed-v3** | 1024 | Strong multilingual | $0.10/M tokens | Multi-language corpora |
| **BGE-M3** | 1024 | Best open-source | Free (self-hosted) | Privacy-sensitive, no API dependency |

**Important:** All chunks must use the same embedding model. Mixing models gives garbage search results — the numbers mean different things. Track `embedding_model_id` per chunk.

### Step 8: Vector Formatting

Convert the number array to the format the database expects. Postgres pgvector stores vectors as strings:
```
number[]: [0.021, -0.007, 0.045]  →  string: "[0.021,-0.007,0.045]"
```

Reading back from the database requires the reverse conversion.

### Step 9: Transactional Write

Save everything to the database in one atomic transaction:
- INSERT document row (content, metadata, hash)
- INSERT chunk rows (text, embedding, strategy, token_count)
- INSERT audit log entry (who, what, when)

If any step fails, nothing is committed. No orphaned chunks, no document without its search index, no missing audit trail.

### Migration & Re-Processing

When you need to change how documents are processed (new embedding model, different chunking strategy):

| Scenario | What to do |
|---|---|
| **New embedding model** | Re-embed all chunks with new model. Don't mix old and new embeddings. Track model_id per chunk to know what needs re-processing. |
| **New chunking strategy** | Re-chunk and re-embed all documents. Old chunks are deleted, new ones created. Content in documents table is unchanged. |
| **Schema change** | Side-by-side migration: create new tables alongside old, migrate data, verify, then drop old tables. System stays live throughout. |
| **Bulk re-ingestion** | Use embedding cache — unchanged content reuses cached vectors. Only changed content calls the API. |

---

## 2. Storage Layer

**Job:** Store documents, chunks, embeddings, and supporting data.

**Why it exists:** The database is the source of truth. Documents live here permanently. Chunks and embeddings are derived (can be regenerated). The database also handles transactions, audit trails, and access control.

### Entity-Relationship Diagram

```
┌──────────────┐     ┌────────────────────┐     ┌──────────────────┐
│  documents   │────<│  document_chunks   │     │ embedding_models │
│              │     │                    │────>│                  │
│ id (PK)      │     │ document_id (FK)   │     │ id (PK)          │
│ name (UNIQUE)│     │ chunk_index        │     │ provider         │
│ content      │     │ content            │     │ model_name       │
│ content_hash │     │ embedding vector(N)│     │ dimensions       │
│ domain       │     │ fts tsvector (GEN) │     └──────────────────┘
│ source_type  │     │ domain (denorm)    │
│ deleted_at   │     │ context_summary    │
│ created_at   │     │ token_count        │
└──────┬───────┘     └────────────────────┘
       │
       ├───<  document_versions (content snapshots before each update)
       ├───<  audit_log (every change tracked, partitioned by year)
       └───<  document_permissions (who can access what — Phase 6)

Standalone tables:
  query_cache                    — cached query embeddings (avoid repeat API calls)
  embedding_models               — model registry (dimensions, provider, default)
  agents                         — agent registry (auth, permissions, rate limiting)
  search_evaluations             — every search logged with results and feedback
  eval_golden_dataset            — known-correct query/answer pairs for testing
  search_evaluation_aggregates   — daily summaries of search quality
  eval_runs                      — stored results from golden dataset eval runs
  ingestion_queue                — async file processing pipeline
```

### Why separate documents from chunks?

**Documents** are the source of truth — complete content in one row. You never lose data.

**Chunks** are the search index — small pieces optimized for embedding similarity. They're derived from documents and can be regenerated anytime (new chunking strategy, new embedding model, etc.).

This separation is the industry-standard RAG pattern used by LangChain, LlamaIndex, Pinecone. It means you can change how search works without touching your data.

### Why denormalize domain on chunks?

HNSW vector indexes (the fast search indexes) can't use subqueries in WHERE clauses. You can't write `WHERE document_id IN (SELECT id FROM documents WHERE domain = 'project')` — the index won't be used. So the domain is copied onto each chunk, allowing per-domain partial indexes. This is the standard pattern used by Pinecone, Weaviate, and Qdrant.

### Tables

> Full column definitions, SQL CREATE statements, indexes, functions, triggers, and RLS: see **`reference-rag-database-schemas.md`**

| Group      | Table                            | What it stores |
|------------|----------------------------------|----------------|
| Storage
|            | **documents**                    | Source of truth — full content, metadata, lifecycle |
|            | **document_chunks**              | Search index — small pieces with embeddings, derived from documents |
|            | **embedding_models**             | Model registry — which model produced which embeddings |
| Caching
|            | **query_cache**                  | Cached query embeddings — avoid repeat API calls |
| History
|            | **audit_log**                    | Every change tracked — who, what, when, old values. Partitioned by year. |
|            | **document_versions**            | Full content snapshots before each update |
| Security
|            | **agents**                       | Agent registry — auth, permissions, rate limiting |
|            | **document_permissions**         | Per-document access control — who can read/write/admin |
| Ingestion
|            | **ingestion_queue**              | Async file processing pipeline — PDF, audio, images |
| Evaluation
|            | **search_evaluations**           | Raw search logs — every search recorded silently |
|            | **eval_golden_dataset**          | Known-correct test cases for automated evaluation |
|            | **search_evaluation_aggregates** | Daily summaries of search quality |
|            | **eval_runs**                    | Stored results from each golden dataset eval run |

### Key Design Decisions

**Document-chunk separation** — documents (your data) and chunks (search index) in separate tables. Chunks are derived — regenerate anytime with new strategy or model without touching content.

**Denormalized filter columns on chunks** — HNSW vector indexes can't use subqueries. Filter columns (domain, tenant_id, etc.) must be on the same table as the embedding. Standard pattern (Pinecone, Weaviate, Qdrant).

**Append-only audit with no FK** — audit_log has no foreign key to documents so it survives hard deletion. Partitioned by year for scale.

### Index Strategy

| Index type                   | On what                        | What it does |
|------------------------------|--------------------------------|--------------|
| **HNSW (vector)**            | chunk embeddings               | Fast approximate vector search (~5,250x faster than scanning) |
| **HNSW (per-partition)**     | chunk embeddings WHERE X = Y   | Filtered vector search without scanning all chunks |
| **HNSW (cache)**             | query_cache embedding          | Semantic cache lookup — find similar cached queries |
| **GIN (keyword)**            | chunk tsvector                 | Fast keyword/BM25 search |
| **B-tree (filters)**         | document classification columns| Filter queries by type, project, etc. |
| **B-tree (audit)**           | audit_log document_id + date   | Look up change history per document |
| **Partial (active)**         | documents WHERE deleted_at IS NULL | Skip soft-deleted rows automatically |
| **GIN (tags)**               | eval_golden_dataset tags       | Filter test cases by tag |

---

## 3. Query Pipeline

**Job:** When someone searches, find the best documents and return them.

**Why it exists:** The agent can't scan every document for every question. The query pipeline narrows thousands of documents down to the 5-10 most relevant in milliseconds.

### Search Modes

**Vector search** — find documents by meaning
- "How does authentication work?" finds OAuth docs even without the word "authentication"
- Works by comparing the mathematical similarity of the query embedding to chunk embeddings
- Uses HNSW index for speed (approximate nearest neighbor)

**Keyword search (BM25)** — find documents by exact words
- "pgvector HNSW" finds documents literally containing those words
- Critical for code identifiers, error messages, proper nouns
- Uses GIN index on tsvector column

**Hybrid search** — both combined, best of both worlds
- Run vector + keyword in parallel, merge results with RRF fusion
- Documents found by both methods rank highest
- **This is the production default** — pure vector search alone misses exact-term matches

### Multi-Stage Retrieval

```
Stage 1: RETRIEVE (cast a wide net)
  Vector search → top 100 candidates
  Keyword search → top 100 candidates

Stage 2: FUSE (combine rankings)
  RRF fusion → top 20-50
  Formula: score = 1/(60 + vector_rank) + 1/(60 + keyword_rank)
  Documents found by BOTH methods score highest

Stage 3: RERANK (precision filter)
  Cross-encoder model reads each (query, document) pair
  Re-scores based on deep understanding, not just embedding similarity
  → top 5-10 high-quality results

Stage 4: ASSEMBLE (prepare for LLM)
  Format the top results as context for the AI
  Respect token budget — don't overflow the context window
  → structured prompt with citations
```

**Why reranking matters:** Stage 1-2 retrieval is fast but approximate. A cross-encoder reranker reads the full query and document together, catching nuances that embedding similarity misses. Adding reranking is the **single biggest precision improvement** in most RAG systems.

### Scoring

**RRF (Reciprocal Rank Fusion)** — the zero-config default for combining search results

```
score(doc) = 1/(k + rank_in_vector) + 1/(k + rank_in_keyword)
k = 60 (smoothing constant — prevents #1 from dominating)
```

The score is a **ranking**, not a quality measure. A score of 0.033 doesn't mean "3.3% relevant" — it means "this is the top-ranked result." Don't apply quality thresholds to RRF scores.

**Cosine similarity** — the quality measure for vector search (0 to 1). A threshold of 0.25 means "at least somewhat related." Applied before fusion, not after.

---

## 4. Evaluation

**Job:** Measure whether search is actually working and track improvement over time.

**Why it exists:** Without evaluation you're guessing. Eval gives you a number: "search scores 78% — up from 65% last month." When you change something (threshold, chunking, model), eval tells you if it helped or hurt.

### What a production eval system needs

| Component | What it is | Why you need it |
|---------------------------|--------------------------------------------|---------------------------------------------|
| Data collection
| **Auto-logging**          | Every search silently recorded to database | Raw data for all analysis — without it you're blind 
| **Explicit feedback**     | User/agent says "wrong" or "right" | Most accurate quality signal |
| **Implicit feedback**     | Detect patterns: zero results, repeated searches, low scores | Finds problems without user effort |
| **Per-type tracking**     | Which doc types/source types appear in results | Shows what content searches well vs poorly |
| Testing
| **Golden dataset**        | Known-correct query/expected-doc pairs | Makes evaluation repeatable and measurable |
| **Eval runner**           | Script that runs golden dataset and computes metrics | Turns test cases into scores |
| Metrics
| **Precision**             | % of results that are relevant | Measures noise in results |
| **Recall**                | % of relevant docs that were found | Measures completeness |
| **First-result accuracy** | Is #1 the right one? | Most important when agents act on top result |
| **Zero-result rate**      | % of searches that find nothing | Measures search failures |
| Infrastructure
| **Eval run storage**      | Each eval run saved with config + metrics + per-query detail | Track improvement over time, not just latest run |
| **Auto-compare**          | Each run compared to previous automatically | "Better or worse?" should be instant, not manual |
| **Regression detection**  | Flag when metrics drop below threshold | Catch problems before they reach users |
| **Daily aggregation**     | Raw logs → daily summaries, then purge raw | Keep trends without unbounded table growth |
| **Scheduled automation**  | Cron: aggregate daily, run eval weekly, grow golden set monthly | Eval that requires manual effort stops happening |
| **Feedback → golden set** | Production failures become new test cases | Golden dataset grows from real problems, not guesses |

### Three Levels of Evaluation

**Level 1: Retrieval quality** — did search find the right documents?

| Metric | What it measures | Target |
|---|---|---|
| **First-result accuracy** | Is #1 result the right one? | > 85% |
| **Context precision** | Are relevant chunks ranked higher than irrelevant ones? | > 80% |
| **Context recall** | Were all relevant docs found, or were some missed? | > 90% |
| **Zero-result rate** | How often search returns nothing when it shouldn't? | < 5% |

**Level 2: Generation quality** — did the AI give a good answer using what it found?

| Metric | What it measures | Target |
|---|---|---|
| **Faithfulness** | Is the answer supported by retrieved context, or did the AI make things up? | > 85% |
| **Answer relevancy** | Does the answer actually address the question that was asked? | > 80% |

**Level 3: End-to-end** — did the user get what they needed?

| Signal | How captured |
|---|---|
| **Explicit feedback** | User says "that was wrong" or "perfect" — most accurate but requires user effort |
| **Implicit signals** | Zero results, repeated searches (user retried), low scores, agent didn't use the results |

### Golden Dataset

A curated set of test cases with known-correct answers. This is what makes evaluation repeatable and measurable.

```
Example test cases:

  Query: "What is the database schema?"
  Expected docs: [architecture-database]
  Tags: [simple, architecture]

  Query: "How does hybrid search combine results?"
  Expected docs: [architecture-database-functions]
  Tags: [technical, search]

  Query: "What is the session handoff procedure?"
  Expected docs: [session-checkpoint-rule]
  Tags: [simple, behavioral]
```

**Building the golden dataset:**

| Step | What to do |
|---|---|
| **1. Seed** | Manually curate 50-100 query/expected-doc pairs from real use cases |
| **2. Categorize** | Tag each as: simple, multi-hop, reasoning, adversarial, out-of-scope |
| **3. Expand** | Use LLM to generate synthetic variations of existing queries |
| **4. Validate** | Human review of synthetic examples — discard low-quality |
| **5. Grow** | Production failures (bad searches) → human labels → add to golden set |

### Eval Pipeline

How to use the golden dataset to measure quality:

```
Change something (threshold, chunking, model)
         │
         ▼
Run all golden dataset queries through search
         │
         ▼
For each query: did the expected doc appear in results?
         │
         ▼
Compute metrics (precision, recall, first-result accuracy)
         │
         ▼
Compare to baseline score
         │
    ┌────┴────┐
    ▼         ▼
 Better    Worse
 Deploy    Reject
 Update    Investigate
 baseline  why
```

### Feedback Loop

How production data feeds back into improvement:

```
Every search → auto-log to search_evaluations
                        │
                        ▼
              Pattern analysis (weekly/monthly):
              - Which queries return nothing?
              - Which queries have low scores?
              - Which document types are found well/poorly?
              - Are repeated searches a sign of poor results?
                        │
                        ▼
              Recommendations:
              - "Lower threshold from 0.25 to 0.20 — too many empty results"
              - "Architecture docs = 85% precision, events = 40% — events need better descriptions"
              - "15% zero-result rate — missing content or bad chunking?"
                        │
                        ▼
              Test recommendation:
              - Change one variable
              - Re-run eval suite
              - Compare to baseline
              - Better → deploy. Worse → reject.
```

### Production Eval Infrastructure

The pieces above (metrics, golden dataset, feedback) describe *what* to measure. This section describes *how* to run evaluation in production — storing results, comparing runs, detecting regressions, and automating the cycle.

#### Eval Run Storage

Every time you run the golden dataset, the results must be stored — not just printed to console. Without stored history, you can't track improvement or detect regressions.

| What to store per run | Why |
|-----------------------|------------------------------------------------------|
| **Run timestamp**     | When was this eval executed 
| **Config snapshot**   | Exact settings: threshold, chunking strategy, embedding model, RRF k, reranker. Without this you can't reproduce results. |
| **Aggregate metrics** | Hit rate, first-result accuracy, recall, zero-result rate, avg latency |
| **Per-tag breakdown** | Metrics by query category (simple, conceptual, exact-term, etc.) — shows where improvements happen |
| **Per-query results** | Every query: what was returned, positions, scores, hit/miss. For drilling into specific failures. |
| **Missed queries**    | Which queries failed and what they got instead — the action list for improvement |

Stored in an `eval_runs` table (see Storage section for schema).

#### Auto-Compare

After each eval run, automatically compare against the most recent previous run:

```
Current run:    hit_rate=92%, first_result=55%, recall=80%
Previous run:   hit_rate=88%, first_result=46%, recall=74%
                        ↓
Diff:           hit_rate +4%, first_result +9%, recall +6%  ✓ ALL IMPROVED
```

If any metric drops, flag it as a regression:

```
Current run:    hit_rate=90%, first_result=42%, recall=82%
Previous run:   hit_rate=88%, first_result=46%, recall=74%
                        ↓
Diff:           hit_rate +2%, first_result -4% ⚠ REGRESSION, recall +8%
```

#### Regression Detection

| Severity | Condition | Action |
|---|---|---|
| **Warning** | Any metric drops > 2% from previous run | Investigate — may be noise or a real problem |
| **Block** | Any metric drops > 5% from baseline | Do not deploy — revert the change |
| **Critical** | Hit rate drops below 80% or zero-result rate exceeds 10% | Something is broken — investigate immediately |

#### Explicit Feedback Collection

An API tool/endpoint that records "this search result was wrong/right" during normal use:

| Field | What |
|---|---|
| query_text | The search that was evaluated |
| search_eval_id | FK to the original search_evaluations row |
| feedback | relevant, irrelevant, partial |
| agent | Who gave the feedback |

Feedback flows into the golden dataset: consistently-bad searches become new test cases.

#### Scheduled Automation

| Job | Frequency | What it does |
|---|---|---|
| **Auto-log aggregation** | Daily | Crunch raw search_evaluations into daily summaries |
| **Raw log cleanup** | Daily (after aggregation) | Delete raw rows older than 30 days |
| **Eval suite run** | Weekly or on code change | Run golden dataset, save to eval_runs, compare to previous |
| **Golden dataset growth** | Monthly | Review production failures, add new test cases |

#### CI/CD Integration

For automated systems, the eval runner can gate deployments:

```
Code change committed
         │
         ▼
Run eval suite (golden dataset)
         │
         ▼
Compare against baseline
         │
    ┌────┴────┐
    ▼         ▼
 All metrics    Any metric
 stable or      dropped > 5%
 improved       from baseline
    │               │
    ▼               ▼
 Deploy          Block deploy
                 Alert team
```

### Eval Tools

| Tool | What it does |
|---|---|
| **RAGAS** | LLM-based metrics (faithfulness, relevancy), synthetic test generation |
| **DeepEval** | Golden dataset synthesis, CI/CD integration, pytest plugin |
| **LangSmith** | Tracing + evaluation in one platform, dataset management |
| **Arize Phoenix** | Embedding visualization, drift detection, production monitoring |
| **Built-in** | eval_runs table + eval runner script — no external tool needed for basic eval |

---

## 5. Quality Improvement

**Job:** Make search better over time using data, not guesses.

**Why it exists:** A RAG system that isn't measured doesn't improve. The eval system tells you *where* quality is weak. Quality improvement tells you *what to change* and *how to test it*.

### Levers to Pull

Ordered by typical impact (highest first):

| Lever | What to test | What improves | Typical impact |
|---|---|---|---|
| **Reranker** | None vs cross-encoder | Precision, first-result accuracy | Biggest single gain |
| **Chunk context enrichment** | With vs without context prepend | Recall, precision | 49% fewer failed retrievals |
| **Chunking strategy** | Recursive vs semantic vs header-based | All metrics | Varies by content type |
| **Embedding model** | OpenAI vs Voyage vs BGE-M3 | Precision, cost | Model-dependent |
| **Chunk size** | 256 vs 512 vs 1024 tokens | Recall | Smaller = more precise, more chunks |
| **Similarity threshold** | 0.2 vs 0.25 vs 0.3 | Precision/recall tradeoff | Lower = more results, more noise |
| **RRF k** | 20 vs 60 vs 100 | How vector vs keyword contributes | Subtle |
| **Top-K** | 5 vs 10 vs 20 | Precision vs coverage | More = more context, more noise |
| **Chunk overlap** | 0% vs 10% vs 20% | Recall at boundaries | Small effect |

### How to Run an A/B Test

```
1. BASELINE
   Run golden dataset with current settings
   Record: precision, recall, first-result accuracy
   Save as baseline score

2. CHANGE ONE VARIABLE
   Example: threshold from 0.25 → 0.20
   Keep everything else identical

3. RUN AGAIN
   Same golden dataset, same metrics
   Record: new precision, recall, first-result accuracy

4. COMPARE
   Better across the board → deploy the change
   Better on some, worse on others → investigate which queries improved/degraded
   Worse across the board → reject, revert

5. UPDATE BASELINE
   If deployed, the new scores become the baseline for the next test
```

### Interpreting Results

| Result | What it means | What to do |
|---|---|---|
| Precision went up, recall stayed same | Less noise in results without losing coverage | Deploy — clear win |
| Recall went up, precision went down | Finding more docs but also more irrelevant ones | Might need reranking to filter noise |
| First-result accuracy went up | Top result improved — agents will perform better | Deploy — high-value improvement |
| Zero-result rate went down | Fewer failed searches | Deploy — users were hitting dead ends |
| All metrics went down | The change made things worse | Revert immediately |
| Mixed results by query type | Some types improved, others degraded | Consider per-type settings or different approach |

### Priority Order for a New System

1. **Start with defaults** — recursive chunking at 512 tokens, hybrid search, threshold 0.25
2. **Add eval first** — auto-logging + golden dataset before optimizing anything
3. **Add reranking** — biggest single improvement, low effort
4. **Add chunk context enrichment** — second biggest improvement, needs LLM calls at ingestion
5. **Tune threshold** — use eval data to find the sweet spot
6. **Experiment with chunk size** — only if eval shows boundary issues
7. **Try different embedding models** — only if precision is still low after above

---

## 6. Observability

**Job:** Know what's happening in production — performance, cost, errors, degradation.

**Why it exists:** Without monitoring, you won't know something is broken until a user complains. Observability catches problems early: latency spikes, cost overruns, quality degradation, cache inefficiency.

### What to Monitor

| Metric | Why | Target | Alert when |
|---|---|---|---|
| **Search latency** (p50/p95/p99) | Is search fast enough? | p95 < 2s | p95 > 3s |
| **Embedding latency** | Is the API slowing down? | < 500ms | > 1s |
| **Cost per query** | Budget tracking | Track trend | Sudden spike or > budget |
| **Cost per day** | Total spend | Track trend | > 2x average |
| **Cache hit rate** | Is caching saving money? | 60-80% at maturity | < 40% |
| **Zero-result rate** | Are searches failing? | < 5% | > 10% |
| **Score distributions** | Are results high-quality? | Track median over time | Median drops > 20% |
| **Error rates** | Timeouts, API failures | < 1% | > 5% |
| **Embedding drift** | Has content meaning shifted? | Monthly check | Centroid shift > threshold |

### Cost Breakdown

For budgeting and optimization:

| Component | What to track | How to reduce |
|---|---|---|
| **Embedding API** | Tokens per day, calls per day | Query cache (60-80% hit rate), embedding cache for re-ingestion |
| **LLM generation** | Tokens per response, responses per day | Semantic response cache, smaller context windows, smart retrieval |
| **Database** | Storage size, query count | Cleanup jobs, archive old versions, purge soft-deletes |
| **Reranking API** | Calls per search (if using cloud reranker) | Only rerank top-K, not all results |

### Alerting Thresholds

| Severity | Condition | Action |
|---|---|---|
| **Warning** | p95 latency > 2s, cache hit rate < 50%, zero-result rate > 5% | Investigate at next opportunity |
| **Error** | API errors > 5%, cost spike > 3x daily average | Investigate immediately |
| **Critical** | Search completely failing, API key expired, database down | Page on-call / fix immediately |

### Tools

| Tool | What it does |
|---|---|
| **Langfuse** | Open-source tracing, cost tracking, RAGAS integration |
| **LangSmith** | End-to-end tracing, prompt playground, evaluation |
| **Arize Phoenix** | Embedding visualization, drift detection |
| **Datadog LLM Observability** | Enterprise dashboards, RAGAS evaluations built in |
| **Built-in** | `search_evaluations` table + periodic analysis script (no external tool needed) |

---

## 7. Access Control

**Job:** Ensure agents and users only see documents they're authorized to access.

**Why it exists:** In a multi-user or multi-agent system, not everyone should see everything. A client's financial data shouldn't appear in a different client's search results. An agent with read-only access shouldn't be able to delete documents.

**Key principle:** Enforce at retrieval time, **before** context reaches the LLM. If the AI sees unauthorized content, it may leak it in its response — even if you filter after generation.

### Filtering Patterns

| Pattern | How | When to use | Tradeoff |
|---|---|---|---|
| **Pre-filter** | Add permission WHERE clauses to search queries | Large corpus, most docs restricted | Fastest — unauthorized docs never searched |
| **Post-filter** | Retrieve top-K, then filter by permissions | Small corpus, most docs accessible | Simpler but may return fewer results than expected |
| **Row-Level Security** | Database policies enforce automatically on every query | pgvector/Postgres deployments | Strongest guarantee — even raw SQL is filtered |

### Authorization Models

| Model | How it works | Best for |
|---|---|---|
| **RBAC (Role-Based)** | Assign roles (admin, editor, viewer), roles have permissions | Simple organizations with clear roles |
| **ABAC (Attribute-Based)** | Rules based on attributes (department=engineering AND clearance=high) | Complex policies, fine-grained control |
| **ReBAC (Relationship-Based)** | Permissions based on relationships (user → member of → team → owns → document) | Google Zanzibar model, social graphs |

### Multi-Tenant Isolation

| Level | How | Isolation strength | Cost |
|---|---|---|---|
| **Database per tenant** | Separate database for each tenant | Strongest — complete isolation | Highest — N databases to manage |
| **Schema per tenant** | Separate schema within one database | Strong — namespace isolation | Medium |
| **Row-level (RLS)** | Shared tables, policies filter by tenant_id | Standard — most common pattern | Lowest — one database |

### Implementation Pattern

```
1. Agent authenticates (JWT or API key)
2. System resolves: who is this agent? what can they access?
3. Search query includes permission filter:
   WHERE document_id IN (
     SELECT document_id FROM document_permissions
     WHERE principal_id = agent_id
   )
4. Only permitted documents appear in results
5. Context sent to LLM contains only authorized content
```

### Tools

| Tool | What it does |
|---|---|
| **Cerbos** | Policy-as-code, generates query plans for vector store filters |
| **OPA (Open Policy Agent)** | General-purpose policy engine |
| **Permit.io** | RBAC/ABAC/ReBAC with API |
| **Supabase RLS** | Built-in row-level security for Postgres/pgvector |

---

## 8. Scaling

**Job:** Keep search fast as the dataset grows.

### When to worry

| Scale | Approach |
|---|---|
| < 100K vectors | pgvector, single node, HNSW — no special tuning needed |
| 100K - 1M | Add HNSW tuning, embedding cache, semantic cache |
| 1M - 10M | Partition tables, add read replicas, or move to Qdrant/Milvus |
| 10M+ | Dedicated vector database, sharded, with quantization |

### HNSW Index Tuning

| Parameter | What it controls | Default | Tune when |
|---|---|---|---|
| `m` | Connections per node | 16 | Higher = better recall, more memory |
| `ef_construction` | Build-time search width | 128 | Higher = better index, slower builds |
| `ef_search` | Query-time search width | 64-200 | Higher = better recall, slower queries |

### Caching Layers

| Cache | What | Saves |
|---|---|---|
| **Query embedding cache** | Cached embeddings for repeated queries | API calls ($) |
| **Semantic response cache** | Full responses for similar queries | LLM calls ($$) |
| **Embedding cache** | Vectors keyed by content hash | Re-embedding unchanged docs |

---

## 9. Security

**Job:** Protect the system from attacks that exploit the unique properties of RAG — untrusted content becomes LLM input, embeddings can leak information, search can be weaponized for data extraction.

**Why RAG security is different from regular app security:** In a traditional app, user input is the attack surface. In RAG, *stored documents* are also an attack surface — because they get retrieved and fed to the LLM as context. An attacker who can insert a document can control what the AI says.

Full research: `docs/research/2026-03-31-rag-security-best-practices.md`

### Ingestion Security

| Threat | Defense |
|---|---|
| **Prompt injection in documents** — attacker embeds "ignore previous instructions" in a document. When retrieved, LLM follows it. | **Content sanitization:** scan for instruction-like patterns at ingestion. **Instruction hierarchy:** configure LLM to treat retrieved content as DATA, never INSTRUCTION (reduces success from 73% to 23%). |
| **Content poisoning** — insert misleading documents to degrade search quality. 5 poisoned docs in millions can achieve 90% attack success. | **Provenance tracking:** record who created each document, when, from what source. **Trust scoring:** weight results by source trustworthiness. **Embedding anomaly detection:** flag chunks with unusual embedding patterns. |
| **Malicious file uploads** — hidden content in PDFs, macro-laden Office docs, oversized files. | **Input validation:** magic byte verification, hidden content stripping, file size limits, content-type verification. |

### Retrieval Security

| Threat | Defense |
|---|---|
| **Data exfiltration** — sensitive content (API keys, PII, credentials) leaks through LLM responses. | **Content classification at ingestion:** flag documents containing sensitive data. **PII redaction:** detect and redact before sending context to LLM (tools: Microsoft Presidio). **Retrieval guardrails:** post-retrieval, pre-LLM check. |
| **Bulk extraction** — attacker crafts queries to systematically extract all stored content. | **Rate limiting:** cap queries per agent per hour. **Extraction detection:** monitor for semantic similarity between consecutive queries (systematic scanning pattern). |

### Output Security

| Threat | Defense |
|---|---|
| **Hallucination with authority** — LLM invents information and presents it as if it came from a retrieved document. | **Groundedness checking:** verify answer claims against retrieved context via NLI model or LLM-as-judge. Flag unsupported claims. |
| **Sensitive data in responses** — even if retrieval is filtered, the LLM may include data it shouldn't. | **Output scanning:** post-generation filter for PII, credentials, instruction leakage. **Canary tokens:** dummy documents in corpus — if LLM outputs their content, retrieval is leaking. |

### Infrastructure Security

| Threat | Defense |
|---|---|
| **Credential exposure** — database keys, API keys leaked or hardcoded. | **Secrets management:** all credentials in environment variables or Vault/KMS. Never in code. Rotation schedule. |
| **Unencrypted data** — vectors and content readable if database is breached. | **Encryption:** AES-256 at rest, TLS 1.3 in transit. Supabase handles this by default. |
| **Shared service key** — one key with full access used by all agents. | **Per-agent authentication:** JWT or API key per agent. Principle of least privilege. |
| **Audit tampering** — modifying audit entries to cover tracks. | **Audit immutability:** append-only RLS policy — no UPDATE/DELETE even for service_role. Optional: cryptographic hash chaining. |

### API & Cost Security

| Threat | Defense |
|---|---|
| **Cost attack** — flood searches to burn embedding/LLM API credits. | **Rate limiting:** per-agent, per-hour caps. **Cost-aware throttling:** track actual spend per query, pause agent if budget exceeded. |
| **MCP tool abuse** — agent calls delete in a loop or bulk-modifies content. | **Rate limiting on writes.** **Protection levels** on sensitive documents. **Confirmation gates** on destructive operations. |

### Supply Chain Security

| Threat | Defense |
|---|---|
| **Embedding provider sees your data** — every document sent to OpenAI/Cohere for embedding. | **Self-host embedding model** for sensitive data (BGE-M3, all-MiniLM). **Zero-data-retention agreements** for cloud providers. |
| **LLM provider sees retrieved context** — all search results sent as context during generation. | **Zero-data-retention agreements.** **Data classification:** don't retrieve highly sensitive docs for general queries. |
| **Model version drift** — provider updates model, embeddings change silently. | **Pin model versions.** **Track embedding_model_id per chunk.** **Verify checksums** on model artifacts. |

### Defense-in-Depth Architecture

Security at every layer, not just at the perimeter:

```
Ingestion:    Content sanitization → Input validation → Provenance tracking
                                          ↓
Storage:      Encryption at rest → RLS → Audit immutability
                                          ↓
Retrieval:    Rate limiting → Pre-filter permissions → PII redaction
                                          ↓
Generation:   Instruction hierarchy → Groundedness check → Output scanning
                                          ↓
API:          Per-agent auth → Rate limiting → Cost tracking
```

---

## 10. API Layer

**Job:** Provide the interface that agents and applications use to interact with the RAG system.

**Why it exists:** The ingestion pipeline, storage layer, and search pipeline are internal. The API layer is how the outside world talks to your system — searching, adding documents, managing content.

### Protocols

| Protocol | What it is | When to use |
|---|---|---|
| **MCP (Model Context Protocol)** | Standard protocol for AI agents to call tools. Agent sees tool descriptions and calls them by name with typed parameters. | When your RAG system is used by AI agents (Claude, GPT, etc.) |
| **REST API** | HTTP endpoints (GET /search, POST /documents, etc.) | Web apps, mobile apps, scripts, integrations |
| **SDK / Library** | Direct function calls in code | Same-language applications, backend services |
| **CLI** | Command-line interface | Admin tasks, scripts, cron jobs, manual operations |

### Standard Tool Set

A production RAG API typically exposes:

| Category | Tools |
|---|---|
| **Search** | Hybrid search (default), vector-only search, keyword-only search, smart context retrieval |
| **CRUD** | Create document, update content, update fields, delete, restore |
| **Read** | List documents (with filters), get by ID, get by name |
| **Eval** | Log feedback, run eval suite, get metrics |
| **Admin** | Cleanup cache, purge deleted docs, re-embed documents |

### Design Principles

- **Validation at the boundary** — validate all input with schemas (Zod, JSON Schema) before it reaches internal code
- **Protection checks** — enforce document protection levels (immutable, protected, guarded) before mutation operations
- **Error handling** — structured error responses, never raw exceptions to clients
- **Thin wrappers** — API tools are thin. Business logic lives in the library layer or database, not in the API handler

---

## 11. Deployment & Infrastructure

**Job:** Run the system reliably in production.

**Why it exists:** Code that runs on your laptop isn't production. Deployment covers how to run, monitor, backup, and maintain the system.

### Components to Deploy

| Component | What it is | How it runs |
|---|---|---|
| **Database** | Postgres + pgvector with tables, indexes, functions, RLS | Hosted (Supabase, AWS RDS, Neon) or self-hosted |
| **MCP / API server** | The API layer that agents call | Process on server, stdio transport (MCP), or HTTP server (REST) |
| **Embedding API** | External service or self-hosted model | Cloud API (OpenAI, Voyage) or local (Ollama, BGE-M3) |
| **Cron jobs** | Scheduled maintenance tasks | System cron, GitHub Actions, or database scheduled jobs |

### Scheduled Maintenance

| Job | Frequency | What it does |
|---|---|---|
| **Cache cleanup** | Daily or weekly | Remove query cache entries unused for N days |
| **Version cleanup** | Weekly | Keep only last N content versions per document |
| **Soft-delete purge** | Daily | Hard-delete documents past grace period (e.g., 30 days) |
| **Audit partition** | Yearly | Create next year's audit_log partition |
| **Eval run** | Weekly or on-change | Run golden dataset, compute metrics, compare to baseline |

### Backup Strategy

| What | How | Frequency |
|---|---|---|
| **Database** | pg_dump or managed backup (Supabase automatic) | Daily |
| **Embeddings** | Stored in database — included in database backup | With database |
| **Golden dataset** | In database + version-controlled export | With database + git |
| **Config / secrets** | Environment variables, not in code | Separate secrets backup |

### Environment Configuration

All configuration via environment variables:

| Variable | What |
|---|---|
| `DATABASE_URL` or `SUPABASE_URL` | Database connection |
| `SUPABASE_SERVICE_ROLE_KEY` | Database authentication (replace with per-agent JWT in production) |
| `OPENAI_API_KEY` | Embedding API |
| `EMBEDDING_MODEL` | Which model to use (default in database, override here) |
| `RERANKER_API_KEY` | Reranking service (if using cloud reranker) |

### Health Checks

| Check | What it verifies | Frequency |
|---|---|---|
| Database connection | Can reach Postgres | Every request / every 30s |
| Embedding API | OpenAI/Voyage responds | Every 5 minutes |
| Search function | Run a test query, verify non-empty results | Every 5 minutes |
| Disk/storage | Database size within limits | Daily |

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
| **Threshold** | 0.25 cosine similarity (vector component only) |
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
  chunkText() — split into pieces (max 2000 chars, 200 char overlap)
        │
  for each chunk:
        │
        generateEmbedding(chunk.content) — send chunk text to OpenAI
        │
        store chunk + embedding in document_chunks table
```

The full document is stored in the `documents` table as plain text (for keyword search via Postgres `search_vector`). It is never embedded — only chunks are.

- **Vector search** hits chunks (by embedding similarity)
- **Keyword search** hits documents (by word matching)
- **Hybrid search** runs both, combines with RRF fusion, returns document IDs

### Chunk Context Enrichment (in progress — Phase 4.5.2)

**Current state:** The `context_summary` column exists on `document_chunks` but is empty. Implementation in progress — see spec `docs/superpowers/specs/2026-04-03-chunking-and-context-enrichment-design.md`.

**Pipeline (being implemented):**

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
        Concatenate: "Auth middleware JWT validation step. It validates the token and returns the user ID."
        │
        generateEmbedding(combined text) — send to OpenAI
        │
        Store embedding (of combined text) in embedding column
```

**Cost estimate:** One LLM call per chunk per document save. For a 10,000-char document chunked into 10 pieces (at 1000-char chunks), that's 10 LLM calls at ingestion. At gpt-4o-mini pricing (~$0.15/1M input tokens), roughly $0.003 per document. The cost is paid once — not on every search. Summaries only regenerate when document content changes (which already triggers re-chunking).

### Reranking (built, disabled — Phase 4.5.1)

**Current state:** Cohere cross-encoder reranker built and tested (`src/lib/search/reranker.ts`). Disabled due to privacy concern — personal knowledge base data sent to third party. Code remains for future local cross-encoder.

**Eval results with Cohere reranker:** +15.3% first-result accuracy, +10.5% recall, +0.119 MRR, +0.122 NDCG.

**How chunk context enrichment and reranking work together:**

- Chunk context enrichment makes chunks easier to *find* — improves recall and hit rate
- Reranking makes found results easier to *order* — improves MRR and first-result accuracy
- They're complementary: 49% fewer failed retrievals from chunk context enrichment alone, 67% with both
