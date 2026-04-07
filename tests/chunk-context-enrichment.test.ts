import { describe, it, expect, vi } from 'vitest';
import { generateContextSummaries, estimateTokenCount } from '../src/lib/search/chunk-context-enrichment.js';
import type { IChunkProps } from '../src/lib/search/embeddings.js';

function makeChunk(content: string, index: number): IChunkProps {
  return {
    content,
    chunk_index: index,
    content_type: 'text',
    strategy: 'recursive',
    overlap_chars: 0,
  };
}

// Mock OpenAI client that returns predictable summaries
function makeMockOpenAI(summaryText: string = 'This chunk describes the topic in context.') {
  return {
    chat: {
      completions: {
        create: vi.fn().mockImplementation(async () => ({
          choices: [{ message: { content: summaryText } }],
        })),
      },
    },
  };
}

describe('estimateTokenCount', () => {
  it('estimates ~4 chars per token for English text', () => {
    const text = 'Hello world, this is a test sentence.'; // 37 chars
    const tokens = estimateTokenCount(text);
    expect(tokens).toBe(Math.ceil(37 / 4));
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
  });

  it('handles long text', () => {
    const text = 'word '.repeat(1000); // 5000 chars
    expect(estimateTokenCount(text)).toBe(Math.ceil(5000 / 4));
  });
});

describe('generateContextSummaries', () => {
  it('returns one summary per chunk', async () => {
    const chunks = [
      makeChunk('First chunk content about databases.', 0),
      makeChunk('Second chunk content about search.', 1),
    ];
    const mockOpenAI = makeMockOpenAI();
    const results = await generateContextSummaries(mockOpenAI, chunks, 'Full document content here.');
    expect(results).toHaveLength(2);
    expect(results[0].summary).toBeDefined();
    expect(results[1].summary).toBeDefined();
  });

  it('includes token count for each chunk', async () => {
    const chunks = [makeChunk('Some content.', 0)];
    const mockOpenAI = makeMockOpenAI();
    const results = await generateContextSummaries(mockOpenAI, chunks, 'Full doc.');
    expect(results[0].tokenCount).toBe(Math.ceil('Some content.'.length / 4));
  });

  it('calls OpenAI once per chunk', async () => {
    const chunks = [
      makeChunk('Chunk one.', 0),
      makeChunk('Chunk two.', 1),
      makeChunk('Chunk three.', 2),
    ];
    const mockOpenAI = makeMockOpenAI();
    await generateContextSummaries(mockOpenAI, chunks, 'Full doc content.');
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(3);
  });

  it('uses gpt-4o-mini model', async () => {
    const chunks = [makeChunk('Content.', 0)];
    const mockOpenAI = makeMockOpenAI();
    await generateContextSummaries(mockOpenAI, chunks, 'Full doc.');
    const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
    expect(callArgs.model).toBe('gpt-4o-mini');
  });

  it('sends full document and chunk in messages', async () => {
    const documentContent = 'This is the full document about RAG systems.';
    const chunkContent = 'This chunk covers embeddings.';
    const chunks = [makeChunk(chunkContent, 0)];
    const mockOpenAI = makeMockOpenAI();
    await generateContextSummaries(mockOpenAI, chunks, documentContent);

    const callArgs = mockOpenAI.chat.completions.create.mock.calls[0][0];
    const userMessage = callArgs.messages.find((message: { role: string }) => message.role === 'user');
    expect(userMessage.content).toContain(documentContent);
    expect(userMessage.content).toContain(chunkContent);
  });

  it('returns empty array for empty chunks array', async () => {
    const mockOpenAI = makeMockOpenAI();
    const results = await generateContextSummaries(mockOpenAI, [], 'Full doc.');
    expect(results).toEqual([]);
  });

  it('trims whitespace from LLM response', async () => {
    const mockOpenAI = makeMockOpenAI('  Summary with extra spaces.  ');
    const chunks = [makeChunk('Content.', 0)];
    const results = await generateContextSummaries(mockOpenAI, chunks, 'Full doc.');
    expect(results[0].summary).toBe('Summary with extra spaces.');
  });
});
