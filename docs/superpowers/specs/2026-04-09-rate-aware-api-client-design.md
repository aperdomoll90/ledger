# Rate-Aware API Client Layer

> Spec date: 2026-04-09 (Session 37)
> Status: Approved design, pending implementation

## Problem

Ledger has no proactive rate limiting on external API calls. The OpenAI SDK retries 429 errors reactively (default 2 retries), but bulk operations (reindex, restore, large doc ingestion) overwhelm the API before retries can recover. In Session 36, 2 documents failed to sync due to OpenAI rate limiting during bulk ingestion.

### Current State

- **OpenAI calls:** `generateEmbedding()` and `generateContextSummaries()` call the API directly with no pacing
- **Cohere calls:** `rerankResults()` uses raw `fetch()` with graceful degradation but no retry or pacing
- **Supabase calls:** Low risk (generous limits), not targeted by this work
- **OpenAI SDK built-in retry:** 3 attempts (maxRetries: 2) with 0.5s-8s exponential backoff + jitter. Respects `Retry-After` headers. Sufficient for sporadic 429s, insufficient for sustained bulk load.

## Solution

Two layers, each independently useful:

1. **Proactive pacing** (Bottleneck library): prevents 429s by controlling request flow
2. **Reactive retry** (OpenAI SDK built-in): catches what slips through, bumped from 2 to 5 retries

### Industry Context

| Approach              | Who uses it       | How                                        |
|-----------------------|-------------------|--------------------------------------------|
| Reactive only (retry) | OpenAI SDK, Stripe | Wait for failure, back off, retry          |
| Proactive + reactive  | AWS SDK v3         | Prevent failures by pacing, retry the rest |

This design follows the AWS approach: proactive pacing as the primary defense, reactive retry as the safety net.

## Architecture

### Call Flow: Document Ingestion Pipeline

```
content --> chunking --> [rate limiter] --> Contextual Retrieval --> [rate limiter] --> embedding --> Supabase
                              |                                          |
                         Bottleneck                                 Bottleneck
                       (shared OpenAI                            (shared OpenAI
                         instance)                                 instance)
```

### Call Flow: Search Pipeline

```
query --> [rate limiter] --> query embedding --> Supabase hybrid search --> [rate limiter] --> rerank (optional)
               |                                                                |
          Bottleneck                                                       Bottleneck
         (openaiLimiter)                                                (cohereLimiter)
```

### Components

| Component                    | File                                         | Change   | Purpose                                           |
|------------------------------|----------------------------------------------|----------|---------------------------------------------------|
| Rate limiter factory         | `src/lib/rate-limiter.ts`                    | Create   | Provider-agnostic Bottleneck factory + presets     |
| Rate limiter tests           | `src/lib/rate-limiter.test.ts`               | Create   | Unit tests for factory, presets, header adaptation |
| Embedding generation         | `src/lib/search/embeddings.ts`               | Modify   | Schedule calls through openaiLimiter               |
| Contextual Retrieval         | `src/lib/search/chunk-context-enrichment.ts` | Modify   | Schedule calls through openaiLimiter               |
| Reranker                     | `src/lib/search/reranker.ts`                 | Modify   | Schedule calls through cohereLimiter               |
| Client config                | `src/lib/config.ts`                          | Modify   | Bump OpenAI maxRetries to 5                        |

## Rate Limiter Module

### File: `src/lib/rate-limiter.ts`

Provider-agnostic. Any API client can use it. Not coupled to OpenAI.

### Interface

```typescript
interface IRateLimiterConfig {
  maxConcurrent: number;            // max parallel requests
  reservoirAmount: number;          // requests allowed per window
  reservoirRefreshInterval: number; // window size in ms
  minTime: number;                  // minimum ms between requests
  retryLimit: number;               // Bottleneck-level retries on failure
}
```

### Factory Function

```typescript
createRateLimiter(config: IRateLimiterConfig): Bottleneck
```

Returns a Bottleneck instance with:
- Reservoir, concurrency, and pacing configured from the provided config
- `failed` event handler wired for retry on 429 and 5xx errors with exponential backoff

### Provider Presets

```typescript
const OPENAI_TIER_1: IRateLimiterConfig = {
  maxConcurrent: 10,
  reservoirAmount: 450,              // 90% of 500 RPM limit (safety margin)
  reservoirRefreshInterval: 60_000,  // 1 minute window
  minTime: 100,                      // 100ms minimum between requests
  retryLimit: 3,
};

const COHERE_TRIAL: IRateLimiterConfig = {
  maxConcurrent: 5,
  reservoirAmount: 90,               // 90% of 100 RPM limit
  reservoirRefreshInterval: 60_000,
  minTime: 200,
  retryLimit: 3,
};
```

### Adaptive Header Reading

```typescript
updateLimitsFromHeaders(limiter: Bottleneck, headers: Headers): void
```

Reads `x-ratelimit-remaining-requests` from OpenAI response headers. If the reported remaining is lower than our reservoir's current value, adjusts the reservoir downward. Called after each successful request in the hot-path functions.

Requires using `.withResponse()` on OpenAI SDK calls to access headers.

### Limiter Instances

| Instance         | Provider | Protects                                                       | Budget   |
|------------------|----------|----------------------------------------------------------------|----------|
| `openaiLimiter`  | OpenAI   | `generateEmbedding()`, `generateContextSummaries()`            | Shared   |
| `cohereLimiter`  | Cohere   | `rerankResults()` (idle until reranker re-enabled)             | Separate |

Both exported as singletons from `rate-limiter.ts`. Created once at module load. All call sites import the same instance, ensuring a single shared budget per provider.

## Hot-Path Integration

### `generateEmbedding()` (embeddings.ts)

- Wrap `openai.embeddings.create()` with `openaiLimiter.schedule()`
- Use `.withResponse()` to access headers after each call
- Call `updateLimitsFromHeaders()` on success

### `generateContextSummaries()` (chunk-context-enrichment.ts)

- Wrap `openai.chat.completions.create()` with `openaiLimiter.schedule()`
- Loop stays sequential (order matters for context), limiter controls pacing
- Use `.withResponse()` to access headers after each call
- Call `updateLimitsFromHeaders()` on success

### `rerankResults()` (reranker.ts)

- Wrap `fetch()` call with `cohereLimiter.schedule()`
- Existing graceful degradation (return originals on failure) remains unchanged
- Currently inactive (reranker disabled for privacy). Ready when re-enabled.

### `config.ts`

```typescript
openai: new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 5,  // up from default 2
})
```

## Error Handling

- Bottleneck retries up to 3 times on 429/5xx via the `failed` event handler
- OpenAI SDK retries up to 5 times on 429/5xx via `maxRetries: 5`
- Worst case: 15 total attempts before failure surfaces to the caller
- Errors bubble up unchanged. No swallowing. Callers see the same `RateLimitError` or `APIError` they would today, after more attempts.

## Dependencies

| Package      | Version | Weekly downloads | Notes                                      |
|--------------|---------|------------------|--------------------------------------------|
| `bottleneck` | ^2.19   | 14M+             | Stable since 2019. Complete, not abandoned. |

Single new dependency. No transitive dependencies.

## Testing

Tests live next to source: `src/lib/rate-limiter.test.ts`

| Test                                  | Type        | What it verifies                                          |
|---------------------------------------|-------------|-----------------------------------------------------------|
| Factory returns configured instance   | Unit        | maxConcurrent, reservoir, minTime match config            |
| Presets are valid                      | Unit        | OpenAI and Cohere presets produce working limiters        |
| Header update adjusts reservoir       | Unit        | `updateLimitsFromHeaders` lowers reservoir when needed    |
| generateEmbedding uses limiter        | Integration | Mock Bottleneck, assert `schedule()` called               |
| generateContextSummaries uses limiter | Integration | Mock Bottleneck, assert `schedule()` called               |
| Errors propagate unchanged            | Unit        | After retries exhausted, original error surfaces          |

## Documentation Updates

| Document              | Update                                                                |
|-----------------------|-----------------------------------------------------------------------|
| `ledger-architecture` | Add rate limiter as system component in the API call chain            |
| `ledger-errorlog`     | S36 sync failure: root cause (no pacing) + solution (Bottleneck + retry bump) |
| RAG reference doc     | Add rate limiting as a standard layer in the retrieval pipeline       |

### Error Log Entry

```
Error: 2 docs failed to sync during S36 bulk ingestion (rate limited by OpenAI)
Root cause: No proactive rate limiting. Bulk operations fired unbounded API calls.
  SDK default maxRetries (2) insufficient for sustained load.
Solution: Bottleneck proactive pacing (token bucket with reservoir) +
  OpenAI SDK maxRetries bumped to 5. Adaptive header reading adjusts
  limits dynamically.
Files: src/lib/rate-limiter.ts, embeddings.ts, chunk-context-enrichment.ts,
  reranker.ts, config.ts
```

## Scope Boundaries

**In scope:**
- Rate limiter factory with provider presets
- Integration with the three hot-path functions
- OpenAI maxRetries bump
- Adaptive header reading
- Unit and integration tests
- Documentation updates

**Out of scope:**
- Supabase rate limiting (low risk, not needed now)
- Token-per-minute (TPM) tracking (RPM is the binding constraint at current usage)
- Redis-backed distributed limiting (single instance is sufficient)
- Error handling audit of other call sites (separate work item)
