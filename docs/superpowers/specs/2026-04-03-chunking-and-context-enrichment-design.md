# Recursive Chunking & Chunk Context Enrichment — Design Spec

> **Phase:** 4.5.2 + 4.5.3 (Search Eval & Tuning)
> **Date:** 2026-04-03
> **Status:** Approved design, pending implementation plan

## Summary

Two complementary improvements to Ledger's ingestion pipeline:

1. **Recursive chunking** — replace the greedy paragraph packer with a hierarchical splitter that respects document structure (headers, paragraphs, sentences) and supports configurable chunk size.
2. **Chunk context enrichment** — a pre-embedding enrichment step that generates short LLM summaries per chunk, so embeddings capture document-level context that would otherwise be lost in isolation. Based on the "Contextual Retrieval" technique (Anthropic, 2024). We use the name "chunk context enrichment" because it describes the operation (enriching chunks with context before embedding) rather than the goal (better retrieval).

## Problem

Current chunking (`chunkText()` in `embeddings.ts`) splits on `\n\n`, packs greedily into 2000-char chunks with 200-char overlap, and force-splits oversized chunks at character boundaries. This produces:

- **Blurry embeddings** — large chunks contain multiple topics, so each embedding is a weak average. Eval data shows 88.5% hit rate but only 46.2% first-result accuracy — the system finds *something* but not the *right* thing first.
- **Lost structure** — markdown headers are treated the same as paragraph breaks. A chunk can span two unrelated sections.
- **Context-free chunks** — "It supports three modes" means nothing without knowing what "it" refers to. The embedding can't match queries about the specific feature.

## Design

### 1. Recursive Chunking

#### Split Hierarchy

The splitter tries each level in order. If a section exceeds `maxChunkSize` after splitting at one level, it recurses to the next finer level:

```
Level 1: Markdown headers    — /^#{1,6}\s/m
Level 2: Double newlines     — \n\n (paragraph boundaries)
Level 3: Single newlines     — \n (line breaks)
Level 4: Sentence boundaries — /(?<=[.!?])\s+/
Level 5: Character split     — hard fallback at maxChunkSize
```

#### Algorithm

```
function recursiveChunk(text, level, config):
  if text.length <= config.maxChunkSize:
    return [text]

  if level > MAX_LEVEL:
    return forceCharSplit(text, config.maxChunkSize)

  sections = split(text, SEPARATORS[level])
  chunks = []
  current = ""

  for section in sections:
    if (current + section).length > config.maxChunkSize:
      if current:
        chunks.push(current)
      if section.length > config.maxChunkSize:
        chunks.push(...recursiveChunk(section, level + 1, config))
      else:
        current = applyOverlap(current, section, config.overlapChars)
    else:
      current += section

  if current:
    chunks.push(current)

  return chunks
```

#### Configuration

```typescript
interface IChunkConfigProps {
  maxChunkSize: number;    // default: 1000
  overlapChars: number;    // default: 200
  strategy: ChunkStrategy; // default: 'recursive'
}
```

- Default chunk size drops from 2000 to **1000 characters** — industry standard for semantic search (LangChain, LlamaIndex defaults). Smaller chunks produce sharper embeddings. Context enrichment compensates for the smaller window.
- The old `'paragraph'` strategy remains available as a `ChunkStrategy` option for backward compatibility.
- Overlap is applied between adjacent chunks at the same split level. Header-level splits do not overlap (sections are semantically distinct).

#### Chunk Metadata

Each chunk carries metadata about how it was produced:

```typescript
interface IChunkProps {
  content: string;
  chunk_index: number;
  content_type: ChunkContentType;  // 'text' (default)
  strategy: ChunkStrategy;         // 'recursive', 'paragraph', 'forced'
  overlap_chars: number;           // actual overlap with previous chunk
}
```

### 2. Chunk Context Enrichment

#### Technique Reference

This implements the "Contextual Retrieval" technique described by Anthropic (2024). The industry name refers to the retrieval improvement achieved by this technique. We call the implementation "chunk context enrichment" because the code operates at ingestion time, enriching chunks with document context before embedding — not at retrieval time.

#### How It Works

After chunking, each chunk is sent to an LLM alongside the full document content. The LLM generates a 2-3 sentence context summary that situates the chunk within the document.

**Prompt template:**
```
Here is the full document:
<document>
{DOCUMENT_CONTENT}
</document>

Here is the chunk:
<chunk>
{CHUNK_CONTENT}
</chunk>

Write a short context (2-3 sentences) that situates this chunk within
the document. Include the document's topic and what specific information
this chunk covers. Be concise and factual.
```

#### Embedding Strategy

The context summary is concatenated with the chunk content before embedding:

```
embedding_input = context_summary + "\n\n" + chunk_content
```

The `content` column in `document_chunks` stores the **original chunk text only** (no prefix). Search results return original text. The enrichment only affects the embedding vector and is stored separately in `context_summary`.

#### Model Choice

- **Model:** `gpt-4o-mini` — $0.15/1M input tokens, fast, sufficient for short factual summaries
- **Why not gpt-4o:** 20x more expensive, no quality difference for 2-sentence summaries
- **Why not local:** Adds infrastructure complexity. OpenAI is already in the pipeline for embeddings — same privacy boundary.

#### Cost Estimate

For a 10-chunk document (~5000 chars / ~1500 tokens):
- 10 LLM calls, each sending full doc (~1500 tokens) + chunk (~300 tokens) = ~18,000 input tokens
- At $0.15/1M input: **~$0.003 per document**
- Full re-index of ~130 documents: **~$0.40**

#### Token Count

While processing each chunk, estimate token count using `chars / 4` (standard approximation for English text with GPT tokenizers). Store in `token_count` column. This is used for token budgeting in search results — e.g., limiting how many chunks are returned to fit a context window.

### 3. Pipeline Integration

#### Write Path (createDocument / updateDocument)

```
createDocument(content, config?)
  |
  +-- 1. contentHash(content)
  |
  +-- 2. chunkText(content, config)              <- recursive splitter
  |      Returns IChunkProps[]
  |
  +-- 3. generateContextSummaries(chunks, content) <- LLM enrichment
  |      Returns { summary: string, tokenCount: number }[]
  |
  +-- 4. generateEmbeddings(chunks, summaries)     <- embeds summary+content
  |      For each: embed(summary + "\n\n" + chunk.content)
  |
  +-- 5. RPC document_create(
           ...,
           p_chunk_contents: string[],       -- original text
           p_chunk_embeddings: vector[],     -- embeddings of summary+content
           p_chunk_summaries: text[],        -- NEW: context summaries
           p_chunk_token_counts: int[],      -- NEW: token counts
           p_chunk_strategy: text,           -- 'recursive' | 'paragraph' | ...
           p_chunk_overlap: int,             -- NEW: overlap chars used
         )
```

#### RPC Changes

`document_create` and `document_update` gain 3 new parameters:

| Parameter             | Type     | Default  | Purpose                               |
|-----------------------|----------|----------|---------------------------------------|
| `p_chunk_summaries`   | `text[]` | `NULL`   | Context summaries per chunk           |
| `p_chunk_token_counts`| `int[]`  | `NULL`   | Token count per chunk                 |
| `p_chunk_overlap`     | `int`    | `0`      | Overlap chars used in chunking config |

The INSERT loop in the RPC writes `context_summary` and `token_count` to each chunk row (columns already exist). `overlap_chars` is written per-chunk from the chunk metadata.

#### Search Path — No Changes

Search RPCs (`match_documents`, `search_hybrid`, etc.) already return `context_summary` from `document_chunks`. The improved embeddings do the work — no search logic changes needed.

### 4. Eval Integration

Add to `CURRENT_SEARCH_CONFIG` in `eval-store.ts`:

```typescript
chunk_strategy: 'recursive',       // was 'paragraph'
chunk_max_size: 1000,              // was 2000
context_enrichment: true,          // was not tracked
context_enrichment_model: 'gpt-4o-mini',
```

This ensures eval runs record which pipeline produced the results, enabling before/after comparison.

### 5. Re-Index Script

`src/scripts/reindex.ts` — reads all documents, re-chunks and re-embeds through the new pipeline.

**Behavior:**
- Reads all active documents from `documents` table
- For each: chunk with new config, generate context summaries, generate embeddings
- Calls `document_update` RPC (which versions old content before overwriting chunks)
- Logs progress: document name, old chunk count, new chunk count
- Dry-run mode (default) that shows what would change without writing

**Safety:**
- `document_update` saves old content to `document_versions` — rollback is possible
- Run after verifying the new pipeline works on test documents
- Compare eval scores before and after re-indexing

## File Map

| File                                        | Action | Responsibility                                                                      |
|---------------------------------------------|--------|------------------------------------------------------------------------------------- |
| `src/lib/search/embeddings.ts`              | Modify | Replace `chunkText()` with recursive splitter, add `IChunkConfigProps`               |
| `src/lib/search/chunk-context-enrichment.ts`| Create | `generateContextSummaries()` — LLM enrichment, returns summaries + token counts     |
| `src/lib/documents/operations.ts`           | Modify | Wire chunking config + context enrichment into `createDocument()` / `updateDocument()` |
| `src/lib/documents/classification.ts`       | Modify | Add `IChunkConfigProps`, update `ChunkStrategy` union with `'recursive'`             |
| `src/lib/eval/eval-store.ts`                | Modify | Add `chunk_strategy`, `context_enrichment` to `CURRENT_SEARCH_CONFIG`               |
| `src/scripts/reindex.ts`                    | Create | Bulk re-index script with dry-run mode                                              |
| `document_create` RPC (Supabase)            | Modify | Add `p_chunk_summaries`, `p_chunk_token_counts`, `p_chunk_overlap` params            |
| `document_update` RPC (Supabase)            | Modify | Same new params                                                                      |
| `tests/embeddings.test.ts`                  | Modify | Tests for recursive chunker                                                          |
| `tests/chunk-context-enrichment.test.ts`    | Create | Tests for context summary generation (mocked OpenAI)                                 |
| `tests/operations.test.ts`                  | Modify | Integration tests for full write pipeline                                            |

### What Does NOT Change

- Search RPCs — already return `context_summary` from chunks
- `ai-search.ts` — search logic unchanged, better embeddings do the work
- `mcp-server.ts` — no new MCP tools needed
- `eval.ts` scoring — metrics unchanged, underlying data quality improves

## Success Criteria

1. Recursive chunker splits by structure (headers preserved, no mid-sentence breaks)
2. Every chunk has a `context_summary` that situates it within its document
3. Embeddings incorporate context summaries
4. Eval scores improve over baseline (especially first-result accuracy and MRR)
5. Re-index script can process all ~130 documents safely with dry-run verification
6. All existing tests pass, new tests cover both components
