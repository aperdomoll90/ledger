import { describe, it, expect, vi } from 'vitest';
import {
  getDocumentById,
  getDocumentByName,
  listDocuments,
  fetchSyncableDocuments,
} from '../src/lib/documents/fetching.js';

/**
 * Creates a mock Supabase client that simulates the chaining pattern:
 * supabase.from('documents').select('*').eq('id', 1).is('deleted_at', null).single()
 *
 * Each method returns `this` so calls can be chained.
 * The final method (single() or the chain itself) resolves to { data, error }.
 */
function createMockSupabase(resolveWith: { data: any; error: any }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(resolveWith),
    // For queries that don't call .single() (list queries),
    // the chain itself resolves via .then()
    then: vi.fn((resolve: any) => resolve(resolveWith)),
  };

  return { from: vi.fn().mockReturnValue(chain), _chain: chain } as any;
}

const sampleDoc = {
  id: 1,
  name: 'test-doc',
  domain: 'general',
  document_type: 'knowledge',
  project: null,
  protection: 'open',
  content: 'Hello world',
  description: 'A test document',
  created_at: '2026-03-30T00:00:00Z',
};

describe('getDocumentById', () => {
  it('returns document when found', async () => {
    const supabase = createMockSupabase({ data: sampleDoc, error: null });
    const result = await getDocumentById(supabase, 1);
    expect(result).toEqual(sampleDoc);
    expect(supabase.from).toHaveBeenCalledWith('documents');
  });

  it('returns null when not found', async () => {
    const supabase = createMockSupabase({ data: null, error: { message: 'not found' } });
    const result = await getDocumentById(supabase, 999);
    expect(result).toBeNull();
  });

  it('filters out soft-deleted documents', async () => {
    const supabase = createMockSupabase({ data: sampleDoc, error: null });
    await getDocumentById(supabase, 1);
    // Verify .is('deleted_at', null) was called
    expect(supabase._chain.is).toHaveBeenCalledWith('deleted_at', null);
  });
});

describe('getDocumentByName', () => {
  it('returns document when found', async () => {
    const supabase = createMockSupabase({ data: sampleDoc, error: null });
    const result = await getDocumentByName(supabase, 'test-doc');
    expect(result).toEqual(sampleDoc);
  });

  it('returns null when not found', async () => {
    const supabase = createMockSupabase({ data: null, error: { message: 'not found' } });
    const result = await getDocumentByName(supabase, 'nonexistent');
    expect(result).toBeNull();
  });
});

describe('listDocuments', () => {
  it('returns array of documents', async () => {
    const supabase = createMockSupabase({ data: [sampleDoc], error: null });
    const result = await listDocuments(supabase);
    expect(result).toEqual([sampleDoc]);
  });

  it('returns empty array on error', async () => {
    const supabase = createMockSupabase({ data: null, error: { message: 'oops' } });
    const result = await listDocuments(supabase);
    expect(result).toEqual([]);
  });

  it('applies domain filter when provided', async () => {
    const supabase = createMockSupabase({ data: [], error: null });
    await listDocuments(supabase, { domain: 'persona' });
    expect(supabase._chain.eq).toHaveBeenCalledWith('domain', 'persona');
  });

  it('applies document_type filter when provided', async () => {
    const supabase = createMockSupabase({ data: [], error: null });
    await listDocuments(supabase, { document_type: 'architecture' });
    expect(supabase._chain.eq).toHaveBeenCalledWith('document_type', 'architecture');
  });

  it('applies project filter when provided', async () => {
    const supabase = createMockSupabase({ data: [], error: null });
    await listDocuments(supabase, { project: 'ledger' });
    expect(supabase._chain.eq).toHaveBeenCalledWith('project', 'ledger');
  });

  it('defaults to limit 20', async () => {
    const supabase = createMockSupabase({ data: [], error: null });
    await listDocuments(supabase);
    expect(supabase._chain.limit).toHaveBeenCalledWith(20);
  });

  it('uses custom limit', async () => {
    const supabase = createMockSupabase({ data: [], error: null });
    await listDocuments(supabase, { limit: 5 });
    expect(supabase._chain.limit).toHaveBeenCalledWith(5);
  });
});

describe('fetchSyncableDocuments', () => {
  it('queries is_auto_load = true (sync driven by auto_load, not domain)', async () => {
    const supabase = createMockSupabase({ data: [sampleDoc], error: null });
    await fetchSyncableDocuments(supabase);
    expect(supabase._chain.eq).toHaveBeenCalledWith('is_auto_load', true);
  });
});
