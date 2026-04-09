// rate-limiter.ts
// Provider-agnostic rate limiter using Bottleneck.
//
// Proactive pacing layer: controls how many API requests go out per minute
// and how many can run concurrently. Prevents 429 errors before they happen.
//
// The OpenAI SDK handles reactive retry (backoff after 429). This module
// handles proactive pacing (don't hit 429 in the first place).
//
// Usage: import the singleton instances (openaiLimiter, cohereLimiter) and
// wrap API calls with limiter.schedule(() => apiCall()).

import Bottleneck from 'bottleneck';

// =============================================================================
// Config interface
// =============================================================================

export interface IRateLimiterConfigProps {
  maxConcurrent: number;            // max parallel requests
  reservoirAmount: number;          // requests allowed per window
  reservoirRefreshInterval: number; // window size in ms
  minTime: number;                  // minimum ms between requests
  retryLimit: number;               // Bottleneck-level retries on failure
}

// =============================================================================
// Provider presets
// =============================================================================

// OpenAI Tier 1: 500 RPM. Safety margin: 90% = 450 RPM.
export const OPENAI_PRESET: IRateLimiterConfigProps = {
  maxConcurrent: 10,
  reservoirAmount: 450,
  reservoirRefreshInterval: 60_000,
  minTime: 100,
  retryLimit: 3,
};

// Cohere trial: 100 RPM. Safety margin: 90% = 90 RPM.
export const COHERE_PRESET: IRateLimiterConfigProps = {
  maxConcurrent: 5,
  reservoirAmount: 90,
  reservoirRefreshInterval: 60_000,
  minTime: 200,
  retryLimit: 3,
};

// =============================================================================
// Retryable status codes
// =============================================================================

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    return RETRYABLE_STATUS_CODES.has((error as { status: number }).status);
  }
  return false;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a rate limiter with the given config.
 *
 * Returns a Bottleneck instance with:
 * - Reservoir-based rate limiting (token bucket, refills each window)
 * - Concurrency control (maxConcurrent parallel jobs)
 * - Minimum spacing between requests (minTime)
 * - Automatic retry on 429 and 5xx errors with exponential backoff
 */
export function createRateLimiter(config: IRateLimiterConfigProps): Bottleneck {
  const limiter = new Bottleneck({
    maxConcurrent: config.maxConcurrent,
    reservoir: config.reservoirAmount,
    reservoirRefreshAmount: config.reservoirAmount,
    reservoirRefreshInterval: config.reservoirRefreshInterval,
    minTime: config.minTime,
  });

  // Retry handler: Bottleneck calls this on job failure.
  // Return a number (ms to wait) to retry, or void/undefined to give up.
  limiter.on('failed', (error: unknown, jobInfo: Bottleneck.EventInfoRetryable) => {
    if (isRetryableError(error) && jobInfo.retryCount < config.retryLimit) {
      // Exponential backoff with jitter: 1s, 2s, 4s, ...
      const baseDelay = 1000 * Math.pow(2, jobInfo.retryCount);
      const jitter = baseDelay * 0.25 * Math.random();
      return baseDelay + jitter;
    }
    // Non-retryable or retries exhausted: don't retry (error propagates)
    return undefined;
  });

  return limiter;
}

// =============================================================================
// Adaptive header reading
// =============================================================================

/**
 * Adjust the limiter's reservoir based on OpenAI rate limit response headers.
 *
 * If OpenAI reports fewer remaining requests than our reservoir thinks,
 * we adjust downward. This self-tunes without replacing the static baseline.
 *
 * Call this after each successful API request.
 */
export async function updateLimitsFromHeaders(
  limiter: Bottleneck,
  headers: Headers,
): Promise<void> {
  const remaining = headers.get('x-ratelimit-remaining-requests');
  if (remaining === null) return;

  const remainingCount = parseInt(remaining, 10);
  if (isNaN(remainingCount)) return;

  const currentReservoir = await limiter.currentReservoir();
  if (currentReservoir !== null && remainingCount < currentReservoir) {
    await limiter.updateSettings({ reservoir: remainingCount });
  }
}

// =============================================================================
// Singleton instances
// =============================================================================

export const openaiLimiter = createRateLimiter(OPENAI_PRESET);
export const cohereLimiter = createRateLimiter(COHERE_PRESET);
