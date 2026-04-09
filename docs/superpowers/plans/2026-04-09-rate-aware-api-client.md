# Rate-Aware API Client Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add proactive rate limiting (Bottleneck) and bump reactive retry (OpenAI SDK maxRetries) to protect all external API calls from rate limit failures.

**Architecture:** Provider-agnostic rate limiter factory in `src/lib/rate-limiter.ts` exporting singleton Bottleneck instances per provider. Two hot-path functions (`generateEmbedding`, `generateContextSummaries`) and the reranker schedule calls through the limiter. Adaptive header reading adjusts limits from OpenAI response headers.

**Tech Stack:** TypeScript (strict) · Bottleneck · OpenAI Node SDK · vitest

**Spec:** [docs/superpowers/specs/2026-04-09-rate-aware-api-client-design.md](../specs/2026-04-09-rate-aware-api-client-design.md)

---

## File Structure

**New files:**
- `src/lib/rate-limiter.ts` — Rate limiter factory, config interface, provider presets, adaptive header helper, singleton exports
- `tests/rate-limiter.test.ts` — Unit tests for factory, presets, header adaptation, retry behavior

**Modified files:**
- `src/lib/config.ts:111` — Bump OpenAI `maxRetries` to 5
- `src/lib/search/embeddings.ts:248-253` — Wrap `generateEmbedding` with `openaiLimiter.schedule()`
- `src/lib/search/chunk-context-enrichment.ts:95-103` — Wrap `openai.chat.completions.create` with `openaiLimiter.schedule()`
- `src/lib/search/reranker.ts:74-91` — Wrap `fetch()` with `cohereLimiter.schedule()`
- `src/lib/documents/classification.ts:148` — Update `IOpenAIClientProps` to support `.withResponse()` return type

---

## Ordering Rationale

| Task | What                                | State after                          | Rollback             |
|------|-------------------------------------|--------------------------------------|----------------------|
| 1    | Install Bottleneck                  | Dependency available                 | `npm uninstall`      |
| 2    | Rate limiter module + tests         | Factory works, singletons exported   | Delete file          |
| 3    | Bump maxRetries in config.ts        | SDK retries 5 times on failure       | Revert one line      |
| 4    | Integrate embeddings.ts             | Embedding calls go through limiter   | Revert function      |
| 5    | Integrate chunk-context-enrichment  | Contextual Retrieval calls go through limiter | Revert function |
| 6    | Integrate reranker.ts               | Cohere calls go through limiter      | Revert function      |
| 7    | Full test suite pass + build        | Everything green                     | —                    |
| 8    | Documentation updates               | Architecture + error log updated     | Revert docs          |

---

## Task 1: Install Bottleneck

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

Run:
```bash
cd ~/repos/ledger && npm install bottleneck
```

- [ ] **Step 2: Verify installation**

Run:
```bash
cd ~/repos/ledger && node -e "const B = require('bottleneck'); console.log(typeof B)"
```
Expected: `function`

- [ ] **Step 3: Commit**

```bash
cd ~/repos/ledger
git add package.json package-lock.json
git commit -m "add bottleneck dependency for rate limiting"
```

---

## Task 2: Rate Limiter Module + Tests

**Files:**
- Create: `src/lib/rate-limiter.ts`
- Create: `tests/rate-limiter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/rate-limiter.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/rate-limiter.test.ts
```
Expected: FAIL — module `../src/lib/rate-limiter.js` does not exist

- [ ] **Step 3: Write the rate limiter module**

Create `src/lib/rate-limiter.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/rate-limiter.test.ts
```
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/rate-limiter.ts tests/rate-limiter.test.ts
git commit -m "add rate limiter module with provider presets and tests"
```

---

## Task 3: Bump OpenAI SDK maxRetries

**Files:**
- Modify: `src/lib/config.ts:111`

- [ ] **Step 1: Update the OpenAI client constructor**

In `src/lib/config.ts`, change line 111 from:

```typescript
    openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
```

to:

```typescript
    openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 5 }),
```

- [ ] **Step 2: Verify typecheck passes**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd ~/repos/ledger
git add src/lib/config.ts
git commit -m "bump OpenAI SDK maxRetries from 2 to 5"
```

---

## Task 4: Integrate Rate Limiter into embeddings.ts

**Files:**
- Modify: `src/lib/search/embeddings.ts:248-253`
- Modify: `src/lib/documents/classification.ts:148`

The `generateEmbedding` function needs to schedule its OpenAI call through the limiter. We also need to update the `IOpenAIClientProps` interface to support the `.withResponse()` return type for header access.

- [ ] **Step 1: Update IOpenAIClientProps to support withResponse**

In `src/lib/documents/classification.ts`, change line 148 from:

```typescript
  embeddings: { create: (params: { model: string; input: string }) => Promise<{ data: Array<{ embedding: number[] }> }> };
```

to:

```typescript
  embeddings: {
    create: (params: { model: string; input: string }) => Promise<{ data: Array<{ embedding: number[] }> }> & {
      withResponse: () => Promise<{
        data: { data: Array<{ embedding: number[] }> };
        response: { headers: Headers };
      }>;
    };
  };
```

- [ ] **Step 2: Update generateEmbedding to use the rate limiter**

In `src/lib/search/embeddings.ts`, add the import at the top (after existing imports):

```typescript
import { openaiLimiter, updateLimitsFromHeaders } from '../rate-limiter.js';
```

Then replace the `generateEmbedding` function (lines 248-254) with:

```typescript
export async function generateEmbedding(openai: IOpenAIClientProps, text: string): Promise<number[]> {
  return openaiLimiter.schedule(async () => {
    const { data, response } = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    }).withResponse();

    await updateLimitsFromHeaders(openaiLimiter, response.headers);
    return data.data[0].embedding;
  });
}
```

- [ ] **Step 3: Verify typecheck passes**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 4: Run existing embedding tests**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/embeddings.test.ts
```
Expected: All tests PASS (existing tests only exercise pure functions, not `generateEmbedding`)

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/documents/classification.ts src/lib/search/embeddings.ts
git commit -m "route embedding calls through rate limiter with adaptive headers"
```

---

## Task 5: Integrate Rate Limiter into Contextual Retrieval

**Files:**
- Modify: `src/lib/search/chunk-context-enrichment.ts:90-103`

- [ ] **Step 1: Add import**

In `src/lib/search/chunk-context-enrichment.ts`, add after the existing import on line 18:

```typescript
import { openaiLimiter } from '../rate-limiter.js';
```

- [ ] **Step 2: Wrap the OpenAI call in the loop**

Replace the loop body inside `generateContextSummaries` (lines 90-111) with:

```typescript
  for (const chunk of chunks) {
    const prompt = CONTEXT_PROMPT
      .replace('{DOCUMENT_CONTENT}', documentContent)
      .replace('{CHUNK_CONTENT}', chunk.content);

    const response = await openaiLimiter.schedule(() =>
      openai.chat.completions.create({
        model: CONTEXT_ENRICHMENT_MODEL,
        messages: [
          { role: 'system', content: 'You are a precise technical writer. Output only the context summary, nothing else.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 150,
        temperature: 0,
      }),
    );

    const summary = (response.choices[0].message.content ?? '').trim();

    results.push({
      summary,
      tokenCount: estimateTokenCount(chunk.content),
    });
  }
```

Note: We skip `.withResponse()` here because the chat completions interface (`IOpenAIChatClientProps`) uses a structural type that doesn't expose it. The adaptive header reading on the embedding path is sufficient since both share the same RPM budget.

- [ ] **Step 3: Run existing Contextual Retrieval tests**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/chunk-context-enrichment.test.ts
```
Expected: All tests PASS. The mock OpenAI client still works because `openaiLimiter.schedule()` just wraps the call. The mock returns the same shape.

- [ ] **Step 4: Verify typecheck passes**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/search/chunk-context-enrichment.ts
git commit -m "route Contextual Retrieval calls through rate limiter"
```

---

## Task 6: Integrate Rate Limiter into Reranker

**Files:**
- Modify: `src/lib/search/reranker.ts:73-91`

- [ ] **Step 1: Add import**

In `src/lib/search/reranker.ts`, add after the existing import on line 15:

```typescript
import { cohereLimiter } from '../rate-limiter.js';
```

- [ ] **Step 2: Wrap the fetch call**

Replace the try/catch block (lines 73-91) with:

```typescript
  let response: Response;
  try {
    response = await cohereLimiter.schedule(() =>
      fetch(COHERE_RERANK_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          query,
          documents,
          top_n: topN,
        }),
      }),
    );
  } catch (_networkError) {
    // Network failure or limiter error — return originals unchanged
    return searchResults;
  }
```

- [ ] **Step 3: Run existing reranker tests**

Run:
```bash
cd ~/repos/ledger && npx vitest run tests/reranker.test.ts
```
Expected: All tests PASS. The mock fetch is still called; it's just scheduled through the limiter now.

- [ ] **Step 4: Verify typecheck passes**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/search/reranker.ts
git commit -m "route Cohere reranker calls through rate limiter"
```

---

## Task 7: Full Test Suite + Build

**Files:** None (validation only)

- [ ] **Step 1: Run full test suite**

Run:
```bash
cd ~/repos/ledger && npx vitest run
```
Expected: All tests PASS (199+ TypeScript tests)

- [ ] **Step 2: Run typecheck**

Run:
```bash
cd ~/repos/ledger && npx tsc --noEmit
```
Expected: No errors

- [ ] **Step 3: Run build**

Run:
```bash
cd ~/repos/ledger && npm run build
```
Expected: Build succeeds, `dist/` updated

---

## Task 8: Documentation Updates

**Files:**
- Ledger architecture doc (in Ledger)
- Ledger error log (in Ledger)

- [ ] **Step 1: Update ledger-errorlog in Ledger**

Use the `update_document` MCP tool to append to the `ledger-errorlog` document:

```
## S36 — Bulk Sync Rate Limit Failure (2026-04-07)

**Error:** 2 documents failed to sync during bulk ingestion via sync-local-docs.ts
**Symptoms:** OpenAI API returned 429 (rate limit exceeded). SDK default of 2 retries
  was insufficient for sustained bulk load.
**Root cause:** No proactive rate limiting. Bulk operations fired unbounded API calls
  sequentially but without pacing, exceeding the RPM limit during large batches.
**Solution:** Added Bottleneck-based proactive rate limiter (S37).
  - Token bucket with reservoir (450 RPM, 90% of Tier 1 limit)
  - Concurrency cap (10 parallel requests)
  - Adaptive header reading adjusts limits from OpenAI response headers
  - OpenAI SDK maxRetries bumped from 2 to 5
**Files:** src/lib/rate-limiter.ts, embeddings.ts, chunk-context-enrichment.ts,
  reranker.ts, config.ts
**Prevention:** All external API calls now route through rate limiter singletons.
```

- [ ] **Step 2: Update ledger-architecture in Ledger**

Use the `update_document` MCP tool to add the rate limiter to the system components section of `ledger-architecture`. Include the ingestion pipeline diagram showing where the rate limiter sits:

```
### Rate Limiter (src/lib/rate-limiter.ts)

Provider-agnostic proactive rate limiting using Bottleneck. Prevents 429 errors
by controlling request flow before they reach the API.

Two singleton instances:
- openaiLimiter: shared by generateEmbedding() and generateContextSummaries()
- cohereLimiter: used by rerankResults() (inactive until reranker re-enabled)

Ingestion call flow:
  content --> chunking --> [openaiLimiter] --> Contextual Retrieval
                                                     |
                                              [openaiLimiter] --> embedding --> Supabase

Search call flow:
  query --> [openaiLimiter] --> query embedding --> hybrid search --> [cohereLimiter] --> rerank
```

- [ ] **Step 3: Search for RAG reference doc and update if it exists**

Search Ledger for a RAG pipeline or reference architecture document. If one exists, add rate limiting as a standard layer in the pipeline description. If none exists, skip this step.
