# Production RAG System — Ingestion Pipeline

> How raw documents become searchable chunks with embeddings. Covers extraction, hashing, chunking, enrichment, embedding, and transactional storage. Companion to `reference-rag-system-architecture.md` which provides the system overview.

---

## Pipeline Flow

```
Source → Extract → Hash → Chunk → Count → Enrich → Cache Check → Embed → Format → Store

  PDF     "Revenue   SHA-256   [chunk1]  423     +context   cached?   [0.02,   "[0.02,  INSERT
  Web      grew 15%  match?    [chunk2]  tokens  summary    yes→skip  -0.01,   -0.01,   doc +
  Text     in Q3..." skip if   [chunk3]          prepend    no→API     0.04]    0.04]"   chunks
  Audio              same                                                                + audit
```

## Step 1: Extraction

Convert any file format to plain text while preserving structure.

| Source | Tool | What it extracts |
|---|---|---|
| PDF | Unstructured, LlamaParse | Text + headings + tables + page numbers |
| HTML/Web | Scrapers, Firecrawl | Clean text without nav/footer/ads |
| Audio | Whisper (OpenAI) | Transcription with timestamps |
| Images | Vision models, OCR | Descriptions or text content |
| Code | Language parsers | Functions, classes, with structure preserved |

**For text-only systems:** Skip this step entirely. Content is already text.

## Step 2: Content Hashing

SHA-256 hash of the extracted text. Compare against stored hash:
- **Match** → content hasn't changed. Skip chunking, embedding, everything below. Saves time and API costs.
- **Different** → content changed. Proceed with re-processing.

## Step 3: Chunking

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

**Overlap explained:** Chunks share text at their boundaries. If a sentence spans two chunks, both chunks contain the full sentence. This prevents "lost context at the seam," where important information falls between two chunks and neither has the full picture.

```
Chunk 1: "...database uses HNSW indexes for fast vector search."
                                    ↕ overlap ↕
Chunk 2: "HNSW indexes for fast vector search. They build a layered graph..."
```

## Step 4: Token Counting

Count tokens in each chunk. Stored as `token_count` on the chunk. Used later when assembling context for the LLM. You need to know how much space each chunk takes to stay within the context window budget.

## Step 5: Chunk Context Enrichment (Contextual Retrieval)

### The problem

When a document gets chunked, each chunk loses its context. A chunk that says "It validates the token and returns the user ID" is meaningful when you're reading the full auth middleware document. You know "it" means the auth middleware. But stored alone as a chunk, "it" could mean anything. The embedding for that chunk is vague, so search struggles to match it to queries like "how does auth validation work?"

### What chunk context enrichment does

Also known as "contextual retrieval" (Anthropic, 2024). We use "chunk context enrichment" because it more accurately describes the operation: enriching chunks with document context at ingestion time, before embedding. The industry name describes the goal (better retrieval), not the action.

Before embedding each chunk, you send the chunk + the full document to an LLM and ask: "What is this chunk about in the context of the whole document?" The LLM returns a short summary, one or two sentences. That summary gets prepended to the chunk text before embedding.

```
Without: "Revenue increased 15% year-over-year..."
With:    "From Acme Q3 2025 earnings report, financial section: Revenue increased 15%..."
```

A search for "Acme financial performance" will now find this chunk even though the original text never mentions "Acme" or "financial."

### How it affects the embedding

The embedder doesn't have prompts. You just concatenate the summary + chunk into one string and pass that string as input. The embedder turns whatever text you give it into a 1536-number vector. It doesn't know or care that the first sentence is a summary and the rest is the original chunk. It just sees one piece of text, and produces a better vector because it had more context to work with.

Think of it like filing a document in a cabinet. Without context, the label says "validates token, returns user ID," could go in any folder. With context, the label says "auth middleware, validates token, returns user ID," you know exactly where to file it and exactly when to pull it out.

### What gets stored

Three separate columns on the chunks table, each serving a different purpose:

| Column            | What it holds                                | Who uses it                    |
|-------------------|----------------------------------------------|--------------------------------|
| `context_summary` | The LLM-generated summary alone              | Developers (inspect, regenerate) |
| `content`         | The original chunk text alone                | The user (what they see in results) |
| `embedding`       | Vector of the combined summary + chunk text  | Search (finding matches)       |

The user never sees the summary. Search uses the enhanced embedding to find better matches, then returns the original chunk content.

The full document is never embedded as one piece. It's too big. Only chunks get embedded. The summary just enriches each chunk's embedding so it's more findable.

### What chunk context enrichment does NOT do

- Does not change search logic. Same vector search, same keyword search, same RRF fusion
- Does not help ranking. If the right doc is found at position 5, it stays at position 5 (that's what a reranker fixes)
- Does not change what the user sees. Results still show the original chunk content
- Does not run at search time. Summaries are generated once at ingestion and stored

### Chunk context enrichment vs reranking

These are complementary, not competing:

- **Chunk context enrichment** makes chunks easier to *find*. Improves recall and hit rate
- **Reranking** makes found results easier to *order*. Improves MRR and first-result accuracy
- They stack: 49% fewer failed retrievals from chunk context enrichment alone, 67% with both combined

### Impact and cost

**Impact:** 49% fewer failed retrievals. 67% with reranking added.

**Cost:** One LLM call per chunk during ingestion. Not free, but the cost is paid once per document write, not per search. Summaries only need regeneration when document content changes (which already triggers re-chunking).

## Step 6: Embedding Cache Check

Before calling the embedding API, check if identical content was already embedded:
- Key: `content_hash + embedding_model_id`
- **Hit** → reuse the cached vector. Skip API call. Saves money.
- **Miss** → proceed to Step 7.

Particularly valuable during re-ingestion: if you update a document's metadata but not its content, the chunks don't need re-embedding.

## Step 7: Embedding

Convert each chunk's text to a vector (array of numbers) via an embedding API.

| Model | Dimensions | Quality | Cost | When to use |
|---|---|---|---|---|
| **OpenAI text-embedding-3-small** | 1536 | Good | $0.02/M tokens | Budget-friendly default |
| **Voyage-3-large** | 1024 | Best commercial | $0.06/M tokens | When quality matters most |
| **Cohere embed-v3** | 1024 | Strong multilingual | $0.10/M tokens | Multi-language corpora |
| **BGE-M3** | 1024 | Best open-source | Free (self-hosted) | Privacy-sensitive, no API dependency |

**Important:** All chunks must use the same embedding model. Mixing models gives garbage search results. The numbers mean different things. Track `embedding_model_id` per chunk.

## Step 8: Vector Formatting

Convert the number array to the format the database expects. Postgres pgvector stores vectors as strings:
```
number[]: [0.021, -0.007, 0.045]  →  string: "[0.021,-0.007,0.045]"
```

Reading back from the database requires the reverse conversion.

## Step 9: Transactional Write

Save everything to the database in one atomic transaction:
- INSERT document row (content, metadata, hash)
- INSERT chunk rows (text, embedding, strategy, token_count)
- INSERT audit log entry (who, what, when)

If any step fails, nothing is committed. No orphaned chunks, no document without its search index, no missing audit trail.

## Performance Optimization

The ingestion pipeline has two expensive steps: Contextual Retrieval (LLM call per chunk) and embedding (API call per chunk). For large documents, these can take 10-15 minutes with naive sequential processing. Three optimizations reduce this to under a minute.

### The bottleneck: Contextual Retrieval with large documents

Contextual Retrieval sends the full document + each chunk to an LLM. For a 73K document with 151 chunks, that's 151 sequential LLM calls, each processing ~18K tokens. Two problems:

1. **Time:** Each call takes 3-5 seconds. 151 calls = 12+ minutes.
2. **Tokens:** 151 x 18K = 2.8 million input tokens per document. Expensive.
3. **TPM (Tokens Per Minute) limit:** At 200K TPM (OpenAI gpt-4o-mini Tier 1), you can only process ~11 calls per minute with full-document context. Parallelism hits the TPM wall before helping.

### Optimization 1: Truncated context

Instead of sending the full document (73K) with every chunk, generate a document summary once (one LLM call), then send the summary (~200 words) + header path + neighboring chunks with each chunk. Total context per call drops from ~18K tokens to ~1K tokens.

**How it works:**
1. One LLM call: "Summarize this document in 150-200 words" (processes the full document once)
2. For each chunk, build context from: document summary + section header path (parsed from markdown, no LLM needed) + previous chunk + next chunk
3. LLM writes the context sentence using this smaller but sufficient context

**Trade-off:** The LLM sees less of the document per chunk. For most chunks, the summary + neighbors provide enough context. For chunks that reference distant sections, the summary covers the topic even if it misses the specific detail.

**Benchmark result (73K doc, 151 chunks):**
- Enrichment: 715s down to 253s (65% faster)
- Token usage: 2.8M down to 148K (95% reduction)
- Critically: unblocks parallelism (see below)

### Optimization 2: Parallel Contextual Retrieval

Fire multiple LLM calls concurrently instead of sequentially. With a rate limiter controlling concurrency, process N chunks at a time.

**Why it requires truncated context first:** With full-document context (~18K tokens per call), 10 concurrent calls use 180K tokens. The 200K TPM limit blocks you immediately. With truncated context (~1K tokens per call), 10 concurrent calls use only 10K tokens. TPM is no longer the constraint.

**Benchmark result (truncated + parallel combined, 73K doc, 151 chunks):**
- Enrichment: 715s down to 29s (96% faster)
- The combination is what matters. Parallel alone (without truncation) was slower due to TPM throttling.

### Optimization 3: Batch embeddings

OpenAI's embedding API accepts an array of inputs in a single call. Instead of 151 separate API calls (one per chunk), send all 151 texts in 2 batch calls (batches of 100).

**Benchmark result (73K doc, 151 chunks):**
- Embedding: 41s down to 2.4s (94% faster)
- Less impactful than enrichment optimization because embedding was only 5% of total time

### Combined results

Benchmarked on a 73K document (1,424 lines, 151 chunks):

| Mode              | Enrichment | Embedding | Total   | Input Tokens | vs Baseline |
|-------------------|------------|-----------|---------|--------------|-------------|
| Baseline          | 715s       | 41s       | 756s    | 2,841,704    |             |
| Truncated only    | 253s       | 37s       | 291s    | 148,210      | 62% faster  |
| **All combined**  | **29s**    | **0.8s**  | **30s** | 158,854      | **96% faster** |

**Key insight:** The order of optimizations matters. Truncated context must come first because it reduces per-call token usage by 95%, which unblocks parallelism by removing the TPM bottleneck. Parallel without truncation is actually slower due to TPM throttling.

## Migration & Re-Processing

When you need to change how documents are processed (new embedding model, different chunking strategy):

| Scenario | What to do |
|---|---|
| **New embedding model** | Re-embed all chunks with new model. Don't mix old and new embeddings. Track model_id per chunk to know what needs re-processing. |
| **New chunking strategy** | Re-chunk and re-embed all documents. Old chunks are deleted, new ones created. Content in documents table is unchanged. |
| **Schema change** | Side-by-side migration: create new tables alongside old, migrate data, verify, then drop old tables. System stays live throughout. |
| **Bulk re-ingestion** | Use embedding cache. Unchanged content reuses cached vectors. Only changed content calls the API. |
