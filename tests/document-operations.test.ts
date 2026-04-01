import { describe, it, expect } from 'vitest';

describe('document-operations module', () => {
  it('exports all expected functions', async () => {
    const mod = await import('../src/lib/document-operations.js');
    expect(typeof mod.createDocument).toBe('function');
    expect(typeof mod.updateDocument).toBe('function');
    expect(typeof mod.updateDocumentFields).toBe('function');
    expect(typeof mod.deleteDocument).toBe('function');
    expect(typeof mod.restoreDocument).toBe('function');
  });
});
