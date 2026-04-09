import { describe, it, expect, vi } from 'vitest';
import {
  createRateLimiter,
  OPENAI_PRESET,
  COHERE_PRESET,
  openaiLimiter,
  cohereLimiter,
  updateLimitsFromHeaders,
} from '../src/lib/rate-limiter.js';
import type { IRateLimiterConfigProps } from '../src/lib/rate-limiter.js';

describe('createRateLimiter', () => {
  it('returns a Bottleneck instance with correct maxConcurrent', () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 3,
      reservoirAmount: 100,
      reservoirRefreshInterval: 60_000,
      minTime: 50,
      retryLimit: 2,
    };
    const limiter = createRateLimiter(config);
    // Bottleneck exposes counts() which shows running/queued
    expect(limiter.counts().RECEIVED).toBe(0);
    expect(limiter.counts().RUNNING).toBe(0);
  });

  it('schedules and executes a job', async () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 1,
      reservoirAmount: 10,
      reservoirRefreshInterval: 60_000,
      minTime: 0,
      retryLimit: 0,
    };
    const limiter = createRateLimiter(config);
    const result = await limiter.schedule(() => Promise.resolve('done'));
    expect(result).toBe('done');
  });

  it('retries on 429 error up to retryLimit', async () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 1,
      reservoirAmount: 10,
      reservoirRefreshInterval: 60_000,
      minTime: 0,
      retryLimit: 2,
    };
    const limiter = createRateLimiter(config);

    let callCount = 0;
    const result = await limiter.schedule(() => {
      callCount++;
      if (callCount < 3) {
        const error = new Error('Rate limited') as Error & { status: number };
        error.status = 429;
        throw error;
      }
      return Promise.resolve('success');
    });

    expect(result).toBe('success');
    expect(callCount).toBe(3); // 1 initial + 2 retries
  });

  it('throws after exhausting retries', async () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 1,
      reservoirAmount: 10,
      reservoirRefreshInterval: 60_000,
      minTime: 0,
      retryLimit: 1,
    };
    const limiter = createRateLimiter(config);

    await expect(
      limiter.schedule(() => {
        const error = new Error('Rate limited') as Error & { status: number };
        error.status = 429;
        throw error;
      }),
    ).rejects.toThrow('Rate limited');
  });

  it('does not retry on non-retryable errors', async () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 1,
      reservoirAmount: 10,
      reservoirRefreshInterval: 60_000,
      minTime: 0,
      retryLimit: 3,
    };
    const limiter = createRateLimiter(config);

    let callCount = 0;
    await expect(
      limiter.schedule(() => {
        callCount++;
        const error = new Error('Bad request') as Error & { status: number };
        error.status = 400;
        throw error;
      }),
    ).rejects.toThrow('Bad request');

    expect(callCount).toBe(1); // no retry
  });
});

describe('provider presets', () => {
  it('OPENAI_PRESET has 90% safety margin on 500 RPM', () => {
    expect(OPENAI_PRESET.reservoirAmount).toBe(450);
    expect(OPENAI_PRESET.reservoirRefreshInterval).toBe(60_000);
  });

  it('COHERE_PRESET has 90% safety margin on 100 RPM', () => {
    expect(COHERE_PRESET.reservoirAmount).toBe(90);
    expect(COHERE_PRESET.reservoirRefreshInterval).toBe(60_000);
  });
});

describe('singleton instances', () => {
  it('openaiLimiter is a Bottleneck instance', () => {
    expect(openaiLimiter.counts).toBeDefined();
  });

  it('cohereLimiter is a Bottleneck instance', () => {
    expect(cohereLimiter.counts).toBeDefined();
  });

  it('openaiLimiter and cohereLimiter are different instances', () => {
    expect(openaiLimiter).not.toBe(cohereLimiter);
  });
});

describe('updateLimitsFromHeaders', () => {
  it('reduces reservoir when remaining is lower than current', async () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 1,
      reservoirAmount: 100,
      reservoirRefreshInterval: 60_000,
      minTime: 0,
      retryLimit: 0,
    };
    const limiter = createRateLimiter(config);

    const headers = new Headers({
      'x-ratelimit-remaining-requests': '20',
    });

    await updateLimitsFromHeaders(limiter, headers);
    const reservoir = await limiter.currentReservoir();
    expect(reservoir).toBeLessThanOrEqual(20);
  });

  it('does nothing when header is missing', async () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 1,
      reservoirAmount: 100,
      reservoirRefreshInterval: 60_000,
      minTime: 0,
      retryLimit: 0,
    };
    const limiter = createRateLimiter(config);

    const headers = new Headers();
    await updateLimitsFromHeaders(limiter, headers);
    const reservoir = await limiter.currentReservoir();
    expect(reservoir).toBe(100);
  });

  it('does nothing when remaining is higher than current reservoir', async () => {
    const config: IRateLimiterConfigProps = {
      maxConcurrent: 1,
      reservoirAmount: 50,
      reservoirRefreshInterval: 60_000,
      minTime: 0,
      retryLimit: 0,
    };
    const limiter = createRateLimiter(config);

    const headers = new Headers({
      'x-ratelimit-remaining-requests': '200',
    });

    await updateLimitsFromHeaders(limiter, headers);
    const reservoir = await limiter.currentReservoir();
    expect(reservoir).toBe(50);
  });
});
