// semantic-cache.ts
// Helpers for the semantic cache (layer 2).
// Handles serialization, deserialization, and parameter normalization
// for cache lookup and store operations.
//
// The actual cache logic (HNSW lookup, store, invalidation) lives in Postgres
// RPC functions. This module prepares data for those calls.

import type { ISearchResultProps } from './ai-search.js';

const EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small';
const SIMILARITY_THRESHOLD = 0.90;

export { EMBEDDING_MODEL_ID as SEMANTIC_CACHE_MODEL_ID };
export { SIMILARITY_THRESHOLD as SEMANTIC_CACHE_THRESHOLD };

// =============================================================================
// Parameter normalization
// =============================================================================

interface IBuildSearchParamsInput {
  threshold?: number;
  limit?: number;
  domain?: string;
  document_type?: string;
  project?: string;
}

/**
 * Build a normalized search_params object for cache key matching.
 * Keys are sorted alphabetically so JSONB equality works regardless
 * of the order properties were passed in.
 * Undefined values are omitted (not set to null) to avoid
 * mismatches between {domain: null} and {}.
 */
export function buildSearchParams(input: IBuildSearchParamsInput): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  // Alphabetical order for consistent JSONB serialization
  if (input.document_type !== undefined) params.document_type = input.document_type;
  if (input.domain !== undefined) params.domain = input.domain;
  if (input.limit !== undefined) params.limit = input.limit;
  if (input.project !== undefined) params.project = input.project;
  if (input.threshold !== undefined) params.threshold = input.threshold;
  return params;
}

// =============================================================================
// Result serialization
// =============================================================================

/**
 * Parse cached_results JSONB from Postgres into typed array.
 * Returns the array directly since we cache full ISearchResultProps objects.
 */
export function parseCachedResults(
  jsonb: ISearchResultProps[] | null,
): ISearchResultProps[] {
  if (!jsonb || jsonb.length === 0) return [];
  return jsonb;
}

/**
 * Extract unique document IDs from search results for the reverse index.
 * These are stored in source_doc_ids so document_update/delete can
 * invalidate affected cache entries.
 */
export function extractSourceDocIds(
  results: Array<{ id: number }>,
): number[] {
  return [...new Set(results.map(result => result.id))];
}
