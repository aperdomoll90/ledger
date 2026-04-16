// ai-search.ts
// AI-powered search — vector (meaning), keyword (exact words), hybrid (both combined).
// Each function calls a Postgres RPC function that does the actual search.
// TypeScript's job: generate the query embedding, then call the right function.

import type { Domain, Protection, DocumentStatus, ISupabaseClientProps, IClientsProps } from '../documents/classification.js';
import { getOrCacheQueryEmbedding, toVectorString } from './embeddings.js';
import { rerankResults } from './reranker.js';
import {
  buildSearchParams,
  extractSourceDocIds,
  SEMANTIC_CACHE_MODEL_ID,
  SEMANTIC_CACHE_THRESHOLD,
} from './semantic-cache.js';
import { runSearchTrace, startSpan, recordChildSpan } from '../observability.js';

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
  reciprocalRankFusionK?: number;
  reranker?: 'none' | 'cohere';
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
// Search evaluation logging
// =============================================================================

/**
 * Log a search to the search_evaluations table.
 * Called after every search — silently records what was searched,
 * what came back, and how long it took. This is the raw data
 * that powers all evaluation, quality tracking, and improvement.
 *
 * Fire-and-forget: we don't await this. If logging fails,
 * the search still returns results. The user never waits for logging.
 */
function logSearchEvaluation(
  supabase: ISupabaseClientProps,
  params: {
    query: string;
    searchMode: 'vector' | 'keyword' | 'hybrid' | 'hybrid+rerank';
    results: ISearchResultProps[];
    responseTimeMs: number;
  },
): void {
  // Extract unique document_types and source_types from results
  // These tell us which types of documents search finds well vs poorly
  const documentTypes = [...new Set(params.results.map(result => result.document_type))];

  // Build the results JSONB array — just IDs and scores, not full content
  const resultsSummary = params.results.map(result => ({
    id: result.id,
    score: result.similarity ?? result.rank ?? result.score ?? null,
    document_type: result.document_type,
  }));

  // Fire and forget — don't await, don't block the search response
  supabase
    .from('search_evaluations')
    .insert({
      query_text: params.query,
      search_mode: params.searchMode,
      result_count: params.results.length,
      results: resultsSummary,
      document_types: documentTypes,
      response_time_ms: params.responseTimeMs,
    })
    .then(() => {})
    .catch((logError: { message?: string }) => {
      process.stderr.write(`[ledger] search evaluation logging failed: ${logError.message ?? 'unknown error'}\n`);
    });
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
  const startTime = Date.now();

  return runSearchTrace({
    mode: 'vector',
    query: props.query,
    environment: clients.observabilityEnvironment,
    sessionId: clients.sessionId,
    input: {
      query: props.query,
      filters: { domain: props.domain, project: props.project, document_type: props.document_type },
    },
    metadata: { threshold: props.threshold ?? 0.38, limit: props.limit ?? 10 },
  }, async (trace) => {

  const queryEmbedding = await getOrCacheQueryEmbedding(clients, props.query);
  const embeddingString = toVectorString(queryEmbedding);

  // Semantic cache lookup (layer 2)
  const searchParams = buildSearchParams({
    threshold: props.threshold ?? 0.38,
    limit: props.limit ?? 10,
    domain: props.domain,
    document_type: props.document_type,
    project: props.project,
  });

  const cacheSpan = startSpan('semantic-cache-lookup');
  const { data: cachedResults } = await clients.supabase.rpc('semantic_cache_lookup', {
    p_query_embedding: embeddingString,
    p_search_mode: 'vector',
    p_search_params: searchParams,
    p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
    p_similarity_threshold: SEMANTIC_CACHE_THRESHOLD,
  });
  const cacheHit = !!(cachedResults && (cachedResults as ISearchResultProps[]).length > 0);
  cacheSpan.update({ output: { hit: cacheHit } });
  cacheSpan.end();

  if (cacheHit) {
    const results = cachedResults as ISearchResultProps[];
    trace.update({
      output: {
        resultCount: results.length,
        topResultIds: results.slice(0, 3).map(result => result.id),
        cacheHit: true,
      },
    });
    logSearchEvaluation(clients.supabase, {
      query: props.query,
      searchMode: 'vector',
      results,
      responseTimeMs: Date.now() - startTime,
    });
    return results;
  }

  // Cache miss: run full search pipeline
  const retrieveSpan = startSpan('retrieve');
  const { data, error } = await clients.supabase.rpc('match_documents', {
    q_emb: embeddingString,
    p_threshold: props.threshold ?? 0.38,
    p_max_results: props.limit ?? 10,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
  });

  if (error) {
    retrieveSpan.update({ output: { error: error.message } });
    retrieveSpan.end();
    trace.update({ output: { error: error.message } });
    throw new Error(`Vector search failed for "${props.query}": ${error.message}`);
  }
  const results = (data ?? []) as ISearchResultProps[];
  retrieveSpan.update({ output: { rowCount: results.length } });
  retrieveSpan.end();

  // Store in semantic cache (non-blocking)
  if (results.length > 0) {
    const sourceDocIds = extractSourceDocIds(results);
    const storeSpan = startSpan('semantic-cache-store');
    Promise.resolve(clients.supabase.rpc('semantic_cache_store', {
      p_query_text: props.query,
      p_query_embedding: embeddingString,
      p_search_mode: 'vector',
      p_search_params: searchParams,
      p_cached_results: results,
      p_source_doc_ids: sourceDocIds,
      p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
    })).then(() => {
      storeSpan.end();
    }).catch((cacheStoreError: { message?: string }) => {
      storeSpan.update({ output: { error: cacheStoreError.message ?? 'unknown' } });
      storeSpan.end();
      process.stderr.write(`[ledger] semantic cache store failed: ${cacheStoreError.message ?? 'unknown'}\n`);
    });
  }

  trace.update({
    output: {
      resultCount: results.length,
      topResultIds: results.slice(0, 3).map(result => result.id),
      cacheHit: false,
    },
  });

  logSearchEvaluation(clients.supabase, {
    query: props.query,
    searchMode: 'vector',
    results,
    responseTimeMs: Date.now() - startTime,
  });

  return results;
  });
}

/**
 * Search by exact words — "pgvector HNSW" finds documents containing those words.
 *
 * No embedding needed — Postgres uses the search_vector column (GIN index)
 * to match words directly. Good for code identifiers, proper nouns, error messages.
 */
export async function searchByKeyword(
  clients: IClientsProps,
  props: IKeywordSearchProps,
): Promise<ISearchResultProps[]> {
  const startTime = Date.now();

  return runSearchTrace({
    mode: 'keyword',
    query: props.query,
    environment: clients.observabilityEnvironment,
    sessionId: clients.sessionId,
    input: {
      query: props.query,
      filters: { domain: props.domain, project: props.project, document_type: props.document_type },
    },
    metadata: { limit: props.limit ?? 10 },
  }, async (trace) => {

  const { data, error } = await clients.supabase.rpc('match_documents_keyword', {
    p_query: props.query,
    p_max_results: props.limit ?? 10,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
  });

  if (error) {
    trace.update({ output: { error: error.message } });
    throw new Error(`Keyword search failed for "${props.query}": ${error.message}`);
  }
  const results = (data ?? []) as ISearchResultProps[];

  trace.update({
    output: {
      resultCount: results.length,
      topResultIds: results.slice(0, 3).map(result => result.id),
      cacheHit: false,
    },
  });

  logSearchEvaluation(clients.supabase, {
    query: props.query,
    searchMode: 'keyword',
    results,
    responseTimeMs: Date.now() - startTime,
  });

  return results;
  });
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
  const startTime = Date.now();

  // When reranking, fetch more candidates so the reranker has a bigger pool.
  // The reranker will select the best N from this larger set.
  const useReranker = props.reranker === 'cohere' && clients.cohereApiKey;
  const desiredLimit = props.limit ?? 10;
  const requestLimit = useReranker ? desiredLimit * 2 : desiredLimit;

  return runSearchTrace({
    mode: useReranker ? 'hybrid+rerank' : 'hybrid',
    query: props.query,
    environment: clients.observabilityEnvironment,
    sessionId: clients.sessionId,
    input: {
      query: props.query,
      filters: { domain: props.domain, project: props.project, document_type: props.document_type },
    },
    metadata: {
      threshold: props.threshold ?? 0.38,
      limit: desiredLimit,
      rerankerEnabled: !!useReranker,
      reciprocalRankFusionK: props.reciprocalRankFusionK ?? 60,
    },
  }, async (trace) => {

  const queryEmbedding = await getOrCacheQueryEmbedding(clients, props.query);
  const embeddingString = toVectorString(queryEmbedding);

  // Semantic cache lookup (layer 2)
  // Skip cache when reranker is enabled (reranker produces different ordering)
  const searchParams = buildSearchParams({
    threshold: props.threshold ?? 0.38,
    limit: requestLimit,
    domain: props.domain,
    document_type: props.document_type,
    project: props.project,
  });

  if (!useReranker) {
    const cacheSpan = startSpan('semantic-cache-lookup');
    const { data: cachedResults } = await clients.supabase.rpc('semantic_cache_lookup', {
      p_query_embedding: embeddingString,
      p_search_mode: 'hybrid',
      p_search_params: searchParams,
      p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
      p_similarity_threshold: SEMANTIC_CACHE_THRESHOLD,
    });
    const cacheHit = !!(cachedResults && (cachedResults as ISearchResultProps[]).length > 0);
    cacheSpan.update({ output: { hit: cacheHit } });
    cacheSpan.end();

    if (cacheHit) {
      const cachedRows = cachedResults as ISearchResultProps[];
      trace.update({
        output: {
          resultCount: cachedRows.length,
          topResultIds: cachedRows.slice(0, 3).map(result => result.id),
          cacheHit: true,
        },
      });
      logSearchEvaluation(clients.supabase, {
        query: props.query,
        searchMode: 'hybrid',
        results: cachedRows,
        responseTimeMs: Date.now() - startTime,
      });
      return cachedRows;
    }
  }

  // Cache miss: run full search pipeline
  const retrieveSpan = startSpan('retrieve');
  const retrieveStart = Date.now();
  const { data, error } = await clients.supabase.rpc('match_documents_hybrid', {
    q_emb: embeddingString,
    q_text: props.query,
    p_threshold: props.threshold ?? 0.38,
    p_max_results: requestLimit,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
    p_rrf_k: props.reciprocalRankFusionK ?? 60,
  });

  if (error) {
    retrieveSpan.update({ output: { error: error.message } });
    retrieveSpan.end();
    trace.update({ output: { error: error.message } });
    throw new Error(`Hybrid search failed for "${props.query}": ${error.message}`);
  }

  type HybridRow = ISearchResultProps & {
    timing?: { vector_ms: number; keyword_ms: number; fusion_ms: number };
  };
  const rows = (data ?? []) as HybridRow[];
  const timing = rows[0]?.timing;
  retrieveSpan.update({ output: { rowCount: rows.length, timing } });
  retrieveSpan.end();

  // Emit three child spans from the Postgres timing sidecar.
  // Spans are backdated from retrieveStart using the measured ms deltas.
  if (timing) {
    let cursor = retrieveStart;
    recordChildSpan('retrieve.vector', cursor, cursor + timing.vector_ms, { durationMs: timing.vector_ms });
    cursor += timing.vector_ms;
    recordChildSpan('retrieve.keyword', cursor, cursor + timing.keyword_ms, { durationMs: timing.keyword_ms });
    cursor += timing.keyword_ms;
    recordChildSpan('retrieve.fusion', cursor, cursor + timing.fusion_ms, { durationMs: timing.fusion_ms });
  }

  // Strip timing from rows before exposing to callers (internal sidecar only).
  let results: ISearchResultProps[] = rows.map(({ timing: _timing, ...rest }) => rest);

  // Rerank: send candidates to Cohere cross-encoder for re-scoring.
  // If reranking fails, results are returned unchanged (graceful degradation).
  if (useReranker && results.length > 0) {
    const rerankSpan = startSpan('rerank');
    const inputCount = results.length;
    results = await rerankResults(props.query, results, {
      apiKey: clients.cohereApiKey!,
      topN: desiredLimit,
    });
    rerankSpan.update({ output: { inputCount, outputCount: results.length } });
    rerankSpan.end();
  }

  // Store in semantic cache (non-blocking, skip if reranker was used)
  if (results.length > 0 && !useReranker) {
    const sourceDocIds = extractSourceDocIds(results);
    const storeSpan = startSpan('semantic-cache-store');
    Promise.resolve(clients.supabase.rpc('semantic_cache_store', {
      p_query_text: props.query,
      p_query_embedding: embeddingString,
      p_search_mode: 'hybrid',
      p_search_params: searchParams,
      p_cached_results: results,
      p_source_doc_ids: sourceDocIds,
      p_embedding_model_id: SEMANTIC_CACHE_MODEL_ID,
    })).then(() => {
      storeSpan.end();
    }).catch((cacheStoreError: { message?: string }) => {
      storeSpan.update({ output: { error: cacheStoreError.message ?? 'unknown' } });
      storeSpan.end();
      process.stderr.write(`[ledger] semantic cache store failed: ${cacheStoreError.message ?? 'unknown'}\n`);
    });
  }

  trace.update({
    output: {
      resultCount: results.length,
      topResultIds: results.slice(0, 3).map(result => result.id),
      cacheHit: false,
    },
  });

  logSearchEvaluation(clients.supabase, {
    query: props.query,
    searchMode: useReranker ? 'hybrid+rerank' : 'hybrid',
    results,
    responseTimeMs: Date.now() - startTime,
  });

  return results;
  });
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

  if (error) throw new Error(`Context retrieval failed for document #${props.document_id}, chunk ${props.matched_chunk_index}: ${error.message}`);
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  return (Array.isArray(data) ? data[0] : data) as IContextResultProps;
}
