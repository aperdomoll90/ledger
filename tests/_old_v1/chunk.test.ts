import { describe, it, expect } from 'vitest';
import { chunkText } from '../src/lib/notes.js';

describe('chunkText', () => {
  it('returns single chunk when text is under maxChars', () => {
    const result = chunkText('short text', 100, 10);
    expect(result).toEqual(['short text']);
  });

  it('returns single chunk when text equals maxChars', () => {
    const text = 'a'.repeat(100);
    const result = chunkText(text, 100, 10);
    expect(result).toEqual([text]);
  });

  it('splits at paragraph boundaries', () => {
    const text = 'paragraph one\n\nparagraph two\n\nparagraph three';
    const result = chunkText(text, 30, 5);
    expect(result.length).toBeGreaterThan(1);
    expect(result[0]).toContain('paragraph one');
  });

  it('includes overlap between chunks', () => {
    const p1 = 'a'.repeat(20);
    const p2 = 'b'.repeat(20);
    const p3 = 'c'.repeat(20);
    const text = `${p1}\n\n${p2}\n\n${p3}`;
    const result = chunkText(text, 45, 10);

    // Second chunk should start with overlap from end of first chunk
    if (result.length > 1) {
      const firstEnd = result[0].slice(-10);
      expect(result[1].startsWith(firstEnd)).toBe(true);
    }
  });

  it('force-splits single paragraph exceeding maxChars', () => {
    const text = 'x'.repeat(250);
    const result = chunkText(text, 100, 10);
    expect(result.length).toBeGreaterThan(1);
    // First chunk should be exactly maxChars
    expect(result[0].length).toBe(100);
  });

  it('preserves content as-is when under limit', () => {
    const text = 'first\n\n\n\nsecond';
    const result = chunkText(text, 1000, 10);
    // Under limit = returned unchanged, no normalization
    expect(result).toEqual([text]);
  });

  it('handles single paragraph under limit', () => {
    const result = chunkText('no newlines here', 1000, 10);
    expect(result).toEqual(['no newlines here']);
  });

  it('preserves all content across chunks', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => `paragraph ${i}: ${'x'.repeat(50)}`);
    const text = paragraphs.join('\n\n');
    const result = chunkText(text, 200, 20);

    // Every original paragraph should appear in at least one chunk
    for (const p of paragraphs) {
      const found = result.some(chunk => chunk.includes(p));
      expect(found).toBe(true);
    }
  });

  it('returns empty array content as single chunk', () => {
    const result = chunkText('', 100, 10);
    expect(result).toEqual(['']);
  });
});
