// chunk-context-enrichment.ts
// Pre-embedding enrichment — generates context summaries per chunk using an LLM.
//
// Implements the "Contextual Retrieval" technique (Anthropic, 2024).
// We call it "chunk context enrichment" because the code operates at ingestion
// time, enriching chunks with document context before embedding — not at
// retrieval time. The industry name describes the goal (better retrieval),
// not the action.
//
// Optimized pipeline (S38):
// 1. Generate a document summary (one LLM call, processes full document once)
// 2. For each chunk, build context from: summary + header path + neighbor chunks
// 3. Fire all LLM calls in parallel (rate limiter controls concurrency)
// 4. Each call processes ~1K tokens instead of ~18K (95% token reduction)
//
// This reduces ingestion of a 73K document from ~12 minutes to ~30 seconds.
// The key insight: truncated context (summary + neighbors instead of full doc)
// reduces per-call tokens enough to unblock parallelism without hitting
// the TPM (Tokens Per Minute) limit.

import type { IChunkProps } from './embeddings.js';
import { openaiLimiter } from '../rate-limiter.js';

const CONTEXT_ENRICHMENT_MODEL = 'gpt-4o-mini';

const SUMMARY_PROMPT = `Summarize this document in 150-200 words. Focus on: what the document is about, its structure, and the key topics it covers. Be factual and concise.

<document>
{DOCUMENT_CONTENT}
</document>`;

const CONTEXT_PROMPT = `Here is a summary of the document:
<document_summary>
{DOCUMENT_SUMMARY}
</document_summary>

Here is the section this chunk belongs to (header path):
<section>
{HEADER_PATH}
</section>

Here are the neighboring chunks for context:
<previous_chunk>
{PREV_CHUNK}
</previous_chunk>

<chunk>
{CHUNK_CONTENT}
</chunk>

<next_chunk>
{NEXT_CHUNK}
</next_chunk>

Write a short context (2-3 sentences) that situates this chunk within the document. Include the document's topic and what specific information this chunk covers. Be concise and factual.`;

// =============================================================================
// Interfaces
// =============================================================================

export interface IContextEnrichmentResultProps {
  summary: string;
  tokenCount: number;
}

// OpenAI chat client — structural type to avoid importing the heavy package.
// Same pattern as IOpenAIClientProps in classification.ts for embeddings.
export interface IOpenAIChatClientProps {
  chat: {
    completions: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (...args: any[]) => PromiseLike<{ choices: Array<{ message: { content: string | null } }> }>;
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

/**
 * Find the markdown header hierarchy for a chunk's position in the document.
 * Returns a path like "Database > Caching > semantic_cache".
 * Uses string matching, no LLM call needed.
 */
export function findHeaderPath(documentContent: string, chunkContent: string): string {
  const lines = documentContent.split('\n');
  const headers: string[] = [];
  let foundChunk = false;

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^(#+)/)?.[1].length ?? 1;
      while (headers.length >= level) headers.pop();
      headers.push(line.replace(/^#+\s*/, '').trim());
    }
    if (line.includes(chunkContent.slice(0, 50))) {
      foundChunk = true;
      break;
    }
  }

  return foundChunk ? headers.join(' > ') : '';
}

// =============================================================================
// LLM functions
// =============================================================================

/**
 * Generate context summaries for each chunk using an LLM.
 *
 * Optimized pipeline:
 * 1. Generate a document summary (one LLM call)
 * 2. For each chunk, send summary + header path + neighbors (not the full document)
 * 3. All chunk enrichment calls run in parallel via the rate limiter
 *
 * This produces context summaries of equivalent quality while using 95% fewer
 * tokens and completing 25x faster for large documents.
 */
export async function generateContextSummaries(
  openai: IOpenAIChatClientProps,
  chunks: IChunkProps[],
  documentContent: string,
): Promise<IContextEnrichmentResultProps[]> {
  if (chunks.length === 0) return [];

  // Step 1: Generate document summary (one LLM call, full document)
  const summaryPrompt = SUMMARY_PROMPT.replace('{DOCUMENT_CONTENT}', documentContent);

  const summaryResponse = await openaiLimiter.schedule(() =>
    openai.chat.completions.create({
      model: CONTEXT_ENRICHMENT_MODEL,
      messages: [
        { role: 'system', content: 'You are a precise technical writer. Output only the summary, nothing else.' },
        { role: 'user', content: summaryPrompt },
      ],
      max_tokens: 300,
      temperature: 0,
    }),
  );
  const docSummary = (summaryResponse.choices[0].message.content ?? '').trim();

  // Step 2: Parallel enrichment with truncated context
  const promises = chunks.map((chunk, i) => {
    const prevChunk = i > 0 ? chunks[i - 1].content : '(start of document)';
    const nextChunk = i < chunks.length - 1 ? chunks[i + 1].content : '(end of document)';
    const headerPath = findHeaderPath(documentContent, chunk.content);

    const prompt = CONTEXT_PROMPT
      .replace('{DOCUMENT_SUMMARY}', docSummary)
      .replace('{HEADER_PATH}', headerPath || '(unknown section)')
      .replace('{PREV_CHUNK}', prevChunk)
      .replace('{CHUNK_CONTENT}', chunk.content)
      .replace('{NEXT_CHUNK}', nextChunk);

    return openaiLimiter.schedule({ id: `enrich-${i}` }, async () => {
      try {
        const response = await openai.chat.completions.create({
          model: CONTEXT_ENRICHMENT_MODEL,
          messages: [
            { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 150,
          temperature: 0,
        });

        return {
          index: i,
          summary: (response.choices[0].message.content ?? '').trim(),
          tokenCount: estimateTokenCount(chunk.content),
        };
      } catch (error) {
        const preview = chunk.content.slice(0, 60).replace(/\n/g, ' ');
        throw new Error(
          `Context summary failed for chunk ${chunk.chunk_index} ("${preview}..."): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  });

  const results = await Promise.all(promises);
  // Sort back to original order (parallel execution may complete out of order)
  results.sort((a, b) => a.index - b.index);

  return results.map(r => ({
    summary: r.summary,
    tokenCount: r.tokenCount,
  }));
}
