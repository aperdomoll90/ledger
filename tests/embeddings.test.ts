import { describe, it, expect } from 'vitest';
import { contentHash, toVectorString, parseVector, chunkText } from '../src/lib/embeddings.js';

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

describe('chunkText', () => {
  it('single chunk for short text', () => {
    const chunks = chunkText('Short text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Short text.');
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[0].strategy).toBe('paragraph');
    expect(chunks[0].content_type).toBe('text');
    expect(chunks[0].overlap_chars).toBe(0);
  });

  it('splits on paragraph boundaries', () => {
    const text = 'First paragraph with enough words.\n\nSecond paragraph with more words.\n\nThird paragraph here.';
    const chunks = chunkText(text, 'paragraph', 50, 10);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('chunk_index increments from 0', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const chunks = chunkText(text, 'paragraph', 25, 5);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  it('first chunk has 0 overlap', () => {
    const text = 'First paragraph content.\n\nSecond paragraph content.';
    const chunks = chunkText(text, 'paragraph', 30, 10);
    expect(chunks[0].overlap_chars).toBe(0);
  });

  it('force-splits text with no paragraph breaks', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkText(text, 'paragraph', 2000, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some(chunk => chunk.strategy === 'forced')).toBe(true);
  });
});
