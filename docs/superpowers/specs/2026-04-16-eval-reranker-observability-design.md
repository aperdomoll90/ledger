# Eval Runner + Reranker Observability Design

> Date: 2026-04-16 (Session 44)
> Status: Approved
> Depends on: Phase 2 Search Observability (done S43, nesting fix S44)

---

## Goal

Instrument the eval runner pipeline and reranker internals with Langfuse traces so that:

1. Every eval run is a single Langfuse trace with per-query child spans
2. Each query span contains the full search trace tree (Phase 2) nested inside
3. Reranker internals are decomposed into queue wait, API call, and error path spans
4. Historical eval runs can be compared through the Langfuse dashboard and CLI output

## Approach

Extend the existing observability module (Phase 2) rather than creating a parallel trace system. Eval context threads through the same search traces, producing one unified trace tree per eval run.

---

## 1. Eval Run Trace Structure

```
eval-run (root trace)
  sessionId: eval-{UUID}
  tags: ['eval', 'run'] (+ 'dry-run' if applicable)
  input: { config snapshot }
  output: { metrics summary, comparison severity }
  |
  +-- eval-query (span, repeated per golden dataset query)
  |     input: { query, goldenId, tags, expectedDocs }
  |     output: { hit, firstResultHit, position, reciprocalRank, ndcg, responseTimeMs }
  |     |
  |     +-- search (Phase 2 trace, auto-nested via OTel context)
  |           +-- OpenAI.embeddings
  |           +-- semantic-cache-lookup
  |           +-- retrieve
  |           |     +-- retrieve.vector
  |           |     +-- retrieve.keyword
  |           |     +-- retrieve.fusion
  |           +-- rerank (when enabled)
  |           |     +-- rerank.prepare
  |           |     +-- rerank.queue-wait
  |           |     +-- rerank.api-call
  |           +-- semantic-cache-store
  |
  +-- eval-analysis (span, once after all queries)
        input: { testCaseCount, normalCount, outOfScopeCount }
        output: { metrics, comparison, severity, confidenceIntervals }
```

## 2. Observability Helpers (observability.ts)

### runEvalTrace

Root trace for an eval run. Wraps the entire eval execution.

```typescript
async function runEvalTrace<T>(
  props: {
    sessionId: string;
    tags: string[];
    config: Record<string, unknown>;
    dryRun: boolean;
  },
  work: (trace: IObservationHandle) => Promise<T>,
): Promise<T>
```

Implementation: Uses `propagateAttributes` + `startActiveObservation` (same pattern as `runSearchTrace`). Sets `sessionId`, `tags`, `environment: 'eval'`. The active observation becomes the parent for all child spans.

### runEvalQuerySpan

Per-query child span. Wraps one golden dataset query execution + scoring.

```typescript
async function runEvalQuerySpan<T>(
  props: {
    query: string;
    goldenId: number;
    tags: string[];
    expectedDocs: number[];
  },
  work: (span: IObservationHandle) => Promise<T>,
): Promise<T>
```

Implementation: Uses `startActiveObservation` inside the eval trace context. The search trace from `runSearchTrace` (Phase 2) auto-nests under this span via OTel context propagation.

Both helpers no-op when observability is disabled (same pattern as all existing helpers).

## 3. Eval Command Changes (commands/eval.ts)

### evalSearch() modifications

```
Before:
  for each testCase:
    results = searchHybrid(clients, props)
    scored  = scoreTestCase(testCase, results, timing)

After:
  runEvalTrace({ sessionId, tags, config, dryRun }, async (evalTrace) => {
    for each testCase:
      runEvalQuerySpan({ query, goldenId, tags, expectedDocs }, async (querySpan) => {
        results = searchHybrid(clients, props)
        scored  = scoreTestCase(testCase, results, timing)
        querySpan.update({ output: scored })
      })

    // After all queries:
    evalAnalysisSpan = startSpan('eval-analysis')
    metrics   = computeMetrics(allResults)
    advanced  = computeAdvanced(allResults)
    comparison = compareRuns(metrics, previousRun)
    evalAnalysisSpan.update({ output: { metrics, comparison } })
    evalAnalysisSpan.end()

    evalTrace.update({ output: { metrics summary, severity } })
  })
```

The `clients` object already carries `sessionId` and `observabilityEnvironment`. The eval command sets `observabilityEnvironment: 'eval'` so search traces are tagged correctly.

## 4. Reranker Internal Spans (reranker.ts)

### Current state

`rerankResults()` is called inside a `rerank` span in `ai-search.ts`. That span uses `startSpan()` (passive OTel span). Child spans inside `rerankResults` would nest under it only if the rerank span sets an active context.

### Changes

**ai-search.ts:** Replace the passive `startSpan('rerank')` with `startActiveObservation('rerank', callback)` so the reranker's internal spans nest correctly.

**reranker.ts:** Add three child spans inside `rerankResults()`:

#### rerank.prepare
- Wraps document serialization (map results to Cohere format)
- `input`: `{ documentCount }`
- `output`: `{ totalContentLength }` (bytes sent to API)

#### rerank.queue-wait
- Wraps the Bottleneck rate limiter queue time
- `output`: `{ waitMs }` (time from span start to API call start)
- Measured by recording timestamp before `cohereLimiter.schedule()` and after the callback starts

#### rerank.api-call
- Wraps the actual `fetch()` to Cohere
- `input`: `{ model, topN, documentCount }`
- `output` (success): `{ statusCode: 200, resultCount, latencyMs }`
- `output` (error): `{ fallback: true, errorType: 'network' | 'http' | 'parse', error, statusCode? }`

### Error path attribution

When reranking fails and falls back to originals, the parent `rerank` span gets:
```
output: { fallback: true, errorType, error, inputCount, outputCount: inputCount }
```

This lets you filter for degraded searches in Langfuse: any trace where `rerank.output.fallback === true`.

## 5. Active Context for Rerank Nesting

The rerank span in `ai-search.ts` currently uses `startSpan('rerank')` which creates a passive OTel span. For reranker internal spans to nest under it, we need an active context.

Two options considered:

**Option A:** Replace `startSpan('rerank')` with a callback-based wrapper using `startActiveObservation`.
**Option B:** Use `context.with(trace.setSpan(context.active(), span))` from `@opentelemetry/api` to manually activate the span before calling `rerankResults`.

Chosen: **Option B.** It's a one-line change at the call site and doesn't require restructuring the rerank code block. The `startSpan` already returns an OTel span under the hood (from the Phase 2 fix). We expose a `withActiveSpan` helper in `observability.ts` that activates any OTel span for its callback's duration.

```typescript
// observability.ts
function withActiveSpan<T>(span: IObservationHandle, work: () => Promise<T>): Promise<T>
```

Implementation detail: `startSpan` already creates an OTel `Span` internally. We return an extended handle that includes the raw span reference:

```typescript
interface IActiveObservationHandle extends IObservationHandle {
  _otelSpan: OTelSpan; // Internal, used only by withActiveSpan
}
```

`startSpan` returns `IActiveObservationHandle` (which satisfies `IObservationHandle`). `withActiveSpan` reads `_otelSpan` to call `context.with(trace.setSpan(context.active(), span), work)`. Callers that only use `IObservationHandle` see no change.

## 6. Graceful Degradation

Same pattern as all existing observability:

- When Langfuse env vars are absent: `enabled = false`, all helpers no-op
- Eval behavior unchanged with or without tracing
- No performance impact when disabled
- No new required dependencies

## 7. What Is NOT In Scope

- `eval:sweep` instrumentation (runs many threshold variations, would generate excessive traces)
- `eval:judge` instrumentation (interactive session, traces not useful)
- `eval:show` instrumentation (read-only display)
- New CLI commands (trend report is a one-time execution, not a new command)
- Changes to eval metrics computation (pure functions, no I/O)
- Changes to eval store / persistence layer
- Changes to search functions (already instrumented)

## 8. Verification Plan

1. Run TypeScript tests (231 tests pass)
2. Run `ledger eval` with Langfuse active
3. Verify in Langfuse:
   - Root `eval-run` trace exists with correct sessionId, tags, config
   - 144 `eval-query` child spans with scoring output
   - Each query span contains nested search trace (cache/retrieve/embed)
   - `eval-analysis` span with final metrics
4. Verify eval run saved to `eval_runs` table (run 15)
5. Compare run 15 against run 14 (automatic comparison output)
6. Pull historical runs (7, 11, 13, 14, 15) for trend table

## 9. Files Changed

| File                              | Change                                                    |
|-----------------------------------|-----------------------------------------------------------|
| `src/lib/observability.ts`        | Add `runEvalTrace`, `runEvalQuerySpan`, `withActiveSpan`  |
| `src/commands/eval.ts`            | Wrap eval pipeline in trace helpers                       |
| `src/lib/search/reranker.ts`      | Add prepare, queue-wait, api-call child spans             |
| `src/lib/search/ai-search.ts`     | Activate rerank span context for child nesting            |
| `tests/observability.test.ts`     | Tests for new helpers (no-op when disabled)               |
| `tests/ai-search.test.ts`         | Update rerank span expectations if mocked                 |
