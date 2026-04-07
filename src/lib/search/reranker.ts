// reranker.ts
// Cross-encoder reranking via Cohere Rerank API.
//
// After hybrid search returns candidates, this module re-scores each one
// by sending (query, document) pairs to a cross-encoder model. The model
// reads query and document together — much more accurate than embedding
// similarity, which encodes them separately.
//
// Uses native fetch — no Cohere SDK dependency. The API is one endpoint,
// one request shape, one response shape.
//
// Graceful degradation: if the API fails, returns original results unchanged.
// Search should never break because reranking failed.

import type { ISearchResultProps } from './ai-search.js';

const COHERE_RERANK_URL = 'https://api.cohere.com/v2/rerank';
const COHERE_RERANK_MODEL = 'rerank-v3.5';

// =============================================================================
// Types
// =============================================================================

export interface IRerankOptionsProps {
  apiKey: string;
  topN?: number;
  model?: string;
}

interface ICohereRerankResult {
  index: number;
  relevance_score: number;
}

interface ICohereRerankResponse {
  results: ICohereRerankResult[];
}

// =============================================================================
// rerankResults
// =============================================================================

/**
 * Re-rank search results using Cohere's cross-encoder model.
 *
 * Sends each result's content + the query to Cohere, which scores
 * how well each document answers the query (0 to 1). Results are
 * re-sorted by this relevance score (highest first).
 *
 * The score field on each result is replaced with the Cohere
 * relevance score — this is intentional. The original RRF score
 * is a ranking position, not a quality signal. The reranker score
 * IS a quality signal (how relevant is this document to this query).
 *
 * Security: API key is sent only in the Authorization header,
 * never in the request body. Document content IS sent to Cohere
 * for scoring — same data flow as OpenAI embeddings.
 */
export async function rerankResults(
  query: string,
  searchResults: ISearchResultProps[],
  options: IRerankOptionsProps,
): Promise<ISearchResultProps[]> {
  if (searchResults.length === 0) return [];

  const topN = options.topN ?? searchResults.length;
  const model = options.model ?? COHERE_RERANK_MODEL;

  const documents = searchResults.map(searchResult => ({
    text: searchResult.content,
  }));

  let response: Response;
  try {
    response = await fetch(COHERE_RERANK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        query,
        documents,
        top_n: topN,
      }),
    });
  } catch (_networkError) {
    // Network failure — return originals unchanged
    return searchResults;
  }

  if (!response.ok) {
    // API error (rate limit, bad key, server error) — return originals unchanged
    return searchResults;
  }

  const cohereResponse = (await response.json()) as ICohereRerankResponse;

  // Map Cohere results back to our search results, re-sorted by relevance.
  // Cohere returns results sorted by relevance_score (highest first).
  // Each result has an 'index' pointing to the original position in our input array.
  const rerankedResults: ISearchResultProps[] = cohereResponse.results.map(
    (cohereResult) => ({
      ...searchResults[cohereResult.index],
      score: cohereResult.relevance_score,
    }),
  );

  return rerankedResults;
}
