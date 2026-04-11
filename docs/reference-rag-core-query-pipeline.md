# Production RAG System — Query Pipeline

> How search queries find the best documents. Covers search modes, multi-stage retrieval, reranking, and scoring. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

## Search Modes

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
- **This is the production default.** Pure vector search alone misses exact-term matches

## Multi-Stage Retrieval

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

## Scoring

**RRF (Reciprocal Rank Fusion)** — the zero-config default for combining search results

```
score(doc) = 1/(k + rank_in_vector) + 1/(k + rank_in_keyword)
k = 60 (smoothing constant — prevents #1 from dominating)
```

The score is a **ranking**, not a quality measure. A score of 0.033 doesn't mean "3.3% relevant." It means "this is the top-ranked result." Don't apply quality thresholds to RRF scores.

**Cosine similarity** — the quality measure for vector search (0 to 1). A threshold of 0.25 means "at least somewhat related." Applied before fusion, not after.
