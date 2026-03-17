import { describe, it, expect } from 'vitest';
import { contentHash } from '../src/lib/hash.js';

describe('contentHash', () => {
  it('returns consistent SHA-256 for same input', () => {
    const hash1 = contentHash('hello world');
    const hash2 = contentHash('hello world');
    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different input', () => {
    const hash1 = contentHash('hello world');
    const hash2 = contentHash('hello world!');
    expect(hash1).not.toBe(hash2);
  });

  it('returns 64-char hex string', () => {
    const hash = contentHash('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles empty string', () => {
    const hash = contentHash('');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles unicode content', () => {
    const hash = contentHash('日本語テスト 🚀');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is whitespace-sensitive', () => {
    const hash1 = contentHash('hello');
    const hash2 = contentHash('hello ');
    expect(hash1).not.toBe(hash2);
  });
});
