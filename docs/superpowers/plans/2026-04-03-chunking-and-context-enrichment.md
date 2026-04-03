# Recursive Chunking & Chunk Context Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the greedy paragraph chunker with a recursive hierarchical splitter and add LLM-generated context summaries per chunk before embedding — improving search precision by producing sharper, context-aware embeddings.

**Architecture:** The recursive chunker replaces `chunkText()` in `embeddings.ts` with a hierarchical splitter (headers → paragraphs → lines → sentences → characters). A new `chunk-context-enrichment.ts` module calls OpenAI gpt-4o-mini to generate a 2-3 sentence context summary per chunk. The summary is concatenated with chunk content before embedding, stored separately in `context_summary`, and the original chunk text is what search results return. Postgres RPC functions gain 3 new parameters for summaries, token counts, and overlap.

**Tech Stack:** TypeScript (strict), Vitest, OpenAI gpt-4o-mini (summaries) + text-embedding-3-small (embeddings), Supabase Postgres RPC

---

## File Map

| File                                        | Action | Responsibility                                                          |
|---------------------------------------------|--------|-------------------------------------------------------------------------|
| `src/lib/documents/classification.ts`       | Modify | Add `'recursive'` to `ChunkStrategy`, add `IChunkConfigProps`           |
| `src/lib/search/embeddings.ts`              | Modify | Replace `chunkText()` with recursive splitter, accept `IChunkConfigProps` |
| `src/lib/search/chunk-context-enrichment.ts`| Create | `generateContextSummaries()` — gpt-4o-mini context per chunk           |
| `src/lib/documents/operations.ts`           | Modify | Wire chunk config + context enrichment into create/update               |
| `src/lib/eval/eval-store.ts`                | Modify | Add chunking + enrichment fields to `CURRENT_SEARCH_CONFIG`             |
| `src/scripts/reindex.ts`                    | Create | Bulk re-index all documents through new pipeline                        |
| `tests/embeddings.test.ts`                  | Modify | Tests for recursive chunker                                             |
| `tests/chunk-context-enrichment.test.ts`    | Create | Tests for context summary generation (mocked OpenAI)                    |
| `tests/document-operations.test.ts`         | Modify | Integration tests for full write pipeline                               |

---

## Task 1: Add `'recursive'` to ChunkStrategy and create IChunkConfigProps

**Files:**
- Modify: `src/lib/documents/classification.ts:21-22`

- [ ] **Step 1: Add `'recursive'` to `ChunkStrategy` type and create `IChunkConfigProps`**

In `src/lib/documents/classification.ts`, update the `ChunkStrategy` type and add the config interface after it:

```typescript
// Chunk metadata types — stored on document_chunks table
export type ChunkStrategy = 'header' | 'paragraph' | 'sentence' | 'semantic' | 'forced' | 'recursive';
export type ChunkContentType = 'text' | 'image_description' | 'table_extraction' | 'code_block' | 'transcript' | 'slide_text';

// Chunking configuration — controls how text is split before embedding
export interface IChunkConfigProps {
  maxChunkSize: number;    // max chars per chunk (default: 1000)
  overlapChars: number;    // chars shared between adjacent chunks (default: 200)
  strategy: ChunkStrategy; // splitting algorithm (default: 'recursive')
}
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `cd /home/adrian/repos/ledger && npx vitest run tests/document-classification.test.ts`
Expected: PASS — adding a type and interface is non-breaking

- [ ] **Step 3: Commit**

```bash
git add src/lib/documents/classification.ts
git commit -m "feat(types): add 'recursive' to ChunkStrategy, add IChunkConfigProps"
```

---

## Task 2: Rewrite `chunkText()` as a recursive hierarchical splitter

The current `chunkText()` splits on `\n\n` and packs greedily. The new version tries increasingly fine split boundaries: markdown headers → double newlines → single newlines → sentences → character fallback. If a section exceeds `maxChunkSize` after splitting at one level, it recurses to the next finer level.

**Files:**
- Modify: `src/lib/search/embeddings.ts:22-160`
- Modify: `tests/embeddings.test.ts`

- [ ] **Step 1: Write failing tests for the recursive chunker**

Add these tests to `tests/embeddings.test.ts`:

```typescript
describe('chunkText — recursive strategy', () => {
  it('returns single chunk for short text', () => {
    const chunks = chunkText('Short text.', { maxChunkSize: 1000, overlapChars: 200, strategy: 'recursive' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Short text.');
    expect(chunks[0].strategy).toBe('recursive');
    expect(chunks[0].overlap_chars).toBe(0);
  });

  it('splits on markdown headers first', () => {
    const text = '# Section One\n\nContent for section one.\n\n# Section Two\n\nContent for section two.';
    const chunks = chunkText(text, { maxChunkSize: 60, overlapChars: 0, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].content).toContain('Section One');
    expect(chunks[1].content).toContain('Section Two');
  });

  it('preserves header text in its chunk', () => {
    const text = '## My Header\n\nSome paragraph content here.';
    const chunks = chunkText(text, { maxChunkSize: 1000, overlapChars: 0, strategy: 'recursive' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('## My Header');
  });

  it('falls through to paragraph split when no headers', () => {
    const text = 'Paragraph one with some content.\n\nParagraph two with more content.\n\nParagraph three with even more.';
    const chunks = chunkText(text, { maxChunkSize: 50, overlapChars: 0, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('falls through to sentence split for long paragraphs', () => {
    const text = 'First sentence is here. Second sentence follows. Third sentence appears. Fourth sentence ends.';
    const chunks = chunkText(text, { maxChunkSize: 50, overlapChars: 0, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // No mid-sentence breaks
    for (const chunk of chunks) {
      if (chunk.content.length > 1) {
        expect(chunk.content).toMatch(/[.!?]\s*$/);
      }
    }
  });

  it('force-splits at character level as last resort', () => {
    const text = 'a'.repeat(3000); // no headers, no paragraphs, no sentences
    const chunks = chunkText(text, { maxChunkSize: 1000, overlapChars: 100, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some(chunk => chunk.strategy === 'forced')).toBe(true);
  });

  it('applies overlap between adjacent chunks at same level', () => {
    const text = 'First paragraph with enough words to fill a chunk.\n\nSecond paragraph with enough words too.\n\nThird paragraph to trigger splitting.';
    const chunks = chunkText(text, { maxChunkSize: 60, overlapChars: 10, strategy: 'recursive' });
    if (chunks.length > 1) {
      expect(chunks[1].overlap_chars).toBeGreaterThan(0);
    }
  });

  it('does not overlap between header-level sections', () => {
    const text = '# Section A\n\nContent A.\n\n# Section B\n\nContent B.';
    const chunks = chunkText(text, { maxChunkSize: 30, overlapChars: 10, strategy: 'recursive' });
    // Header sections are semantically distinct — no overlap at header boundaries
    const sectionBChunk = chunks.find(chunk => chunk.content.includes('Section B'));
    if (sectionBChunk && sectionBChunk.chunk_index > 0) {
      expect(sectionBChunk.content).not.toContain('Content A');
    }
  });

  it('chunk_index increments correctly across all chunks', () => {
    const text = '# A\n\nParagraph.\n\n# B\n\nAnother paragraph.\n\n# C\n\nThird paragraph.';
    const chunks = chunkText(text, { maxChunkSize: 30, overlapChars: 0, strategy: 'recursive' });
    for (let index = 0; index < chunks.length; index++) {
      expect(chunks[index].chunk_index).toBe(index);
    }
  });
});

describe('chunkText — backward compatibility', () => {
  it('old signature still works (no config object)', () => {
    const chunks = chunkText('Short text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].strategy).toBe('recursive');
  });

  it('defaults to maxChunkSize 1000', () => {
    const text = 'word '.repeat(250); // ~1250 chars
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/adrian/repos/ledger && npx vitest run tests/embeddings.test.ts`
Expected: FAIL — `chunkText` doesn't accept config object yet, recursive strategy not implemented

- [ ] **Step 3: Rewrite `chunkText()` with recursive splitter**

Replace the constants and `chunkText()` function in `src/lib/search/embeddings.ts` (lines 22-160). Keep the import of `IChunkConfigProps` from classification, keep `IChunkProps` interface, keep all other functions unchanged.

```typescript
import type { ChunkStrategy, ChunkContentType, IOpenAIClientProps, ISupabaseClientProps, IChunkConfigProps } from '../documents/classification.js';

// ... (IChunkProps interface stays the same) ...

// =============================================================================
// Constants
// =============================================================================

const EMBEDDING_MODEL = 'text-embedding-3-small';

const DEFAULT_CHUNK_CONFIG: IChunkConfigProps = {
  maxChunkSize: 1000,
  overlapChars: 200,
  strategy: 'recursive',
};

// Split separators — ordered from coarsest to finest.
// The recursive chunker tries each level in order until chunks fit.
const SPLIT_SEPARATORS = [
  /^#{1,6}\s/m,           // Level 0: Markdown headers
  /\n\n+/,                // Level 1: Double newlines (paragraphs)
  /\n/,                   // Level 2: Single newlines
  /(?<=[.!?])\s+/,        // Level 3: Sentence boundaries
];

// =============================================================================
// Pure functions — no API calls, no database, fully testable
// =============================================================================

// ... (contentHash, toVectorString, parseVector stay the same) ...

/**
 * Split text into chunks using a recursive hierarchical strategy.
 *
 * Implements chunk context enrichment pipeline step 1 (chunking).
 * Based on the recursive character splitting pattern used in production
 * RAG systems (LangChain, LlamaIndex).
 *
 * Split hierarchy (coarsest to finest):
 *   1. Markdown headers (^#{1,6}\s)
 *   2. Double newlines (paragraph boundaries)
 *   3. Single newlines (line breaks)
 *   4. Sentence boundaries (after . ! ?)
 *   5. Character-level force split (fallback)
 *
 * If text fits within maxChunkSize, returns it as a single chunk.
 * Otherwise, splits at the coarsest level possible. If any resulting
 * section still exceeds maxChunkSize, recurses to the next finer level.
 *
 * Overlap is applied between adjacent chunks at levels 1-4.
 * Header-level splits (level 0) do NOT overlap — sections are
 * semantically distinct.
 */
export function chunkText(
  text: string,
  config?: Partial<IChunkConfigProps>,
): IChunkProps[] {
  const resolvedConfig: IChunkConfigProps = { ...DEFAULT_CHUNK_CONFIG, ...config };
  const { maxChunkSize, strategy } = resolvedConfig;

  // Short text = one chunk
  if (text.length <= maxChunkSize) {
    return [{
      content: text,
      chunk_index: 0,
      content_type: 'text',
      strategy,
      overlap_chars: 0,
    }];
  }

  const rawChunks = recursiveSplit(text, 0, resolvedConfig);

  // Assign sequential chunk_index across all chunks
  return rawChunks.map((chunk, index) => ({
    ...chunk,
    chunk_index: index,
  }));
}

/**
 * Core recursive splitting logic.
 * Tries the separator at `level`. If a section still exceeds maxChunkSize,
 * recurses to level + 1. At the bottom level, force-splits at character positions.
 */
function recursiveSplit(
  text: string,
  level: number,
  config: IChunkConfigProps,
): IChunkProps[] {
  const { maxChunkSize, overlapChars, strategy } = config;

  // Base case: text fits
  if (text.length <= maxChunkSize) {
    return [{
      content: text,
      chunk_index: 0, // will be reassigned by caller
      content_type: 'text' as ChunkContentType,
      strategy,
      overlap_chars: 0,
    }];
  }

  // Bottom level: force-split at character boundaries
  if (level >= SPLIT_SEPARATORS.length) {
    return forceCharSplit(text, maxChunkSize, overlapChars);
  }

  const separator = SPLIT_SEPARATORS[level];
  const isHeaderLevel = level === 0;
  const sections = splitKeepingSeparator(text, separator, isHeaderLevel);

  // If splitting produced only 1 section (separator not found), try next level
  if (sections.length <= 1) {
    return recursiveSplit(text, level + 1, config);
  }

  // Pack sections into chunks, recurse oversized ones
  const chunks: IChunkProps[] = [];
  let currentContent = '';

  for (const section of sections) {
    const wouldExceed = (currentContent + section).length > maxChunkSize;

    if (wouldExceed && currentContent.length > 0) {
      // Flush current accumulated content as chunk(s)
      chunks.push(...recursiveSplit(currentContent.trim(), level + 1, config));

      // Apply overlap (except at header boundaries)
      if (!isHeaderLevel && overlapChars > 0) {
        const overlap = currentContent.slice(-overlapChars);
        currentContent = overlap + section;
      } else {
        currentContent = section;
      }
    } else {
      currentContent = currentContent + section;
    }
  }

  // Flush remaining content
  if (currentContent.trim().length > 0) {
    chunks.push(...recursiveSplit(currentContent.trim(), level + 1, config));
  }

  // Mark overlap on chunks (first chunk has 0)
  return chunks.map((chunk, index) => ({
    ...chunk,
    overlap_chars: index > 0 && !isHeaderLevel ? Math.min(overlapChars, chunk.content.length) : 0,
  }));
}

/**
 * Split text by a regex separator.
 * For header-level splits, the separator (e.g. "# Title") is kept at the
 * start of the section it belongs to. For other levels, the separator
 * is consumed (it's whitespace/newlines anyway).
 */
function splitKeepingSeparator(
  text: string,
  separator: RegExp,
  keepSeparator: boolean,
): string[] {
  if (keepSeparator) {
    // Header split: split just before each header, keep header in its section
    const parts = text.split(new RegExp(`(?=${separator.source})`, 'm'));
    return parts.filter(part => part.length > 0);
  }
  return text.split(separator).filter(part => part.trim().length > 0);
}

/**
 * Force-split at character boundaries as a last resort.
 * Handles text with no structural separators (JSON blobs, base64, walls of text).
 */
function forceCharSplit(
  text: string,
  maxChunkSize: number,
  overlapChars: number,
): IChunkProps[] {
  const chunks: IChunkProps[] = [];
  const step = Math.max(1, maxChunkSize - overlapChars);

  for (let offset = 0; offset < text.length; offset += step) {
    chunks.push({
      content: text.slice(offset, offset + maxChunkSize),
      chunk_index: 0, // will be reassigned by caller
      content_type: 'text',
      strategy: 'forced',
      overlap_chars: offset > 0 ? overlapChars : 0,
    });
  }

  return chunks;
}
```

**Important:** The function signature changes from `chunkText(text, strategy?, maxChars?, overlapChars?)` to `chunkText(text, config?)`. All callers (`operations.ts`) will be updated in Task 4.

- [ ] **Step 4: Update existing chunkText tests**

The old tests used the 4-argument signature. Update them to use the config object:

```typescript
describe('chunkText', () => {
  it('single chunk for short text', () => {
    const chunks = chunkText('Short text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Short text.');
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].strategy).toBe('recursive');
    expect(chunks[0].content_type).toBe('text');
    expect(chunks[0].overlap_chars).toBe(0);
  });

  it('splits on paragraph boundaries', () => {
    const text = 'First paragraph with enough words.\n\nSecond paragraph with more words.\n\nThird paragraph here.';
    const chunks = chunkText(text, { maxChunkSize: 50, overlapChars: 10, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunk_index increments from 0', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, { maxChunkSize: 25, overlapChars: 5, strategy: 'recursive' });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it('first chunk has 0 overlap', () => {
    const text = 'First paragraph content.\n\nSecond paragraph content.';
    const chunks = chunkText(text, { maxChunkSize: 30, overlapChars: 10, strategy: 'recursive' });
    expect(chunks[0].overlap_chars).toBe(0);
  });

  it('force-splits text with no paragraph breaks', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, { maxChunkSize: 2000, overlapChars: 200, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some(chunk => chunk.strategy === 'forced')).toBe(true);
  });
});
```

- [ ] **Step 5: Run all tests**

Run: `cd /home/adrian/repos/ledger && npx vitest run`
Expected: ALL PASS — recursive chunker works, old tests updated

- [ ] **Step 6: Commit**

```bash
git add src/lib/search/embeddings.ts tests/embeddings.test.ts
git commit -m "feat(chunking): recursive hierarchical splitter — headers, paragraphs, sentences, character fallback"
```

---

## Task 3: Create chunk context enrichment module

This module implements the "chunk context enrichment" technique (also known as "contextual retrieval," Anthropic 2024). It generates a 2-3 sentence context summary per chunk using an LLM, situating the chunk within its parent document. Summaries are used to enrich embeddings at ingestion time.

**Files:**
- Create: `src/lib/search/chunk-context-enrichment.ts`
- Create: `tests/chunk-context-enrichment.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/chunk-context-enrichment.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { generateContextSummaries, estimateTokenCount } from '../src/lib/search/chunk-context-enrichment.js';
import type { IChunkProps } from '../src/lib/search/embeddings.js';

function makeChunk(content: string, index: number): IChunkProps {
  return {
    content,
    chunk_index: index,
    content_type: 'text',
    strategy: 'recursive',
    overlap_chars: 0,
  };
}

// Mock OpenAI client that returns predictable summaries
function makeMockOpenAI(summaryPrefix: string = 'Context for chunk') {
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async (params: { messages: Array<{ content: string }> }) => {
          // Extract chunk content from the user message to make summaries unique
          const chunkIndex = params.messages[1]?.content?.includes('chunk') ? 'N' : '?';
          return {
            choices: [{ message: { content: `${summaryPrefix} ${chunkIndex}: This describes the topic.` } }],
          };
        }),
      },
    },
  };
}

describe('estimateTokenCount', () => {
  it('estimates ~4 chars per token for English text', () => {
    const text = 'Hello world, this is a test sentence.'; // 37 chars
    const tokens = estimateTokenCount(text);
    expect(tokens).toBe(Math.ceil(37 / 4));
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('handles long text', () => {
    const text = 'word '.repeat(1000); // 5000 chars
    expect(estimateTokenCount(text)).toBe(Math.ceil(5000 / 4));
  });
});

describe('generateContextSummaries', () => {
  it('returns one summary per chunk', async () => {
    const chunks = [
      makeChunk('First chunk content about databases.', 0),
      makeChunk('Second chunk content about search.', 1),
    ];
    const mockOpenAI = makeMockOpenAI();
    const results = await generateContextSummaries(mockOpenAI, chunks, 'Full document content here.');
    expect(results).toHaveLength(2);
    expect(results[0].summary).toBeDefined();
    expect(results[1].summary).toBeDefined();
  });

  it('includes token count for each chunk', async () => {
    const chunks = [makeChunk('Some content.', 0)];
    const mockOpenAI = makeMockOpenAI();
    const results = await generateContextSummaries(mockOpenAI, chunks, 'Full doc.');
    expect(results[0].tokenCount).toBe(Math.ceil('Some content.'.length / 4));
  });

  it('calls OpenAI once per chunk', async () => {
    const chunks = [
      makeChunk('Chunk one.', 0),
      makeChunk('Chunk two.', 1),
      makeChunk('Chunk three.', 2),
    ];
    const mockOpenAI = makeMockOpenAI();
    await generateContextSummaries(mockOpenAI, chunks, 'Full doc content.');
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it('uses gpt-4o-mini model', async () => {
    const chunks = [makeChunk('Content.', 0)];
    const mockOpenAI = makeMockOpenAI();
    await generateContextSummaries(mockOpenAI, chunks, 'Full doc.');
    const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o-mini');
  });

  it('sends full document and chunk in messages', async () => {
    const documentContent = 'This is the full document about RAG systems.';
    const chunkContent = 'This chunk covers embeddings.';
    const chunks = [makeChunk(chunkContent, 0)];
    const mockOpenAI = makeMockOpenAI();
    await generateContextSummaries(mockOpenAI, chunks, documentContent);

    const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
    const userMessage = callArgs.messages.find((message: { role: string }) => message.role === 'user');
    expect(userMessage.content).toContain(documentContent);
    expect(userMessage.content).toContain(chunkContent);
  });

  it('returns empty array for empty chunks array', async () => {
    const mockOpenAI = makeMockOpenAI();
    const results = await generateContextSummaries(mockOpenAI, [], 'Full doc.');
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/adrian/repos/ledger && npx vitest run tests/chunk-context-enrichment.test.ts`
Expected: FAIL — module doesn't exist yet

- [ ] **Step 3: Create the chunk context enrichment module**

Create `src/lib/search/chunk-context-enrichment.ts`:

```typescript
// chunk-context-enrichment.ts
// Pre-embedding enrichment — generates context summaries per chunk using an LLM.
//
// Implements the "Contextual Retrieval" technique (Anthropic, 2024).
// We call it "chunk context enrichment" because the code operates at ingestion
// time, enriching chunks with document context before embedding — not at
// retrieval time. The industry name describes the goal (better retrieval),
// not the action.
//
// How it works:
// 1. Each chunk + the full document is sent to an LLM (gpt-4o-mini)
// 2. The LLM generates a 2-3 sentence summary situating the chunk in context
// 3. The summary is stored in context_summary column on document_chunks
// 4. Before embedding, the summary is concatenated with chunk content:
//    embed(summary + "\n\n" + chunk.content)
// 5. Search results return the original chunk content (not the summary)

import type { IChunkProps } from './embeddings.js';

const CONTEXT_ENRICHMENT_MODEL = 'gpt-4o-mini';

const CONTEXT_PROMPT = `Here is the full document:
<document>
{DOCUMENT_CONTENT}
</document>

Here is the chunk:
<chunk>
{CHUNK_CONTENT}
</chunk>

Write a short context (2-3 sentences) that situates this chunk within the document. Include the document's topic and what specific information this chunk covers. Be concise and factual.`;

// =============================================================================
// Interfaces
// =============================================================================

export interface IContextEnrichmentResultProps {
  summary: string;
  tokenCount: number;
}

// OpenAI chat client — structural type to avoid importing the heavy package
export interface IOpenAIChatClientProps {
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        max_tokens?: number;
        temperature?: number;
      }) => Promise<{ choices: Array<{ message: { content: string } }> }>;
    };
  };
}

// =============================================================================
// Pure functions
// =============================================================================

/**
 * Estimate token count from character length.
 * Standard approximation for English text with GPT tokenizers: ~4 chars per token.
 * Used for token budgeting in search results (e.g., limiting chunks to fit a context window).
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// =============================================================================
// LLM functions
// =============================================================================

/**
 * Generate context summaries for each chunk using an LLM.
 *
 * Each chunk is sent alongside the full document content to gpt-4o-mini,
 * which returns a 2-3 sentence summary situating the chunk within the document.
 *
 * Summaries are generated sequentially (not in parallel) to avoid rate limiting
 * and to keep costs predictable. For a 10-chunk document, this adds ~2-5 seconds
 * to ingestion time.
 */
export async function generateContextSummaries(
  openai: IOpenAIChatClientProps,
  chunks: IChunkProps[],
  documentContent: string,
): Promise<IContextEnrichmentResultProps[]> {
  if (chunks.length === 0) return [];

  const results: IContextEnrichmentResultProps[] = [];

  for (const chunk of chunks) {
    const prompt = CONTEXT_PROMPT
      .replace('{DOCUMENT_CONTENT}', documentContent)
      .replace('{CHUNK_CONTENT}', chunk.content);

    const response = await openai.chat.completions.create({
      model: CONTEXT_ENRICHMENT_MODEL,
      messages: [
        { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 150,
      temperature: 0,
    });

    const summary = response.choices[0].message.content.trim();

    results.push({
      summary,
      tokenCount: estimateTokenCount(chunk.content),
    });
  }

  return results;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/adrian/repos/ledger && npx vitest run tests/chunk-context-enrichment.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /home/adrian/repos/ledger && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/search/chunk-context-enrichment.ts tests/chunk-context-enrichment.test.ts
git commit -m "feat(enrichment): chunk context enrichment module — LLM summaries per chunk before embedding"
```

---

## Task 4: Update RPC functions in Supabase

Add 3 new parameters to `document_create` and `document_update`: `p_chunk_summaries`, `p_chunk_token_counts`, `p_chunk_overlap`.

**Files:**
- Modify: Supabase SQL (via SQL editor in Dashboard)
- Modify: `docs/ledger-architecture-database-schemas.md`

- [ ] **Step 1: Update `document_create` RPC**

Run in Supabase SQL Editor:

```sql
CREATE OR REPLACE FUNCTION public.document_create(
  p_name text, p_domain text, p_document_type text, p_project text,
  p_protection text, p_owner_type text, p_owner_id text, p_is_auto_load boolean,
  p_content text, p_description text, p_content_hash text,
  p_source_type text DEFAULT 'text', p_source_url text DEFAULT NULL,
  p_file_path text DEFAULT NULL, p_file_permissions text DEFAULT NULL,
  p_agent text DEFAULT NULL, p_status text DEFAULT NULL,
  p_skill_ref text DEFAULT NULL, p_embedding_model_id text DEFAULT NULL,
  p_chunk_contents text[] DEFAULT NULL, p_chunk_embeddings vector[] DEFAULT NULL,
  p_chunk_strategy text DEFAULT 'recursive',
  p_chunk_summaries text[] DEFAULT NULL,
  p_chunk_token_counts int[] DEFAULT NULL,
  p_chunk_overlap int DEFAULT 0
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_doc_id bigint;
  i int;
BEGIN
  INSERT INTO documents (
    name, domain, document_type, project, protection,
    owner_type, owner_id, is_auto_load,
    content, description, content_hash,
    source_type, source_url, file_path, file_permissions,
    agent, status, skill_ref, embedding_model_id
  ) VALUES (
    p_name, p_domain, p_document_type, p_project, p_protection,
    p_owner_type, p_owner_id, p_is_auto_load,
    p_content, p_description, p_content_hash,
    p_source_type, p_source_url, p_file_path, p_file_permissions,
    p_agent, p_status, p_skill_ref, p_embedding_model_id
  ) RETURNING id INTO v_doc_id;

  IF p_chunk_contents IS NOT NULL THEN
    FOR i IN 1..array_length(p_chunk_contents, 1) LOOP
      INSERT INTO document_chunks (
        document_id, chunk_index, content, domain, embedding,
        embedding_model_id, chunk_strategy, context_summary, token_count, overlap_chars
      )
      VALUES (
        v_doc_id, i - 1, p_chunk_contents[i], p_domain, p_chunk_embeddings[i],
        p_embedding_model_id, p_chunk_strategy,
        CASE WHEN p_chunk_summaries IS NOT NULL THEN p_chunk_summaries[i] ELSE NULL END,
        CASE WHEN p_chunk_token_counts IS NOT NULL THEN p_chunk_token_counts[i] ELSE NULL END,
        p_chunk_overlap
      );
    END LOOP;
    UPDATE documents SET chunk_count = array_length(p_chunk_contents, 1) WHERE id = v_doc_id;
  END IF;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (v_doc_id, p_domain, 'create', COALESCE(p_agent, 'unknown'), NULL, now());

  RETURN v_doc_id;
END;
$$;
```

- [ ] **Step 2: Update `document_update` RPC**

Run in Supabase SQL Editor:

```sql
CREATE OR REPLACE FUNCTION public.document_update(
  p_id bigint, p_content text, p_content_hash text,
  p_agent text DEFAULT NULL, p_description text DEFAULT NULL,
  p_status text DEFAULT NULL, p_embedding_model_id text DEFAULT NULL,
  p_chunk_contents text[] DEFAULT NULL, p_chunk_embeddings vector[] DEFAULT NULL,
  p_chunk_strategy text DEFAULT 'recursive',
  p_chunk_summaries text[] DEFAULT NULL,
  p_chunk_token_counts int[] DEFAULT NULL,
  p_chunk_overlap int DEFAULT 0
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_old_content text;
  v_old_domain  text;
  v_version_num int;
  i int;
BEGIN
  SELECT content, domain INTO v_old_content, v_old_domain
  FROM documents WHERE id = p_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document % not found', p_id; END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_num
  FROM document_versions WHERE document_id = p_id;

  INSERT INTO document_versions (document_id, version_number, content, content_hash, agent)
  VALUES (p_id, v_version_num, v_old_content, encode(digest(v_old_content, 'sha256'), 'hex'), COALESCE(p_agent, 'unknown'));

  UPDATE documents SET
    content = p_content, content_hash = p_content_hash,
    agent = COALESCE(p_agent, agent), description = COALESCE(p_description, description),
    status = COALESCE(p_status, status), embedding_model_id = COALESCE(p_embedding_model_id, embedding_model_id)
  WHERE id = p_id;

  IF p_chunk_contents IS NOT NULL THEN
    DELETE FROM document_chunks WHERE document_id = p_id;
    FOR i IN 1..array_length(p_chunk_contents, 1) LOOP
      INSERT INTO document_chunks (
        document_id, chunk_index, content, domain, embedding,
        embedding_model_id, chunk_strategy, context_summary, token_count, overlap_chars
      )
      VALUES (
        p_id, i - 1, p_chunk_contents[i], v_old_domain, p_chunk_embeddings[i],
        p_embedding_model_id, p_chunk_strategy,
        CASE WHEN p_chunk_summaries IS NOT NULL THEN p_chunk_summaries[i] ELSE NULL END,
        CASE WHEN p_chunk_token_counts IS NOT NULL THEN p_chunk_token_counts[i] ELSE NULL END,
        p_chunk_overlap
      );
    END LOOP;
    UPDATE documents SET chunk_count = array_length(p_chunk_contents, 1) WHERE id = p_id;
  END IF;

  INSERT INTO audit_log (document_id, domain, operation, agent, diff, created_at)
  VALUES (p_id, v_old_domain, 'update', COALESCE(p_agent, 'unknown'), jsonb_build_object('content', v_old_content), now());
END;
$$;
```

- [ ] **Step 3: Verify RPC functions updated**

Run in Supabase SQL Editor:

```sql
SELECT proname, pronargs
FROM pg_proc
WHERE proname IN ('document_create', 'document_update')
ORDER BY proname;
```

Expected: `document_create` has 24 args (was 21), `document_update` has 12 args (was 9)

- [ ] **Step 4: Update schema docs**

Update `docs/ledger-architecture-database-schemas.md` to reflect the new RPC parameters. Update both `document_create` and `document_update` sections with the new SQL from steps 1-2. Also update `docs/ledger-architecture-database-functions.md` if it has separate function definitions.

- [ ] **Step 5: Commit docs**

```bash
git add docs/ledger-architecture-database-schemas.md docs/ledger-architecture-database-functions.md
git commit -m "docs: update RPC function definitions with chunk enrichment params"
```

---

## Task 5: Wire enrichment into createDocument and updateDocument

Connect the recursive chunker and context enrichment into the document write path.

**Files:**
- Modify: `src/lib/documents/operations.ts`
- Modify: `src/lib/documents/classification.ts` (add OpenAI chat type to clients)
- Modify: `tests/document-operations.test.ts`

- [ ] **Step 1: Write failing tests for the enriched pipeline**

Add to `tests/document-operations.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createDocument, updateDocument } from '../src/lib/documents/operations.js';

// Mock Supabase that records RPC calls
function makeMockSupabase() {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  return {
    client: {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 1 }, error: null }) }) }) }),
      rpc: vi.fn().mockImplementation(async (name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        return { data: 1, error: null };
      }),
    },
    rpcCalls,
  };
}

// Mock OpenAI that handles both embeddings and chat
function makeMockOpenAI() {
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.01) }],
      }),
    },
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'This chunk is about testing.' } }],
        }),
      },
    },
  };
}

describe('createDocument — enriched pipeline', () => {
  it('passes chunk summaries to RPC', async () => {
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Short content that fits in one chunk.',
    });

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_create');
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.params.p_chunk_summaries).toBeInstanceOf(Array);
    expect(rpcCall!.params.p_chunk_summaries).toHaveLength(1);
    expect(rpcCall!.params.p_chunk_token_counts).toBeInstanceOf(Array);
    expect(rpcCall!.params.p_chunk_token_counts).toHaveLength(1);
  });

  it('uses recursive strategy by default', async () => {
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Content here.',
    });

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_create');
    expect(rpcCall!.params.p_chunk_strategy).toBe('recursive');
  });

  it('calls chat completions for context summaries', async () => {
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Content for enrichment.',
    });

    expect(openai.chat.completions.create).toHaveBeenCalled();
  });

  it('embeds summary + content concatenated', async () => {
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Chunk content.',
    });

    // The embedding input should be summary + "\n\n" + chunk content
    const embeddingCall = openai.embeddings.create.mock.calls[0][0];
    expect(embeddingCall.input).toContain('This chunk is about testing.');
    expect(embeddingCall.input).toContain('Chunk content.');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/adrian/repos/ledger && npx vitest run tests/document-operations.test.ts`
Expected: FAIL — createDocument doesn't use chat completions yet

- [ ] **Step 3: Update IClientsProps to include chat capability**

In `src/lib/documents/classification.ts`, the `IOpenAIClientProps` needs the chat interface. Update it:

```typescript
// OpenAI client — structural type covering embedding generation and chat completions
export interface IOpenAIClientProps {
  embeddings: { create: (params: { model: string; input: string }) => Promise<{ data: Array<{ embedding: number[] }> }> };
  chat: {
    completions: {
      create: (params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        max_tokens?: number;
        temperature?: number;
      }) => Promise<{ choices: Array<{ message: { content: string } }> }>;
    };
  };
}
```

- [ ] **Step 4: Rewrite createDocument and updateDocument**

Update `src/lib/documents/operations.ts`:

```typescript
// document-operations.ts
// Write operations — create, update, delete, restore documents.
// Each function prepares data (chunk, enrich, embed, hash) then calls a Postgres RPC function.
// The database handles transactions (document + chunks + audit = atomic).

import type { IClientsProps, ICreateDocumentProps, IUpdateDocumentProps, IUpdateFieldsProps, IChunkConfigProps } from './classification.js';
import { contentHash, chunkText, generateEmbedding, toVectorString } from '../search/embeddings.js';
import { generateContextSummaries } from '../search/chunk-context-enrichment.js';

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

const DEFAULT_CHUNK_CONFIG: IChunkConfigProps = {
  maxChunkSize: 1000,
  overlapChars: 200,
  strategy: 'recursive',
};

/**
 * Create a new document.
 *
 * Pipeline:
 * 1. Hash the content (change detection)
 * 2. Chunk with recursive splitter
 * 3. Generate context summaries per chunk (LLM call — chunk context enrichment)
 * 4. Embed summary + chunk content (OpenAI embedding call per chunk)
 * 5. Call document_create RPC (atomic: document + chunks + audit)
 */
export async function createDocument(
  clients: IClientsProps,
  props: ICreateDocumentProps,
  chunkConfig?: Partial<IChunkConfigProps>,
): Promise<number> {
  const config = { ...DEFAULT_CHUNK_CONFIG, ...chunkConfig };
  const hash = contentHash(props.content);

  // Chunk
  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);

  // Enrich — generate context summaries per chunk
  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);

  // Embed — summary + "\n\n" + chunk content
  const chunkEmbeddings: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const embeddingInput = chunkSummaries[index] + '\n\n' + chunks[index].content;
    const embedding = await generateEmbedding(clients.openai, embeddingInput);
    chunkEmbeddings.push(toVectorString(embedding));
  }

  const { data, error } = await clients.supabase.rpc('document_create', {
    p_name: props.name,
    p_domain: props.domain,
    p_document_type: props.document_type,
    p_project: props.project ?? null,
    p_protection: props.protection ?? 'open',
    p_owner_type: props.owner_type ?? 'user',
    p_owner_id: props.owner_id ?? null,
    p_is_auto_load: props.is_auto_load ?? false,
    p_content: props.content,
    p_description: props.description ?? null,
    p_content_hash: hash,
    p_source_type: props.source_type ?? 'text',
    p_source_url: props.source_url ?? null,
    p_file_path: props.file_path ?? null,
    p_file_permissions: props.file_permissions ?? null,
    p_agent: props.agent ?? null,
    p_status: props.status ?? null,
    p_skill_ref: props.skill_ref ?? null,
    p_embedding_model_id: props.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
    p_chunk_contents: chunkContents,
    p_chunk_embeddings: chunkEmbeddings,
    p_chunk_strategy: chunks[0]?.strategy ?? config.strategy,
    p_chunk_summaries: chunkSummaries,
    p_chunk_token_counts: chunkTokenCounts,
    p_chunk_overlap: config.overlapChars,
  });

  if (error) throw new Error(`Failed to create document: ${error.message}`);
  return data as number;
}

/**
 * Update a document's content. Triggers re-chunking, re-enrichment, and re-embedding.
 *
 * Same pipeline as createDocument — hash, chunk, enrich, embed — then calls
 * document_update RPC which versions old content before overwriting.
 */
export async function updateDocument(
  clients: IClientsProps,
  props: IUpdateDocumentProps,
  chunkConfig?: Partial<IChunkConfigProps>,
): Promise<void> {
  const config = { ...DEFAULT_CHUNK_CONFIG, ...chunkConfig };
  const hash = contentHash(props.content);

  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);

  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);

  const chunkEmbeddings: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const embeddingInput = chunkSummaries[index] + '\n\n' + chunks[index].content;
    const embedding = await generateEmbedding(clients.openai, embeddingInput);
    chunkEmbeddings.push(toVectorString(embedding));
  }

  const { error } = await clients.supabase.rpc('document_update', {
    p_id: props.id,
    p_content: props.content,
    p_content_hash: hash,
    p_agent: props.agent ?? null,
    p_description: props.description ?? null,
    p_status: props.status ?? null,
    p_embedding_model_id: props.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
    p_chunk_contents: chunkContents,
    p_chunk_embeddings: chunkEmbeddings,
    p_chunk_strategy: chunks[0]?.strategy ?? config.strategy,
    p_chunk_summaries: chunkSummaries,
    p_chunk_token_counts: chunkTokenCounts,
    p_chunk_overlap: config.overlapChars,
  });

  if (error) throw new Error(`Failed to update document: ${error.message}`);
}

// ... (updateDocumentFields, deleteDocument, restoreDocument unchanged) ...
```

- [ ] **Step 5: Run all tests**

Run: `cd /home/admin/repos/ledger && npx vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/documents/operations.ts src/lib/documents/classification.ts tests/document-operations.test.ts
git commit -m "feat(pipeline): wire chunk context enrichment into create/update document path"
```

---

## Task 6: Update eval config

Track the new pipeline settings in eval runs so before/after comparisons are meaningful.

**Files:**
- Modify: `src/lib/eval/eval-store.ts:24-31`

- [ ] **Step 1: Update `CURRENT_SEARCH_CONFIG`**

In `src/lib/eval/eval-store.ts`, update the config:

```typescript
export const CURRENT_SEARCH_CONFIG: IEvalConfigProps = {
  threshold:              0.25,
  reciprocalRankFusionK:  60,
  embedding_model:        'openai/text-embedding-3-small',
  limit:                  10,
  chunking:               'recursive',
  chunk_max_size:         1000,
  chunk_overlap:          200,
  context_enrichment:     true,
  context_enrichment_model: 'gpt-4o-mini',
  reranker:               'none',
};
```

- [ ] **Step 2: Run tests**

Run: `cd /home/adrian/repos/ledger && npx vitest run tests/eval-store.test.ts`
Expected: PASS — config is a plain object, no logic changes

- [ ] **Step 3: Commit**

```bash
git add src/lib/eval/eval-store.ts
git commit -m "feat(eval): track chunking and context enrichment in search config"
```

---

## Task 7: Create bulk re-index script

Script to re-process all existing documents through the new pipeline (recursive chunking + context enrichment). Includes dry-run mode.

**Files:**
- Create: `src/scripts/reindex.ts`

- [ ] **Step 1: Create the re-index script**

Create `src/scripts/reindex.ts`:

```typescript
#!/usr/bin/env npx tsx
// reindex.ts
// Bulk re-index all documents through the new chunking + enrichment pipeline.
// Reads all active documents, re-chunks with recursive splitter, generates
// context summaries, re-embeds, and calls document_update RPC.
//
// Usage:
//   npx tsx src/scripts/reindex.ts              # dry-run (default)
//   npx tsx src/scripts/reindex.ts --execute    # actually re-index
//   npx tsx src/scripts/reindex.ts --id 42      # re-index one document

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { loadConfig } from '../lib/config.js';
import { updateDocument } from '../lib/documents/operations.js';
import type { IDocumentProps } from '../lib/documents/classification.js';

async function main(): Promise<void> {
  const dryRun = !process.argv.includes('--execute');
  const singleIdFlag = process.argv.indexOf('--id');
  const singleId = singleIdFlag !== -1 ? Number(process.argv[singleIdFlag + 1]) : null;

  const config = loadConfig();
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const openai = new OpenAI({ apiKey: config.openaiApiKey });
  const clients = { supabase, openai };

  console.error(dryRun ? '=== DRY RUN (pass --execute to write) ===' : '=== EXECUTING RE-INDEX ===');

  // Fetch documents
  let query = supabase
    .from('documents')
    .select('id, name, content, chunk_count, domain, document_type')
    .is('deleted_at', null)
    .order('id', { ascending: true });

  if (singleId !== null) {
    query = query.eq('id', singleId);
  }

  const { data: documents, error } = await query;
  if (error) throw new Error(`Failed to fetch documents: ${error.message}`);

  const documentList = documents as Pick<IDocumentProps, 'id' | 'name' | 'content' | 'chunk_count' | 'domain' | 'document_type'>[];
  console.error(`Found ${documentList.length} documents to re-index\n`);

  let successCount = 0;
  let failureCount = 0;

  for (const document of documentList) {
    const contentLength = document.content?.length ?? 0;
    const estimatedChunks = Math.max(1, Math.ceil(contentLength / 1000));

    if (dryRun) {
      console.error(`[DRY] #${document.id} ${document.name} — ${contentLength} chars, ${document.chunk_count} chunks → ~${estimatedChunks} chunks`);
      successCount++;
      continue;
    }

    try {
      console.error(`[${successCount + failureCount + 1}/${documentList.length}] #${document.id} ${document.name} — re-indexing...`);

      await updateDocument(clients, {
        id: document.id,
        content: document.content,
        agent: 'reindex-script',
      });

      successCount++;
      console.error(`  ✓ done (${contentLength} chars → ~${estimatedChunks} chunks)`);
    } catch (reindexError) {
      failureCount++;
      console.error(`  ✗ FAILED: ${reindexError instanceof Error ? reindexError.message : String(reindexError)}`);
    }
  }

  console.error(`\n=== Summary ===`);
  console.error(`Success: ${successCount} | Failed: ${failureCount} | Total: ${documentList.length}`);
  if (dryRun) {
    console.error('This was a dry run. Pass --execute to actually re-index.');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
```

- [ ] **Step 2: Verify script compiles**

Run: `cd /home/adrian/repos/ledger && npx tsc --noEmit src/scripts/reindex.ts`
Expected: Clean compile (or check with full build `npm run build`)

- [ ] **Step 3: Test dry run**

Run: `cd /home/adrian/repos/ledger && npx tsx src/scripts/reindex.ts`
Expected: Lists all documents with estimated chunk counts, no writes

- [ ] **Step 4: Commit**

```bash
git add src/scripts/reindex.ts
git commit -m "feat(scripts): bulk re-index script with dry-run mode"
```

---

## Task 8: Live verification

Run the full pipeline end-to-end and verify with eval.

- [ ] **Step 1: Test on a single document**

Run: `cd /home/adrian/repos/ledger && npx tsx src/scripts/reindex.ts --id <pick-a-small-doc-id> --execute`
Expected: Document re-indexed with new chunks, context summaries, and enriched embeddings

- [ ] **Step 2: Verify chunks in database**

Run in Supabase SQL Editor:

```sql
SELECT chunk_index, length(content), context_summary IS NOT NULL as has_summary,
       token_count, overlap_chars, chunk_strategy
FROM document_chunks
WHERE document_id = <same-id>
ORDER BY chunk_index;
```

Expected: All rows have `has_summary = true`, `token_count` populated, `chunk_strategy = 'recursive'`

- [ ] **Step 3: Run eval to measure impact**

Run: `cd /home/adrian/repos/ledger && npx tsx src/scripts/eval-search.ts`
Expected: Eval completes, auto-compares with previous run. Record the metrics.

- [ ] **Step 4: Commit any fixes**

If the live test revealed issues, fix and commit before proceeding to bulk re-index.

---

## Self-Review Checklist

- [x] **Spec coverage:** All 4 design sections covered — recursive chunking (Task 2), context enrichment (Task 3), pipeline integration (Tasks 4-5), eval config (Task 6), re-index script (Task 7), live verification (Task 8)
- [x] **Placeholder scan:** No TBDs, TODOs, or vague steps. Every code step has full code blocks.
- [x] **Type consistency:** `IChunkConfigProps` defined in Task 1, used consistently in Tasks 2, 5. `IContextEnrichmentResultProps` defined in Task 3, consumed in Task 5. `generateContextSummaries()` signature matches between Tasks 3 and 5. `IOpenAIChatClientProps` in Task 3 matches the structural type added to `IOpenAIClientProps` in Task 5.
- [x] **RPC params:** `p_chunk_summaries`, `p_chunk_token_counts`, `p_chunk_overlap` — consistent naming in SQL (Task 4) and TypeScript RPC calls (Task 5)
