import { describe, it, expect } from 'vitest';
import { buildSearchParams, parseCachedResults, extractSourceDocIds } from '../src/lib/search/semantic-cache.js';

describe('buildSearchParams', () => {
  it('builds params with all fields', () => {
    const params = buildSearchParams({
      threshold: 0.38,
      limit: 10,
      domain: 'project',
      document_type: 'architecture',
      project: 'ledger',
    });
    expect(params).toEqual({
      threshold: 0.38,
      limit: 10,
      domain: 'project',
      document_type: 'architecture',
      project: 'ledger',
    });
  });

  it('omits undefined fields', () => {
    const params = buildSearchParams({
      threshold: 0.38,
      limit: 10,
    });
    expect(params).toEqual({ threshold: 0.38, limit: 10 });
    expect(params).not.toHaveProperty('domain');
    expect(params).not.toHaveProperty('document_type');
    expect(params).not.toHaveProperty('project');
  });

  it('produces identical JSON for same inputs regardless of call order', () => {
    const a = buildSearchParams({ threshold: 0.38, limit: 10, domain: 'project' });
    const b = buildSearchParams({ domain: 'project', limit: 10, threshold: 0.38 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('parseCachedResults', () => {
  it('returns the array as-is for valid results', () => {
    const results = [
      { id: 42, content: 'doc content', name: 'test', score: 0.95 },
      { id: 7, content: 'other doc', name: 'test2', score: 0.81 },
    ];
    expect(parseCachedResults(results)).toBe(results);
  });

  it('returns empty array for null', () => {
    expect(parseCachedResults(null)).toEqual([]);
  });

  it('returns empty array for empty array', () => {
    expect(parseCachedResults([])).toEqual([]);
  });
});

describe('extractSourceDocIds', () => {
  it('extracts unique document IDs from search results', () => {
    const results = [
      { id: 42, score: 0.95 },
      { id: 7, score: 0.81 },
      { id: 42, score: 0.60 },
    ];
    const ids = extractSourceDocIds(results);
    expect(ids).toEqual([42, 7]);
  });

  it('returns empty array for empty results', () => {
    expect(extractSourceDocIds([])).toEqual([]);
  });
});
