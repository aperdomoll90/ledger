import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('observability', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('initObservability', () => {
    it('returns false when LANGFUSE_PUBLIC_KEY is not set', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { initObservability } = await import('../src/lib/observability.js');
      const result = initObservability();
      expect(result).toBe(false);
    });

    it('returns true when LANGFUSE_PUBLIC_KEY is set', async () => {
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
      process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
      process.env.LANGFUSE_BASE_URL = 'http://localhost:9100';
      const { initObservability, shutdownObservability } = await import('../src/lib/observability.js');
      const result = initObservability();
      expect(result).toBe(true);
      await shutdownObservability();
    });
  });

  describe('isObservabilityEnabled', () => {
    it('returns false before init', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { isObservabilityEnabled } = await import('../src/lib/observability.js');
      expect(isObservabilityEnabled()).toBe(false);
    });
  });

  describe('startTrace / startSpan', () => {
    it('returns no-op trace when observability is disabled', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { initObservability, startTrace } = await import('../src/lib/observability.js');
      initObservability();
      const trace = startTrace('test-trace', { tags: ['test'] });
      expect(trace).toBeDefined();
      expect(trace.end).toBeTypeOf('function');
      // Should not throw
      trace.end();
    });

    it('returns no-op span when observability is disabled', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { initObservability, startSpan } = await import('../src/lib/observability.js');
      initObservability();
      const span = startSpan('test-span', { input: { key: 'value' } });
      expect(span).toBeDefined();
      expect(span.end).toBeTypeOf('function');
      expect(span.update).toBeTypeOf('function');
      span.update({ output: { result: 'ok' } });
      span.end();
    });
  });

  describe('shutdownObservability', () => {
    it('resolves without error when observability is disabled', async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      const { shutdownObservability } = await import('../src/lib/observability.js');
      await expect(shutdownObservability()).resolves.toBeUndefined();
    });
  });
});
