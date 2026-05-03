// Tests for the file-based write helpers: updateDocumentFromFile, createDocumentFromFile.
// These wrap the existing updateDocument / createDocument primitives with read-from-disk
// and post-push auto-verify (pull-back, byte-exact diff against the file we sent).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Track temp dirs so we can clean up between tests.
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function writeTempFile(content: string, filename = 'test.md'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-fromfile-test-'));
  tempDirs.push(dir);
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// Mock Supabase that:
// - records RPC calls (rpc())
// - captures the most recent p_content / p_chunk_contents from RPC params
// - serves a configurable getDocumentById response (from().select().eq().is().single())
//
// If `pulledContentOverride` is provided, the pull-back returns that string verbatim
// (used to simulate drift). Otherwise, it returns whatever was most recently upserted
// (clean-verify path).
function makeMockSupabase(pulledContentOverride?: string) {
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  let lastUpsertedContent = '';

  return {
    client: {
      from: () => ({
        select: () => ({
          eq: () => ({
            is: () => ({
              single: () => Promise.resolve({
                data: {
                  id: 1,
                  content: pulledContentOverride !== undefined ? pulledContentOverride : lastUpsertedContent,
                },
                error: null,
              }),
            }),
          }),
        }),
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 1 }, error: null }) }) }),
      }),
      rpc: vi.fn().mockImplementation(async (name: string, params: Record<string, unknown>) => {
        rpcCalls.push({ name, params });
        if (typeof params.p_content === 'string') {
          lastUpsertedContent = params.p_content;
        }
        return { data: 1, error: null };
      }),
    },
    rpcCalls,
  };
}

// Mock OpenAI matching the shape used by tests/document-operations.test.ts.
function makeMockOpenAI() {
  function makeEmbeddingResponse(params: { input: string | string[] }) {
    const inputs = Array.isArray(params.input) ? params.input : [params.input];
    const responseData = { data: inputs.map(() => ({ embedding: new Array(1536).fill(0.01) })) };
    const promise = Promise.resolve(responseData);
    return Object.assign(promise, {
      withResponse: () => Promise.resolve({ data: responseData, response: { headers: new Headers() } }),
    });
  }

  return {
    embeddings: {
      create: vi.fn().mockImplementation((params: { input: string | string[] }) => makeEmbeddingResponse(params)),
    },
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content: 'Stub summary.' } }] }),
      },
    },
  };
}

describe('updateDocumentFromFile', () => {
  it('reads small file from disk, pushes via updateDocument, verifies clean', async () => {
    const { updateDocumentFromFile } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const filePath = writeTempFile('small content');

    const result = await updateDocumentFromFile(
      { supabase: mock.client, openai },
      { id: 1, filePath, agent: 'test' },
    );

    expect(result.id).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.bytes).toBe('small content'.length);

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_update');
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.params.p_content).toBe('small content');
  });

  // The >200 KB regression test for the ARG_MAX bug lives at the CLI integration level,
  // not here. Reason: the bug was specifically in argv-passing for `ledger update -c`,
  // not in the DB pipeline. The unit-level fix is "read from disk instead of argv,"
  // which this whole module already covers. Routing 250 KB through the chunking +
  // enrichment pipeline in a unit test is also expensive — 250 chunks × the singleton
  // rate-limiter `minTime: 100 ms` = 25+ seconds, and Bottleneck's queue is shared
  // across tests so it would cascade timeouts into every later test in this file.
  // CLI tests will spawn a real `ledger update -f bigfile.md` subprocess and prove
  // the bug is fixed end-to-end.

  it('throws VerifyMismatchError when pulled content differs from pushed content', async () => {
    const { updateDocumentFromFile, VerifyMismatchError } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase('Form LLC'); // pull-back returns drifted content
    const openai = makeMockOpenAI();
    const filePath = writeTempFile('Idle');

    await expect(
      updateDocumentFromFile(
        { supabase: mock.client, openai },
        { id: 1, filePath, agent: 'test' },
      ),
    ).rejects.toBeInstanceOf(VerifyMismatchError);
  });

  it('VerifyMismatchError carries id, byte counts, and a diff preview locating the drift', async () => {
    const { updateDocumentFromFile, VerifyMismatchError } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase('Form LLC');
    const openai = makeMockOpenAI();
    const filePath = writeTempFile('Idle');

    try {
      await updateDocumentFromFile(
        { supabase: mock.client, openai },
        { id: 1, filePath, agent: 'test' },
      );
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyMismatchError);
      const verifyError = error as InstanceType<typeof VerifyMismatchError>;
      expect(verifyError.id).toBe(1);
      expect(verifyError.expectedLength).toBe(4);  // 'Idle'
      expect(verifyError.actualLength).toBe(8);    // 'Form LLC'
      expect(verifyError.diffPreview).toMatch(/line 1/);
      expect(verifyError.diffPreview).toMatch(/col 1/);
      expect(verifyError.diffPreview).toContain("Idle");
      expect(verifyError.diffPreview).toContain("Form LLC");
    }
  });

  it('preserves unicode, emoji, and edge whitespace byte-for-byte', async () => {
    const { updateDocumentFromFile } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const tricky = '  leading-spaces\nÜñîcödé 🌟 emoji\ntrailing-spaces  \n';
    const filePath = writeTempFile(tricky);

    const result = await updateDocumentFromFile(
      { supabase: mock.client, openai },
      { id: 1, filePath, agent: 'test' },
    );

    expect(result.verified).toBe(true);
    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_update');
    expect(rpcCall!.params.p_content).toBe(tricky); // byte-exact, no normalization
  });

  it('throws ENOENT when file is missing', async () => {
    const { updateDocumentFromFile } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();

    await expect(
      updateDocumentFromFile(
        { supabase: mock.client, openai },
        { id: 1, filePath: '/tmp/definitely-does-not-exist-ledger-test.md', agent: 'test' },
      ),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('createDocumentFromFile', () => {
  it('reads file, creates document via createDocument, verifies clean', async () => {
    const { createDocumentFromFile } = await import('../src/lib/documents/operations.js');
    const mock = makeMockSupabase();
    const openai = makeMockOpenAI();
    const filePath = writeTempFile('new document content');

    const result = await createDocumentFromFile(
      { supabase: mock.client, openai },
      {
        filePath,
        name: 'test-new-doc',
        domain: 'general',
        document_type: 'knowledge-guide',
        agent: 'test',
      },
    );

    expect(result.id).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.bytes).toBe('new document content'.length);

    const rpcCall = mock.rpcCalls.find(call => call.name === 'document_create');
    expect(rpcCall).toBeDefined();
    expect(rpcCall!.params.p_content).toBe('new document content');
  });
});
