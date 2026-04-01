import { describe, it, expect } from 'vitest';

describe('ai-search module', () => {
  it('exports all expected functions', async () => {
    const module = await import('../src/lib/ai-search.js');
    expect(typeof module.searchByVector).toBe('function');
    expect(typeof module.searchByKeyword).toBe('function');
    expect(typeof module.searchHybrid).toBe('function');
    expect(typeof module.retrieveContext).toBe('function');
  });

  it('exports search result interfaces', async () => {
    // Verify the module loads without errors — interfaces are compile-time only
    // but if the imports are broken the dynamic import will fail
    const module = await import('../src/lib/ai-search.js');
    expect(module).toBeDefined();
  });
});
