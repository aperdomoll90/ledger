// ai-search.ts
// AI-powered search — vector (meaning), keyword (exact words), hybrid (both combined).
// Each function calls a Postgres RPC function that does the actual search.
// TypeScript's job: generate the query embedding, then call the right function.

import type { Domain, Protection, DocumentStatus, ISupabaseClientProps, IClientsProps } from './document-classification.js';
import { getOrCacheQueryEmbedding, toVectorString } from './embeddings.js';

// =============================================================================
// Search result interfaces
// =============================================================================

/**
 * What Postgres search functions return — flat columns, no JSONB wrapper.
 * All three search functions (match_documents, match_documents_keyword,
 * match_documents_hybrid) return the same columns. Only the scoring
 * column differs: similarity (vector), rank (keyword), score (hybrid).
 */
export interface ISearchResultProps {
  id: number;
  content: string;
  name: string;
  domain: Domain;
  document_type: string;
  project: string | null;
  protection: Protection;
  description: string | null;
  agent: string | null;
  status: DocumentStatus | null;
  file_path: string | null;
  skill_ref: string | null;
  owner_type: string;
  owner_id: string | null;
  is_auto_load: boolean;
  content_hash: string | null;
  similarity?: number;
  rank?: number;
  score?: number;
}

export interface IVectorSearchProps {
  query: string;
  threshold?: number;
  limit?: number;
  domain?: Domain;
  document_type?: string;
  project?: string;
}

export interface IKeywordSearchProps {
  query: string;
  limit?: number;
  domain?: Domain;
  document_type?: string;
  project?: string;
}

export interface IHybridSearchProps {
  query: string;
  threshold?: number;
  limit?: number;
  domain?: Domain;
  document_type?: string;
  project?: string;
  rrf_k?: number;
}

export interface IRetrieveContextProps {
  document_id: number;
  matched_chunk_index: number;
  context_window?: number;
  neighbor_count?: number;
}

export interface IContextResultProps {
  document_id: number;
  document_name: string;
  retrieval_mode: 'full' | 'chunked';
  content: string;
  matched_section: string;
}

// =============================================================================
// Search functions
// =============================================================================

/**
 * Search by meaning — "how does auth work?" finds documents about OAuth.
 *
 * Flow:
 * 1. Convert query text to an embedding (array of 1,536 numbers) via OpenAI
 * 2. Check the query_cache first to avoid repeat API calls
 * 3. Call match_documents RPC — Postgres compares the query embedding
 *    against every chunk's embedding using cosine similarity
 * 4. Return matching documents sorted by similarity
 */
export async function searchByVector(
  clients: IClientsProps,
  props: IVectorSearchProps,
): Promise<ISearchResultProps[]> {
  const queryEmbedding = await getOrCacheQueryEmbedding(clients, props.query);

  const { data, error } = await clients.supabase.rpc('match_documents', {
    q_emb: toVectorString(queryEmbedding),
    p_threshold: props.threshold ?? 0.25,
    p_max_results: props.limit ?? 10,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
  });

  if (error) throw new Error(`Vector search failed: ${error.message}`);
  return (data ?? []) as ISearchResultProps[];
}

/**
 * Search by exact words — "pgvector HNSW" finds documents containing those words.
 *
 * No embedding needed — Postgres uses the search_vector column (GIN index)
 * to match words directly. Good for code identifiers, proper nouns, error messages.
 */
export async function searchByKeyword(
  supabase: ISupabaseClientProps,
  props: IKeywordSearchProps,
): Promise<ISearchResultProps[]> {
  const { data, error } = await supabase.rpc('match_documents_keyword', {
    p_query: props.query,
    p_max_results: props.limit ?? 10,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
  });

  if (error) throw new Error(`Keyword search failed: ${error.message}`);
  return (data ?? []) as ISearchResultProps[];
}

/**
 * Combined search — runs both vector AND keyword, merges results with RRF fusion.
 *
 * Documents found by both methods rank highest. This is the default search mode
 * because it handles both meaning-based queries ("how does auth work?") and
 * exact-term queries ("pgvector HNSW") well.
 *
 * RRF (Reciprocal Rank Fusion) formula:
 *   score = 1/(k + vector_rank) + 1/(k + keyword_rank)
 *   k=60 is a smoothing constant that prevents the #1 result from dominating.
 */
export async function searchHybrid(
  clients: IClientsProps,
  props: IHybridSearchProps,
): Promise<ISearchResultProps[]> {
  const queryEmbedding = await getOrCacheQueryEmbedding(clients, props.query);

  const { data, error } = await clients.supabase.rpc('match_documents_hybrid', {
    q_emb: toVectorString(queryEmbedding),
    q_text: props.query,
    p_threshold: props.threshold ?? 0.25,
    p_max_results: props.limit ?? 10,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
    p_rrf_k: props.rrf_k ?? 60,
  });

  if (error) throw new Error(`Hybrid search failed: ${error.message}`);
  return (data ?? []) as ISearchResultProps[];
}

/**
 * Smart retrieval — decide how much content to send to the LLM.
 *
 * After search finds a matching document, this decides:
 * - Small document (under context_window chars) → return full content
 * - Large document → return only the matched chunk + neighbors
 *
 * Why: sending a 50,000-char document to the LLM when only one section
 * is relevant wastes tokens and money. But sending only a 500-char chunk
 * might miss context. This finds the balance.
 */
export async function retrieveContext(
  supabase: ISupabaseClientProps,
  props: IRetrieveContextProps,
): Promise<IContextResultProps | null> {
  const { data, error } = await supabase.rpc('retrieve_context', {
    p_document_id: props.document_id,
    p_matched_chunk_index: props.matched_chunk_index,
    p_context_window: props.context_window ?? 4000,
    p_neighbor_count: props.neighbor_count ?? 1,
  });

  if (error) throw new Error(`Context retrieval failed: ${error.message}`);
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  return (Array.isArray(data) ? data[0] : data) as IContextResultProps;
}
