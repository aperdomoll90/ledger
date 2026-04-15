# Phase 2: Search Pipeline Observability with Langfuse

> Spec date: 2026-04-15 (Session 43)
> Status: Pending approval
> Priority: Roadmap #1 (observability system, Phase 2)
> Builds on: [2026-04-14-observability-langfuse-design.md](2026-04-14-observability-langfuse-design.md) (Phase 1, ingestion)

## Problem

Ledger's search pipeline writes wall-clock response time to `search_evaluations`, but has no step-level breakdown (query embedding vs semantic cache vs DB search vs RRF merge vs rerank) and no cost tracking. When a search is slow, there is no way to attribute the latency to a specific stage. When cache hit rate changes, there is no way to correlate it with a code change. Eval runs and production MCP queries are not distinguishable from each other in any operational metric.

Phase 1 solved this for ingestion. Phase 2 extends the same self-hosted Langfuse instance to the search path and closes the remaining dashboard item (MCP server not instrumented).

Without this, we cannot:

- Detect search regressions after prompt, threshold, or chunking changes
- Measure actual semantic cache hit rate in production vs eval
- Attribute search cost across components (embedding API, DB compute)
- Group related queries from a single Claude conversation or eval run
- Confirm whether hybrid search latency is vector-bound, keyword-bound, or fusion-bound

## Background: What Production RAG Systems Do

Phase 1 established the distributed-tracing foundation (OpenTelemetry + Langfuse). Phase 2 follows the emerging **OTel GenAI semantic conventions** (draft spec from the OpenTelemetry GenAI SIG) which define standard span names for retrieval pipelines: `gen_ai.embed`, `rag.retrieve.vector`, `rag.retrieve.keyword`, `rag.fusion`, `rag.rerank`. Reference implementations (LangChain's `langchain-opentelemetry`, LlamaIndex's callback manager, Arize Phoenix, Traceloop OpenLLMetry) all emit a distinct span per stage.

For **custom PL/pgSQL functions** that perform multiple internal steps (our `match_documents_hybrid`), the canonical pattern is:

1. Function internally captures `clock_timestamp()` deltas for each sub-stage.
2. Function returns timing as a `jsonb` sidecar alongside results.
3. Application reads the timing and emits child spans with correct `startTime` / `endTime`.

This is what Supabase's reference RAG samples, Timescale's pgvectorscale examples, and production retrievers at Cohere and similar companies do. "Split the RPC into multiple client-side calls" is an anti-pattern: it breaks atomicity, doubles network round-trips, and introduces timing skew between the two searches.

## Solution

Extend Phase 1's Langfuse instrumentation to the search pipeline. Concretely:

- Trace every search call (vector, keyword, hybrid) from all three callers (CLI, MCP server, eval runner).
- Instrument the hybrid Postgres RPC with a timing sidecar so we get step-level spans for vector / keyword / fusion inside a single DB round-trip.
- Call `initObservability()` from the MCP server startup (closes the existing dashboard "known issue").
- Tag traces with `environment` (prod / eval / dev) and `sessionId` (MCP connection, CLI invocation, eval run) so the dashboard can slice cleanly.

### What This Is Not

- Not a replacement for `search_evaluations`. That table tracks **retrieval quality** (which documents came back for which golden query). Langfuse tracks **operational performance** (where time went, what it cost). Both coexist.
- Not a cache-tuning tool (no miss-reason diagnostics). Deferred.
- Not a reranker quality analyzer (no per-document reranker scores). Deferred.
- Not alerting. No thresholds, no webhooks. Dashboard-only.

## Architecture

### Trace Structure

Every search call produces one trace with nested spans:

```
Trace: "search"
│  environment: prod | eval | dev
│  sessionId:   MCP connection ID | CLI invocation UUID | eval_run_id
│  tags:        ["search", mode]              mode = vector | keyword | hybrid | hybrid+rerank
│  input:       { query, filters: { domain, project, document_type } }
│  output:      { resultCount, topResultIds, cacheHit }
│  metadata:    { threshold, limit, rerankerEnabled }
│
├─ Generation: "query-embedding"              auto-captured by observeOpenAI
│    model, promptTokens, cost
│
├─ Span: "semantic-cache-lookup"
│    output: { hit: bool, similarity: number | null }
│    timing: start, end
│
├─ Span: "retrieve"                           only on cache miss
│  │  timing: start, end (total RPC time)
│  │
│  ├─ Span: "retrieve.vector"                 from RPC timing sidecar, hybrid only
│  ├─ Span: "retrieve.keyword"                from RPC timing sidecar, hybrid only
│  └─ Span: "retrieve.fusion"                 from RPC timing sidecar, hybrid only
│
├─ Span: "rerank"                             only when reranker enabled
│    output: { inputCount, outputCount }
│    timing: start, end
│
└─ Span: "semantic-cache-store"               fire-and-forget, skipped on cache hit
     timing: start, end
```

**Attribute naming:** OTel GenAI semantic conventions where they exist (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.response.model`). Ledger-specific fields use a `ledger.*` prefix to avoid collision.

**Cache hits short-circuit the trace.** When `semantic-cache-lookup` returns a hit, no `retrieve` / `rerank` / `cache-store` spans emit. The cache-lookup span carries the hit status as an attribute. Total trace time reflects real user-perceived latency.

### Metadata Attached to Every Trace

| Field           | Source                                                             | Purpose                                           |
|-----------------|--------------------------------------------------------------------|---------------------------------------------------|
| `environment`   | `NODE_ENV` for prod/dev; hardcoded `"eval"` in eval runner         | Top-level filter                                  |
| `tags`          | `["search", mode]`                                                  | Filter by search mode                             |
| `sessionId`     | MCP connection ID / CLI invocation UUID / eval_run_id              | Group related queries                             |
| `input`         | `{ query, filters }`                                                | See what was asked                                |
| `output`        | `{ resultCount, topResultIds, cacheHit }`                          | See what came back                                |
| `metadata`      | `{ threshold, limit, rerankerEnabled }`                            | Reproduce the search config                       |

## Database Changes

### New Migration: `006-hybrid-search-timing.sql`

Modify `match_documents_hybrid` to capture internal timing via `clock_timestamp()` and return it as a `timing jsonb` column on every result row.

**Why `clock_timestamp()` and not `now()`:** `now()` returns the transaction start time; every call inside a transaction returns the same value. `clock_timestamp()` returns real wall-clock time on each call.

**Why on every row and not an OUT parameter:** repeating the identical timing payload on each row is a minor storage cost but preserves the PostgREST/supabase-js response shape (a flat table of rows). OUT parameters complicate the client-side unpacking.

**Timing payload shape:**

```json
{ "vector_ms": 80, "keyword_ms": 90, "fusion_ms": 30 }
```

**Scope of the migration:**

- Only `match_documents_hybrid` changes.
- `match_documents` (vector-only) and `match_documents_keyword` (keyword-only) are single-step; their total time equals their only step, so a timing sidecar adds no information.

### Backwards Compatibility

If the migration has not run, TypeScript reads `undefined` for `timing` and silently skips the three child spans. The parent `retrieve` span still emits with total time. No breakage.

## TypeScript Changes

### New Helpers in `src/lib/observability.ts`

| Helper                                                         | Purpose                                                           |
|----------------------------------------------------------------|-------------------------------------------------------------------|
| `startSearchTrace(params)`                                     | Open the root search trace with environment, tags, sessionId, input, metadata. Returns a handle. |
| `recordChildSpan(parent, name, startMs, endMs, attrs)`         | Emit a span with reconstructed timestamps. Used for hybrid sub-spans from the RPC sidecar. |
| `finalizeSearchTrace(trace, output)`                           | Attach output and close the trace.                                |

Phase 1 used raw `startObservation` calls directly in the ingestion path. Now that we have two pipelines, the thin abstraction earns its place.

### Modified Files

| File                                            | Change                                                                                    |
|-------------------------------------------------|-------------------------------------------------------------------------------------------|
| `src/lib/search/ai-search.ts`                   | Wrap each of `searchByVector`, `searchByKeyword`, `searchHybrid` in trace start/finalize. Add inline spans for cache lookup and cache store. In `searchHybrid`, read `timing` sidecar and emit three child spans. Wrap reranker call in its own span. |
| `src/lib/search/semantic-cache.ts`              | No structural changes. Caller in `ai-search.ts` provides the span.                         |
| `src/lib/search/reranker.ts`                    | No structural changes. Caller provides the span.                                           |
| `src/mcp-server.ts`                             | Call `initObservability()` at startup, `shutdownObservability()` on SIGTERM/SIGINT. Capture MCP connection ID into request context so search handlers can pass it as `sessionId`. |
| `src/cli.ts`                                    | Generate one CLI invocation UUID at startup; pass it through to search calls as `sessionId`. |
| `src/commands/eval.ts`                          | Pass `environment: "eval"` and `sessionId: eval_run_id` when invoking search.              |

### Session ID Strategy

| Caller        | `sessionId` value                                               | Plumbing                                    |
|---------------|-----------------------------------------------------------------|---------------------------------------------|
| CLI command   | UUID generated once at CLI startup, reused across subcommands.  | Set on a module-level context object.       |
| MCP server    | MCP client connection ID if the transport exposes one; otherwise a UUID generated once per MCP server process. | Captured in MCP handler, threaded to search via request context. |
| Eval runner   | `eval_run_id` already used in `search_evaluations`.             | Natural reuse.                              |

### Environment Tagging

| Caller        | `environment` value                          | Source                                       |
|---------------|----------------------------------------------|----------------------------------------------|
| CLI, MCP      | `process.env.NODE_ENV ?? 'development'`      | Same convention as Phase 1.                  |
| Eval runner   | `"eval"` (hardcoded, overrides `NODE_ENV`)   | Set once when eval runner boots.             |

### Graceful Degradation

Inherits Phase 1's pattern. If Langfuse env vars are absent, all trace helpers no-op. Search behavior, return shapes, and error handling are unchanged.

## Coexistence with `search_evaluations`

Kept as-is. Different layer, different purpose:

| System                  | Tracks                                                           | When to query                                    |
|-------------------------|------------------------------------------------------------------|--------------------------------------------------|
| `search_evaluations`    | Retrieval quality (which docs came back for which golden query). | Eval analysis, hit rate / MRR / NDCG computation. |
| Langfuse                | Operational performance (where time went, what it cost).         | Debugging slow queries, cost trends, regressions. |

No data migrated or deduplicated between them. Both write fire-and-forget from the search path.

## Testing Strategy

| Test type       | Covers                                                                                           | Location                           |
|-----------------|--------------------------------------------------------------------------------------------------|------------------------------------|
| pgTAP           | `match_documents_hybrid` returns a `timing` column with numeric `vector_ms`, `keyword_ms`, `fusion_ms`. Values non-negative; sum within epsilon of total wall-clock. | `tests/pgtap/hybrid-timing.sql`    |
| TypeScript unit | `observability.ts` helpers: trace/span shape, graceful degradation, timestamp reconstruction math. | `src/lib/observability.test.ts`    |
| TypeScript unit | `searchHybrid` handles both present and absent `timing` sidecar. Cache-hit path omits downstream spans. | `src/lib/search/ai-search.test.ts` |
| Integration     | With Langfuse running, run one vector + one keyword + one hybrid search. Assert trace appears in Langfuse API within 10s, has expected span tree, carries expected attributes. | `tests/integration/search-traces.test.ts` |
| Manual          | CLI search, MCP call from Claude, and eval run each produce expected traces. Filter by `environment: eval` vs `prod` in dashboard. | `docs/manual-test-phase-2.md`      |

**Regression guard:** Phase 1 ingestion tests must pass unchanged. `observability.ts` gains new exports but must not alter existing exports.

**Performance assertion:** unit test measures `searchHybrid` latency with and without Langfuse env vars; difference must be under 5ms on average. Guards against accidental synchronous tracing.

## Success Criteria

- CLI, MCP, and eval-run searches each produce complete traces in the Langfuse dashboard with correct span structure.
- Hybrid search traces show three child spans (`retrieve.vector`, `retrieve.keyword`, `retrieve.fusion`) with timing pulled from the RPC sidecar.
- Cache-hit traces have one cache-lookup span with `hit: true` and no downstream retrieval spans. Total time matches real latency.
- `environment: eval` filters cleanly from `prod` / `development` in the dashboard.
- `sessionId` groups related searches correctly (MCP conversation, CLI multi-command session, eval run).
- MCP server calls `initObservability()` at startup and `shutdownObservability()` on exit. Dashboard's "MCP not instrumented" known issue closes.
- Ledger search works identically when Langfuse env vars are absent.
- No measurable latency regression on search with tracing enabled (under 5ms overhead).
- Phase 1 ingestion tracing continues to work with zero changes needed.

## Deferred (Phase 3+)

| Item                                  | Revisit trigger                                                 |
|---------------------------------------|-----------------------------------------------------------------|
| Phase 3: eval traces as first-class   | After Phase 2 data confirms eval runs are visible; when we want pass/fail scoring inside Langfuse. |
| Phase 4: alerting / budgets           | After baseline latency and cost trends are understood.          |
| Deep cache diagnostics (miss reasons) | When production cache hit rate is measured below a target threshold and we actively want to tune it. |
| Reranker per-document score traces    | When the reranker is re-enabled (currently disabled for privacy, Phase 4.5.1). |

## Phasing (Updated)

| Phase   | Scope                                                        | Status         |
|---------|--------------------------------------------------------------|----------------|
| Phase 1 | Ingestion traces                                             | Done (S42)     |
| Phase 2 | Search traces (this spec)                                    | This spec      |
| Phase 3 | Eval traces (per golden query, per eval run)                 | Deferred       |
| Phase 4 | Alerting (token budget thresholds, latency anomalies)        | Deferred       |
