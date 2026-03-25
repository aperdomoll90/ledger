import { describe, it, expect } from 'vitest';
import { chunkText, inferDelivery } from '../src/lib/notes.js';

describe('chunk integrity', () => {
  it('chunkText returns single chunk for short content', () => {
    const result = chunkText('short text', 25000, 2000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('short text');
  });

  it('chunkText produces overlapping chunks for long content', () => {
    const longText = Array(100).fill('paragraph content here').join('\n\n');
    const chunks = chunkText(longText, 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) {
      const endOfCurrent = chunks[i].slice(-50);
      expect(chunks[i + 1]).toContain(endOfCurrent.trim());
    }
  });
});

describe('type/delivery validation', () => {
  it('inferDelivery returns correct delivery for built-in types', () => {
    expect(inferDelivery('code-craft')).toBe('persona');
    expect(inferDelivery('architecture-decision')).toBe('project');
    expect(inferDelivery('reference')).toBe('knowledge');
    expect(inferDelivery('general')).toBe('knowledge');
  });

  it('inferDelivery returns knowledge for unknown types', () => {
    expect(inferDelivery('nonexistent-type')).toBe('knowledge');
  });

  it('inferDelivery resolves type aliases', () => {
    expect(inferDelivery('feedback')).toBe('knowledge'); // alias for 'general'
  });
});
