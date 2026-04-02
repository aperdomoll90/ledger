// embeddings.ts
// Prepares data for the database: generate embeddings, chunk text, format vectors.
// The database can't call OpenAI or split text — that's TypeScript's job.

import { createHash } from 'crypto';
import type { ChunkStrategy, ChunkContentType, IOpenAIClientProps, ISupabaseClientProps } from '../documents/classification.js';

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
const DEFAULT_MAX_CHUNK_CHARS = 2000;
const DEFAULT_OVERLAP_CHARS = 200;

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
 * Split text into smaller pieces for embedding.
 *
 * Why chunk: embedding models produce better search results on focused text
 * (500-2000 chars) than on large mixed-topic documents (10,000+ chars).
 *
 * How it works:
 * 1. If text is under maxChars, return it as one chunk
 * 2. Split on paragraph boundaries (\n\n)
 * 3. Accumulate paragraphs until a chunk would exceed maxChars
 * 4. Include overlap between chunks so context isn't lost at boundaries
 * 5. Force-split any remaining chunks that are still too long
 */
export function chunkText(
  text: string,
  strategy: ChunkStrategy = 'paragraph',
  maxChars: number = DEFAULT_MAX_CHUNK_CHARS,
  overlapChars: number = DEFAULT_OVERLAP_CHARS,
): IChunkProps[] {
  // Short text = one chunk
  if (text.length <= maxChars) {
    return [{
      content: text,
      chunk_index: 0,
      content_type: 'text',
      strategy,
      overlap_chars: 0,
    }];
  }

  // Split on paragraph boundaries
  const paragraphs = text.split(/\n\n+/);
  const rawChunks: string[] = [];
  let current = '';

  // Greedy paragraph packing — three stages per chunk:
  //
  // 1. First paragraph: size check may pass but current is empty (length 0),
  //    so the guard (current.length > 0) fails → paragraph goes into current.
  // 2. Next paragraphs: current + paragraph + 2 (blank-line separator) still
  //    fits under maxChars → keep appending to current.
  // 3. Overflow: current + paragraph + 2 exceeds maxChars AND current has
  //    content → flush current as a finished chunk, slice its tail as overlap
  //    context, start a new current with that tail + the new paragraph.
  //
  // The guard prevents flushing an empty chunk when a single paragraph is
  // already larger than maxChars — the force-split below handles that case.
  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > maxChars && current.length > 0) {
      rawChunks.push(current.trim());
      // Overlap: carry the end of this chunk into the start of the next
      const overlap = current.slice(-overlapChars);
      current = overlap + '\n\n' + paragraph;
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph;
    }
  }

  // The loop only flushes when a paragraph overflows. After the last paragraph,
  // current may still hold a partially filled chunk that never triggered a flush.
  if (current.trim()) {
    rawChunks.push(current.trim());
  }

  // Force-split any chunks still over maxChars.
  // This handles text with no blank lines (e.g. a JSON blob, base64 string, or
  // a wall of text). The paragraph loop above can't split those — it produces a
  // single oversized chunk because the empty-box guard prevents flushing when
  // current is empty. Here we cut at character positions as a last resort.
  const result: IChunkProps[] = [];
  let finalIndex = 0;

  for (const chunk of rawChunks) {
    if (chunk.length <= maxChars) {
      result.push({
        content: chunk,
        chunk_index: finalIndex,
        content_type: 'text',
        strategy,
        overlap_chars: finalIndex > 0 ? overlapChars : 0,
      });
      finalIndex++;
    } else {
      // Force split at character boundaries (step must be positive)
      const step = Math.max(1, maxChars - overlapChars);
      for (let i = 0; i < chunk.length; i += step) {
        result.push({
          content: chunk.slice(i, i + maxChars),
          chunk_index: finalIndex,
          content_type: 'text',
          strategy: 'forced',
          overlap_chars: i > 0 ? overlapChars : 0,
        });
        finalIndex++;
      }
    }
  }

  return result;
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
