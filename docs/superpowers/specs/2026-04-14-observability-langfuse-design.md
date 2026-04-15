# Pipeline Observability with Langfuse

> Spec date: 2026-04-14 (Session 42)
> Status: Pending approval
> Priority: Roadmap #1 (observability system)

## Problem

Ledger's ingestion pipeline has no automated performance or cost tracking. When a document is ingested, there is no record of how long each step took (chunking, enrichment, embedding, DB write), how many tokens were consumed, or what the operation cost. The manual benchmark script provides snapshots but requires explicit invocation and doesn't track production usage over time.

The query path logs wall-clock response time to `search_evaluations`, but has no step-level breakdown (embedding time vs DB time vs cache time) and no cost tracking.

Without this data, we cannot:
- Detect performance regressions after code changes
- Track cost trends over time
- Identify which documents are expensive to ingest and why
- Set informed budgets or alerting thresholds

## Background: Distributed Tracing

This design uses **distributed tracing**, a pattern that originated at Google (their "Dapper" paper, 2010) and became an industry standard via **OpenTelemetry (OTel)**. The core idea:

- A **trace** is one end-to-end operation (e.g., ingesting a document)
- **Spans** are the timed sub-steps within a trace (e.g., chunking, enrichment, embedding)
- Spans can nest: an "enrichment" span contains child "generation" spans for each LLM call

Every major production system (Netflix, Uber, Stripe) uses this pattern. **Langfuse** adapts it specifically for LLM pipelines, adding token counts and cost as first-class concepts alongside timing.

**OpenTelemetry** is a vendor-neutral standard for collecting traces, metrics, and logs. By building on OTel, our instrumentation is not locked to Langfuse. If we ever switch to Datadog, Grafana Tempo, or Jaeger, we swap the exporter, not the instrumentation code.

## Solution

Self-hosted **Langfuse** (open-source LLM observability platform) integrated into Ledger's ingestion pipeline. Provides:

- Automatic trace/span capture for every document ingestion
- Token usage and cost calculated per operation (built-in OpenAI pricing tables)
- Step-level timing breakdown (chunking, enrichment, embedding, DB write)
- Web dashboard for exploring traces, filtering by latency, viewing cost trends

### What This Is Not

- Not replacing `search_evaluations` or the eval system. Those track retrieval quality (hit rate, NDCG, MRR). This tracks operational performance (latency, cost, throughput).
- Not a custom-built metrics system. We use an industry-standard tool instead of reinventing it.
- Not a search/eval observability system yet. Phase 1 covers ingestion only.

## Architecture

### Infrastructure (Docker)

Six containers managed by `docker-compose.yml`:

| Container          | Image                            | Purpose                                               | Exposed to host? |
|--------------------|----------------------------------|-------------------------------------------------------|-------------------|
| `langfuse-web`     | `langfuse/langfuse:3`            | Dashboard + API. Receives traces from Ledger.         | Yes (port 9100)   |
| `langfuse-worker`  | `langfuse/langfuse-worker:3`     | Background processing. Writes to ClickHouse, calculates costs. | No       |
| `postgres`         | `postgres:17`                    | Stores users, projects, API keys, metadata.           | No                |
| `clickhouse`       | `clickhouse/clickhouse-server`   | Columnar analytics store for traces/spans. Powers aggregation queries. | No |
| `redis`            | `redis:7`                        | Job queue between web and worker. Caching.            | No                |
| `minio`            | `cgr.dev/chainguard/minio`       | S3-compatible blob storage for large payloads and exports. | No          |

Only port 9100 is exposed to the host. All other containers communicate via Docker's internal network, avoiding port conflicts with other tools on the machine.

**Docker Compose location:** `docker/langfuse/docker-compose.yml`

### SDK Integration

Three npm packages added to Ledger:

| Package              | Purpose                                                                    |
|----------------------|----------------------------------------------------------------------------|
| `@langfuse/tracing`  | Manual span creation for non-API steps (chunking, DB write)               |
| `@langfuse/openai`   | Wraps OpenAI client. Auto-captures all LLM/embedding calls with tokens, timing, cost. |
| `@langfuse/otel`     | OpenTelemetry bridge. Batches spans and exports to Langfuse API.          |

### New Files

| File                                   | Purpose                                                    |
|----------------------------------------|------------------------------------------------------------|
| `docker/langfuse/docker-compose.yml`   | Langfuse stack definition (6 containers, port 9100)        |
| `docker/langfuse/.env.example`         | Template for Langfuse server environment variables         |
| `src/lib/observability.ts`             | Langfuse initialization, tracing helpers, shutdown handler |

### Modified Files

| File                                            | Change                                                          |
|-------------------------------------------------|-----------------------------------------------------------------|
| `src/lib/config.ts`                             | Export wrapped OpenAI client via `observeOpenAI()`              |
| `src/lib/documents/operations.ts`               | Add trace (root) and spans for chunking, DB write               |
| `src/lib/search/chunk-context-enrichment.ts`    | Accept wrapped OpenAI client as parameter                       |
| `src/lib/search/embeddings.ts`                  | Accept wrapped OpenAI client as parameter                       |
| `.env`                                          | Add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` |
| `package.json`                                  | Add 3 `@langfuse/*` packages + `@opentelemetry/sdk-trace-node` |

### Client Threading Strategy

The wrapped OpenAI client is created once in `config.ts` as a module-level export (same pattern as the existing `openai` client). Functions that call OpenAI (`generateContextSummaries`, `generateEmbedding`, `generateEmbeddingsBatch`) already import the client from `config.ts`. The change is: `config.ts` exports the wrapped client instead of the raw one. Downstream functions don't need new parameters; they import the same symbol, which is now instrumented.

For manual spans (chunking, DB write), the `observability.ts` module exports helper functions (`startObservation`, etc.) that are called directly in `operations.ts`.

## Trace Structure

### Ingestion Trace (createDocument / updateDocument)

```
Trace: "document-ingestion"
│  metadata: { documentName, domain, documentType, contentLength }
│  tags: ["ingestion", "create" | "update"]
│
├─ Span: "chunking"
│    input:  { contentLength }
│    output: { chunkCount, avgChunkSize }
│    timing: start, end
│
├─ Span: "context-enrichment"
│  │  metadata: { chunkCount, model }
│  │  timing: start, end (total enrichment time)
│  │
│  ├─ Generation: "document-summary"
│  │    model, promptTokens, completionTokens, cost
│  │
│  ├─ Generation: "chunk-enrichment-0"
│  │    model, promptTokens, completionTokens, cost
│  ├─ Generation: "chunk-enrichment-1"
│  │    ...
│  └─ Generation: "chunk-enrichment-N"
│
├─ Span: "batch-embedding"
│  │  metadata: { chunkCount, model, batchSize }
│  │  timing: start, end
│  │
│  └─ Generation: "embedding-batch"
│       model, totalTokens, cost
│
└─ Span: "db-write"
     input:  { chunkCount }
     output: { documentId }
     timing: start, end
```

Auto-captured by `observeOpenAI`: all Generation spans (enrichment LLM calls, embedding calls). Token usage, model, input/output, timing, and cost are populated automatically from OpenAI API responses.

Manually instrumented: Trace root, Chunking span, Context-enrichment parent span, DB-write span.

## Observability Module (`src/lib/observability.ts`)

### Initialization

```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider } from '@langfuse/tracing';

export function initObservability(): void {
  // Skip if Langfuse env vars are not set (allows running without Langfuse)
  if (!process.env.LANGFUSE_PUBLIC_KEY) return;

  const provider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        environment: process.env.NODE_ENV ?? 'development',
        exportMode: 'batched',
        flushAt: 10,
        flushInterval: 2,
      })
    ]
  });

  setLangfuseTracerProvider(provider);
}
```

### Graceful Degradation

If Langfuse is not running or env vars are missing, Ledger works exactly as before. No traces are sent. No errors are thrown. Observability is opt-in, not a dependency.

### Shutdown

```typescript
export async function shutdownObservability(): Promise<void> {
  // Flush pending traces before process exit
  const provider = getTracerProvider();
  if (provider) {
    await provider.forceFlush();
    await provider.shutdown();
  }
}
```

Called from the CLI entry point on process exit to ensure all traces are flushed.

## Environment Variables

### Ledger (.env)

| Variable               | Value                         | Required | Purpose                          |
|------------------------|-------------------------------|----------|----------------------------------|
| `LANGFUSE_PUBLIC_KEY`  | `pk-lf-...` (from dashboard)  | No       | Identifies Langfuse project      |
| `LANGFUSE_SECRET_KEY`  | `sk-lf-...` (from dashboard)  | No       | Authenticates trace writes       |
| `LANGFUSE_BASE_URL`    | `http://localhost:9100`       | No       | Self-hosted instance URL         |

All optional. When absent, observability is silently disabled.

### Langfuse Server (docker/.env)

| Variable                | Purpose                                  |
|-------------------------|------------------------------------------|
| `SALT`                  | Crypto salt (generated once)             |
| `ENCRYPTION_KEY`        | Data encryption key (generated once)     |
| `NEXTAUTH_SECRET`       | Session signing key (generated once)     |
| `NEXTAUTH_URL`          | `http://localhost:9100`                  |
| `DATABASE_URL`          | Internal Postgres connection string      |
| `CLICKHOUSE_URL`        | Internal ClickHouse connection string    |
| `REDIS_HOST`            | Internal Redis hostname                  |
| `LANGFUSE_INIT_*`      | Bootstrap org/project/user on first run  |

All server env vars stay in `docker/langfuse/.env`, separate from Ledger's `.env`.

## Phasing

| Phase   | Scope                                                        | Status         |
|---------|--------------------------------------------------------------|----------------|
| Phase 1 | Ingestion traces (this spec)                                | This spec      |
| Phase 2 | Search traces (query embedding, cache, vector/keyword, RRF) | Deferred       |
| Phase 3 | Eval traces (per golden query, per eval run)                | Deferred       |
| Phase 4 | Alerting (token budget thresholds, latency anomalies)       | Deferred       |

## Testing Strategy

| Test type       | What                                                          |
|-----------------|---------------------------------------------------------------|
| Unit            | `observability.ts`: init with/without env vars, span helpers  |
| Integration     | Ingest a document with Langfuse running, verify trace appears in API |
| Manual          | Visual check in dashboard: trace structure, cost calculation, timing breakdown |

## Success Criteria

- Ingesting a document creates a complete trace visible in the Langfuse dashboard
- Each pipeline step (chunking, enrichment, embedding, DB write) appears as a distinct span with timing
- LLM calls show token usage and cost (auto-calculated from OpenAI pricing)
- Ledger works normally when Langfuse is not running (graceful degradation)
- No measurable performance impact on ingestion (tracing is async/batched)
