// embeddings.ts
// Prepares data for the database: generate embeddings, chunk text, format vectors.
// The database can't call OpenAI or split text — that's TypeScript's job.

import { createHash } from 'crypto';
import type { ChunkStrategy, ChunkContentType, IOpenAIClientProps, ISupabaseClientProps, IChunkConfigProps } from '../documents/classification.js';

// =============================================================================
// Chunk interface — what chunkText() returns
// =============================================================================

export interface IChunkProps {
  content: string;
  chunk_index: number;
  content_type: ChunkContentType;
  strategy: ChunkStrategy;
  overlap_chars: number;
}

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

/**
 * SHA-256 hash of text content.
 * Used for change detection: "has this document's content changed since last sync?"
 * Same algorithm used in Postgres via pgcrypto.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Format a number[] embedding as a Postgres vector string.
 * Supabase RPC can't send number[] as vector(1536) — it needs this string format.
 * Example: [0.021, -0.007, 0.045] → "[0.021,-0.007,0.045]"
 */
export function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Parse a Postgres vector back into a number[].
 * Supabase REST API returns vector(1536) columns as strings like "[0.021,-0.007,0.045]".
 * If the value is already a number[] (e.g. from a mock in tests), it passes through unchanged.
 */
export function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === 'string') return JSON.parse(raw) as number[];
  throw new Error(`Cannot parse vector: expected string or number[], got ${typeof raw}`);
}

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
      chunk_index: 0, // reassigned by caller
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
      chunk_index: 0, // reassigned by caller
      content_type: 'text',
      strategy: 'forced',
      overlap_chars: offset > 0 ? overlapChars : 0,
    });
  }

  return chunks;
}

// =============================================================================
// API functions — call OpenAI and/or database
// =============================================================================

/**
 * Call OpenAI to convert text into an array of 1,536 numbers.
 * These numbers represent the "meaning" of the text in a mathematical space.
 * Similar texts produce similar numbers — that's how search works.
 */
export async function generateEmbedding(openai: IOpenAIClientProps, text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

/**
 * Get an embedding for a search query, using the cache to avoid repeat API calls.
 *
 * Flow:
 * 1. Check query_cache table for this exact query text
 * 2. If cached: return the cached embedding, update hit_count
 * 3. If not cached: call OpenAI, save to cache, return embedding
 *
 * Why cache: each OpenAI embedding call costs money. If you search
 * "how does auth work" three times, the cache saves 2 API calls.
 */
export async function getOrCacheQueryEmbedding(
  clients: { supabase: ISupabaseClientProps; openai: IOpenAIClientProps },
  query: string,
): Promise<number[]> {
  // Normalize query to avoid cache misses from capitalization/whitespace differences
  const normalizedQuery = query.toLowerCase().trim();

  // Check cache
  const { data: cached } = await clients.supabase
    .from('query_cache')
    .select('embedding, hit_count')
    .eq('query_text', normalizedQuery)
    .single();

  if (cached?.embedding) {
    // Update cache stats
    await clients.supabase
      .from('query_cache')
      .update({
        hit_count: (cached.hit_count as number) + 1,
        last_used_at: new Date().toISOString(),
      })
      .eq('query_text', normalizedQuery);

    return parseVector(cached.embedding);
  }

  // Generate and cache — send original query to OpenAI (preserves meaning),
  // but store under normalized key (so "Auth" and "auth" share one cache entry)
  const embedding = await generateEmbedding(clients.openai, query);

  await clients.supabase
    .from('query_cache')
    .insert({
      query_text: normalizedQuery,
      embedding: toVectorString(embedding),
      embedding_model_id: 'openai/text-embedding-3-small',
    });

  return embedding;
}
