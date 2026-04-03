// reranker.test.ts
// Unit tests for reranker.ts — Cohere cross-encoder reranking.
// Uses mocked fetch to avoid real API calls in tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rerankResults } from '../src/lib/search/reranker.js';
import type { ISearchResultProps } from '../src/lib/search/ai-search.js';

// =============================================================================
// Helpers
// =============================================================================

function makeSearchResult(
  id: number,
  name: string,
  content: string,
  score: number,
): ISearchResultProps {
  return {
    id, content, name, domain: 'general', document_type: 'knowledge',
    project: null, protection: 'open', description: null, agent: null,
    status: null, file_path: null, skill_ref: null, owner_type: 'user',
    owner_id: null, is_auto_load: false, content_hash: null, score,
  };
}

// Mock global fetch for Cohere API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

// =============================================================================
// Tests
// =============================================================================

describe('rerankResults', () => {
  it('re-sorts results by Cohere relevance score', async () => {
    const searchResults = [
      makeSearchResult(1, 'doc-irrelevant', 'Irrelevant content about cooking', 0.02),
      makeSearchResult(2, 'doc-relevant', 'Database schema with pgvector', 0.019),
      makeSearchResult(3, 'doc-filler', 'More irrelevant filler text', 0.018),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.12 },
          { index: 2, relevance_score: 0.05 },
        ],
      }),
    });

    const reranked = await rerankResults('database schema', searchResults, {
      apiKey: 'test-key',
      topN: 3,
    });

    // doc-2 (relevant) should be first now
    expect(reranked[0].id).toBe(2);
    expect(reranked[0].score).toBe(0.95);
    expect(reranked[1].id).toBe(1);
    expect(reranked[1].score).toBe(0.12);
    expect(reranked[2].id).toBe(3);
    expect(reranked[2].score).toBe(0.05);
  });

  it('returns only topN results when topN is less than input length', async () => {
    const searchResults = [
      makeSearchResult(1, 'doc-1', 'Content A', 0.02),
      makeSearchResult(2, 'doc-2', 'Content B', 0.019),
      makeSearchResult(3, 'doc-3', 'Content C', 0.018),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.90 },
          { index: 0, relevance_score: 0.50 },
        ],
      }),
    });

    const reranked = await rerankResults('test query', searchResults, {
      apiKey: 'test-key',
      topN: 2,
    });

    expect(reranked).toHaveLength(2);
  });

  it('returns original results unchanged when API returns error', async () => {
    const searchResults = [
      makeSearchResult(1, 'doc-1', 'Content A', 0.02),
      makeSearchResult(2, 'doc-2', 'Content B', 0.019),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal server error',
    });

    const reranked = await rerankResults('test query', searchResults, {
      apiKey: 'test-key',
      topN: 2,
    });

    // Graceful degradation — return originals unchanged
    expect(reranked).toEqual(searchResults);
  });

  it('returns original results when network fails', async () => {
    const searchResults = [
      makeSearchResult(1, 'doc-1', 'Content A', 0.02),
    ];

    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const reranked = await rerankResults('test query', searchResults, {
      apiKey: 'test-key',
      topN: 1,
    });

    expect(reranked).toEqual(searchResults);
  });

  it('returns empty array for empty input without calling API', async () => {
    const reranked = await rerankResults('test query', [], {
      apiKey: 'test-key',
      topN: 10,
    });

    expect(reranked).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends correct request shape to Cohere API', async () => {
    const searchResults = [
      makeSearchResult(1, 'doc-1', 'Test content here', 0.02),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ index: 0, relevance_score: 0.8 }],
      }),
    });

    await rerankResults('my query', searchResults, {
      apiKey: 'my-api-key',
      topN: 1,
    });

    // Verify the request was made correctly
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cohere.com/v2/rerank',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer my-api-key',
          'Content-Type': 'application/json',
        }),
      }),
    );

    // Verify request body shape
    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.model).toBe('rerank-v3.5');
    expect(requestBody.query).toBe('my query');
    expect(requestBody.documents).toHaveLength(1);
    expect(requestBody.documents[0].text).toBe('Test content here');
    expect(requestBody.top_n).toBe(1);
  });

  it('does not leak API key in request body', async () => {
    const searchResults = [
      makeSearchResult(1, 'doc-1', 'Content', 0.02),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [{ index: 0, relevance_score: 0.8 }],
      }),
    });

    await rerankResults('query', searchResults, {
      apiKey: 'secret-key-123',
      topN: 1,
    });

    // API key should be in header only, never in body
    const requestBody = mockFetch.mock.calls[0][1].body;
    expect(requestBody).not.toContain('secret-key-123');

    // But it should be in the Authorization header
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer secret-key-123');
  });
});
