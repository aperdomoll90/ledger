# Production RAG System — Scaling & Caching

> How to keep search fast as the dataset grows. Covers HNSW tuning, rate limiting, five-layer cache architecture, similarity thresholds, and cache invalidation. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

## When to Worry

| Scale | Approach |
|---|---|
| < 100K vectors | pgvector, single node, HNSW. No special tuning needed |
| 100K - 1M | Add HNSW tuning, embedding cache, semantic cache |
| 1M - 10M | Partition tables, add read replicas, or move to Qdrant/Milvus |
| 10M+ | Dedicated vector database, sharded, with quantization |

## HNSW Index Tuning

| Parameter | What it controls | Default | Tune when |
|---|---|---|---|
| `m` | Connections per node | 16 | Higher = better recall, more memory |
| `ef_construction` | Build-time search width | 128 | Higher = better index, slower builds |
| `ef_search` | Query-time search width | 64-200 | Higher = better recall, slower queries |

## Outbound API Rate Limiting

External API calls (embedding generation, LLM enrichment, reranking) are subject to provider rate limits (RPM = Requests Per Minute, TPM = Tokens Per Minute). Without proactive pacing, bulk operations (reindex, restore, large document ingestion) can overwhelm the API and trigger 429 errors.

**Production pattern (two layers):**
1. **Proactive pacing** (e.g., Bottleneck): token bucket with reservoir, concurrency cap, minimum spacing between requests. Prevents most 429s.
2. **Reactive retry** (SDK built-in): exponential backoff with jitter when 429s slip through. Most SDKs (OpenAI, Stripe, AWS) include this.

**Adaptive adjustment:** Read rate limit headers from API responses (`x-ratelimit-remaining-requests`) and adjust the pacer's budget downward when the provider reports fewer remaining requests than expected.

| Provider | Typical Limits (Tier 1) | Pacing Strategy                    |
|----------|-------------------------|------------------------------------|
| OpenAI   | 500 RPM, 200K TPM       | 90% of RPM limit as reservoir      |
| Cohere   | 100 RPM (trial)         | 90% of RPM limit as reservoir      |
| AWS      | Varies by service       | Adaptive token bucket (SDK built-in)|

## Caching Layers

A RAG pipeline has five cacheable stages, ordered from cheapest to most expensive. Each layer can be implemented independently. The compounding effect of multiple layers is significant: a system with all five can reduce API costs by 60-70% and cut latency by 90%+ on cache hits.

### Five-Layer Cache Architecture

| Layer | Cache Key                              | What is Cached                          | TTL Guidance        | Saves               |
|-------|----------------------------------------|-----------------------------------------|---------------------|----------------------|
| 1. Query embedding    | Exact query text (normalized)  | Embedding vector (e.g., 1536 floats)   | Days to weeks       | Embedding API call ($) |
| 2. Search results     | Semantic similarity of query embedding | Top-k document IDs + scores       | 1 hour baseline     | Full search pipeline ($$) |
| 3. Re-ranked context  | Hash of (query + retrieved doc IDs)    | Ordered document list post-reranking | 1 hour baseline  | Reranker API call ($) |
| 4. Summarized chunks  | Content hash of chunk text             | Compressed/summarized chunk text       | Until source changes | LLM summarization call ($$) |
| 5. Full LLM response  | Semantic similarity of full prompt     | Complete LLM-generated answer          | Domain-dependent    | LLM generation call ($$$) |

**Layer 1 (query embedding cache)** is the simplest: same query text = same embedding. No similarity matching needed, just exact text lookup. Most systems normalize the query (lowercase, trim whitespace) to increase hit rate.

**Layer 2 (semantic search cache)** is the first layer that uses similarity matching rather than exact matching. Two queries with similar embeddings (e.g., "how does auth work" and "how does authentication work") should return the same search results. This skips the entire search pipeline (embedding generation + vector search + keyword search + fusion). Production threshold: 0.85-0.95 cosine similarity (Netflix uses 0.90).

**Layer 5 (full response cache)** is the highest-value cache but also the riskiest for staleness. Tools like GPTCache and Redis SemanticCache focus here. The Redis "Context-Enabled Semantic Cache" (CESC) pattern caches generic answers and uses a cheap model to personalize at serving time, dramatically increasing hit rates.

**Not every system needs all five layers.** Systems that return documents (not generated answers) skip layers 4-5. Systems without reranking skip layer 3. Start with layers 1-2, add others as needed.

### Similarity Thresholds (from production deployments)

| Use Case                 | Cosine Similarity | Cosine Distance | Notes                              |
|--------------------------|-------------------|------------------|------------------------------------|
| Embedding reuse          | > 0.98            | < 0.02           | Near-exact query match             |
| Search result caching    | 0.85 - 0.95      | 0.05 - 0.15     | Netflix: 0.90. Most systems: 0.85  |
| Full response caching    | 0.85 - 0.90      | 0.10 - 0.15     | LangChain default: 0.80 (0.2 dist)|
| Strict (low risk)        | > 0.95            | < 0.05           | Low false positives, low hit rate  |
| Permissive (high risk)   | < 0.80            | > 0.20           | High false positives               |

Note: cosine similarity and cosine distance are inverses. Similarity 0.90 = distance 0.10. Some libraries (LangChain, Redis) use distance, others use similarity. Always check which one a library expects.

### Cache Invalidation

Four mechanisms, typically used in combination:

**1. TTL (Time-Based).** The safety net. Every cache entry expires after a fixed duration. Not the primary mechanism, but prevents unbounded staleness.

| Domain              | Recommended TTL    |
|---------------------|--------------------|
| News, pricing       | Minutes to hours   |
| Product specs       | 1-24 hours         |
| Documentation       | Days to weeks      |
| Static reference    | Weeks+             |

**2. Event-Driven (Document Change).** The strongest production pattern. When a document is created, updated, or deleted, invalidate all cache entries that included results from that document. Requires a reverse index: `document_id -> [cache_entry_keys]`. Implementation: store `source_doc_ids` in each cache entry's metadata, then look them up on document change.

**3. Version-Based (Model/Prompt Change).** Include `model_version` and `embedding_model_id` in the cache key. When the model changes, old entries become automatic misses without manual flushing. Handles model upgrades and prompt engineering iterations cleanly.

**4. Freshness Verification at Retrieval.** On cache hit, compare the `content_hash` or `doc_version` stored in the entry against the current version. If mismatch, treat as cache miss. Adds a small lookup overhead but guarantees freshness for critical paths.

### Gotchas

- **Cache pollution.** Low-quality answers persist until TTL expires. Monitor quality metrics and purge entries with poor feedback.
- **Semantic drift.** Two queries can be semantically similar but require different answers due to context (e.g., "reset password" from an admin vs. a user). Include relevant context in the cache key, not just the query.
- **Model drift.** Switching embedding models without versioned cache keys creates inconsistent behavior. Always include the model ID in cache entry metadata.
- **Multi-tenant leakage.** Without metadata filtering, one user's cached answer can serve another user. Use filterable fields (domain, project, user scope) during cache lookup.

### Production Tools

| Tool        | What it caches         | Similarity Backend | Default Threshold        |
|-------------|------------------------|--------------------|--------------------------|
| GPTCache    | Full LLM responses     | FAISS, Milvus      | Configurable (0.6-0.8)  |
| LangChain   | Full LLM responses     | Redis (RedisVL)    | 0.2 cosine distance     |
| Redis CESC  | Generic + personalized | Redis FLAT/HNSW    | 0.1 cosine distance     |
| Pinecone    | Any layer              | Pinecone index     | 0.85-0.95 similarity    |
