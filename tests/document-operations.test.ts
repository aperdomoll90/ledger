import { describe, it, expect, vi } from 'vitest';

// Mock Supabase that records RPC calls
function makeMockSupabase() {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  return {
    client: {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 1 }, error: null }) }) }) }),
      rpc: vi.fn().mockImplementation(async (name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        return { data: 1, error: null };
      }),
    },
    rpcCalls,
  };
}

// Mock OpenAI that handles both embeddings and chat completions.
// embeddings.create() must return an object that:
// 1. Works as a Promise (for legacy callers that just await it)
// 2. Has .withResponse() (for the rate-limiter-aware path that reads headers)
// This mimics the real OpenAI SDK's APIPromise behavior.
function makeMockOpenAI() {
  function makeEmbeddingResponse(params: { input: string | string[] }) {
    const inputs = Array.isArray(params.input) ? params.input : [params.input];
    const responseData = { data: inputs.map(() => ({ embedding: new Array(1536).fill(0.01) })) };
    const promise = Promise.resolve(responseData);
    return Object.assign(promise, {
      withResponse: () => Promise.resolve({
        data: responseData,
        response: { headers: new Headers() },
      }),
    });
  }

  return {
    embeddings: {
      create: vi.fn().mockImplementation((params: { input: string | string[] }) => makeEmbeddingResponse(params)),
    },
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'This chunk is about testing.' } }],
        }),
      },
    },
  };
}

describe('document-operations module', () => {
  it('exports all expected functions', async () => {
    const mod = await import('../src/lib/documents/operations.js');
    expect(typeof mod.createDocument).toBe('function');
    expect(typeof mod.updateDocument).toBe('function');
    expect(typeof mod.updateDocumentFields).toBe('function');
    expect(typeof mod.deleteDocument).toBe('function');
    expect(typeof mod.restoreDocument).toBe('function');
  });
});

describe('createDocument — enriched pipeline', () => {
  it('passes chunk summaries to RPC', async () => {
    const { createDocument } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Short content that fits in one chunk.',
    });

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_create');
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.params.p_chunk_summaries).toBeInstanceOf(Array);
    expect(rpcCall!.params.p_chunk_summaries).toHaveLength(1);
    expect(rpcCall!.params.p_chunk_token_counts).toBeInstanceOf(Array);
    expect(rpcCall!.params.p_chunk_token_counts).toHaveLength(1);
    expect(rpcCall!.params.p_chunk_overlap).toBe(200);
  });

  it('uses recursive strategy by default', async () => {
    const { createDocument } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Content here.',
    });

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_create');
    expect(rpcCall!.params.p_chunk_strategy).toBe('recursive');
  });

  it('calls chat completions for context summaries', async () => {
    const { createDocument } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Content for enrichment.',
    });

    expect(openai.chat.completions.create).toHaveBeenCalled();
  });

  it('embeds summary + content concatenated', async () => {
    const { createDocument } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: 'Chunk content here.',
    });

    // Batch embedding: input is an array of strings, each is summary + "\n\n" + chunk
    const embeddingCall = openai.embeddings.create.mock.calls[0][0];
    const batchInput = embeddingCall.input as string[];
    expect(batchInput[0]).toContain('This chunk is about testing.');
    expect(batchInput[0]).toContain('Chunk content here.');
  });

  it('stores original chunk content (not enriched) in p_chunk_contents', async () => {
    const { createDocument } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    const originalContent = 'Original chunk content only.';
    await createDocument(clients, {
      name: 'test-doc',
      domain: 'general',
      document_type: 'knowledge-guide',
      content: originalContent,
    });

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_create');
    // p_chunk_contents should have the original text, NOT the enriched version
    expect(rpcCall!.params.p_chunk_contents).toEqual([originalContent]);
  });
});

describe('updateDocument — enriched pipeline', () => {
  it('passes chunk summaries to RPC', async () => {
    const { updateDocument } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const clients = { supabase: mock.client, openai };

    await updateDocument(clients, {
      id: 42,
      content: 'Updated content.',
    });

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_update');
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.params.p_chunk_summaries).toBeInstanceOf(Array);
    expect(rpcCall!.params.p_chunk_token_counts).toBeInstanceOf(Array);
    expect(rpcCall!.params.p_chunk_overlap).toBe(200);
  });
});
