import { describe, it, expect } from 'vitest';
import { contentHash, toVectorString, parseVector, chunkText } from '../src/lib/search/embeddings.js';

describe('contentHash', () => {
  it('returns SHA-256', () => { expect(contentHash('hello')).toHaveLength(64); });
  it('deterministic', () => { expect(contentHash('x')).toBe(contentHash('x')); });
  it('unique per input', () => { expect(contentHash('a')).not.toBe(contentHash('b')); });
});

describe('toVectorString', () => {
  it('formats', () => { expect(toVectorString([0.1, 0.2])).toBe('[0.1,0.2]'); });
  it('negatives', () => { expect(toVectorString([-0.5])).toBe('[-0.5]'); });
  it('empty', () => { expect(toVectorString([])).toBe('[]'); });
});

describe('parseVector', () => {
  it('parses a Postgres vector string', () => {
    expect(parseVector('[0.1,-0.2,0.3]')).toEqual([0.1, -0.2, 0.3]);
  });
  it('passes through a number[] unchanged', () => {
    const arr = [0.1, 0.2];
    expect(parseVector(arr)).toBe(arr);
  });
  it('round-trips with toVectorString', () => {
    const original = [0.021, -0.007, 0.045];
    expect(parseVector(toVectorString(original))).toEqual(original);
  });
  it('throws on unexpected types', () => {
    expect(() => parseVector(42)).toThrow('Cannot parse vector');
    expect(() => parseVector(null)).toThrow('Cannot parse vector');
  });
});

describe('chunkText — recursive strategy', () => {
  it('returns single chunk for short text', () => {
    const chunks = chunkText('Short text.', { maxChunkSize: 1000, overlapChars: 200, strategy: 'recursive' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Short text.');
    expect(chunks[0].strategy).toBe('recursive');
    expect(chunks[0].overlap_chars).toBe(0);
  });

  it('splits on markdown headers first', () => {
    const text = '# Section One\n\nContent for section one.\n\n# Section Two\n\nContent for section two.';
    const chunks = chunkText(text, { maxChunkSize: 60, overlapChars: 0, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].content).toContain('Section One');
    expect(chunks[1].content).toContain('Section Two');
  });

  it('preserves header text in its chunk', () => {
    const text = '## My Header\n\nSome paragraph content here.';
    const chunks = chunkText(text, { maxChunkSize: 1000, overlapChars: 0, strategy: 'recursive' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('## My Header');
  });

  it('falls through to paragraph split when no headers', () => {
    const text = 'Paragraph one with some content.\n\nParagraph two with more content.\n\nParagraph three with even more.';
    const chunks = chunkText(text, { maxChunkSize: 50, overlapChars: 0, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('falls through to sentence split for long paragraphs', () => {
    const text = 'First sentence is here. Second sentence follows. Third sentence appears. Fourth sentence ends.';
    const chunks = chunkText(text, { maxChunkSize: 50, overlapChars: 0, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('force-splits at character level as last resort', () => {
    const text = 'a'.repeat(3000);
    const chunks = chunkText(text, { maxChunkSize: 1000, overlapChars: 100, strategy: 'recursive' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some(chunk => chunk.strategy === 'forced')).toBe(true);
  });

  it('applies overlap between adjacent chunks at same level', () => {
    const text = 'First paragraph with enough words to fill a chunk nicely.\n\nSecond paragraph with enough words too here.\n\nThird paragraph to trigger the splitting logic.';
    const chunks = chunkText(text, { maxChunkSize: 60, overlapChars: 10, strategy: 'recursive' });
    if (chunks.length > 1) {
      expect(chunks[1].overlap_chars).toBeGreaterThan(0);
    }
  });

  it('does not overlap between header-level sections', () => {
    const text = '# Section A\n\nContent A is here.\n\n# Section B\n\nContent B is here.';
    const chunks = chunkText(text, { maxChunkSize: 40, overlapChars: 10, strategy: 'recursive' });
    const sectionBChunk = chunks.find(chunk => chunk.content.includes('Section B'));
    if (sectionBChunk && sectionBChunk.chunk_index > 0) {
      expect(sectionBChunk.content).not.toContain('Content A');
    }
  });

  it('chunk_index increments correctly across all chunks', () => {
    const text = '# A\n\nParagraph.\n\n# B\n\nAnother paragraph.\n\n# C\n\nThird paragraph.';
    const chunks = chunkText(text, { maxChunkSize: 30, overlapChars: 0, strategy: 'recursive' });
    for (let index = 0; index < chunks.length; index++) {
      expect(chunks[index].chunk_index).toBe(index);
    }
  });
});

describe('chunkText — backward compatibility', () => {
  it('no-config call uses recursive strategy by default', () => {
    const chunks = chunkText('Short text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].strategy).toBe('recursive');
  });

  it('defaults to maxChunkSize 1000', () => {
    const text = 'word '.repeat(250); // ~1250 chars
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('splits on paragraph boundaries', () => {
    const text = 'First paragraph with enough words.\n\nSecond paragraph with more words.\n\nThird paragraph here.';
    const chunks = chunkText(text, { maxChunkSize: 50, overlapChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunk_index increments from 0', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, { maxChunkSize: 25, overlapChars: 5 });
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it('first chunk has 0 overlap', () => {
    const text = 'First paragraph content.\n\nSecond paragraph content.';
    const chunks = chunkText(text, { maxChunkSize: 30, overlapChars: 10 });
    expect(chunks[0].overlap_chars).toBe(0);
  });

  it('force-splits text with no paragraph breaks', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, { maxChunkSize: 2000, overlapChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some(chunk => chunk.strategy === 'forced')).toBe(true);
  });
});
