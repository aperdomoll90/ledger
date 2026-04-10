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
import { openaiLimiter } from '../rate-limiter.js';

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

    try {
      const response = await openaiLimiter.schedule(() =>
        openai.chat.completions.create({
          model: CONTEXT_ENRICHMENT_MODEL,
          messages: [
            { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 150,
          temperature: 0,
        }),
      );

      const summary = (response.choices[0].message.content ?? '').trim();

      results.push({
        summary,
        tokenCount: estimateTokenCount(chunk.content),
      });
    } catch (error) {
      const preview = chunk.content.slice(0, 60).replace(/\n/g, ' ');
      throw new Error(
        `Context summary failed for chunk ${chunk.chunk_index} ("${preview}..."): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return results;
}
