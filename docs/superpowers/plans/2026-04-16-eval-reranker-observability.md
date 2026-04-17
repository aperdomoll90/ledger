# Eval Runner + Reranker Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the eval runner pipeline and reranker internals with Langfuse traces so every eval run is a single trace with per-query child spans, and reranker calls are decomposed into queue/API/error spans.

**Architecture:** Extend the existing observability module (Phase 2) with three new helpers (`runEvalTrace`, `runEvalQuerySpan`, `withActiveSpan`). Thread eval context through existing search traces via OTel context propagation. Instrument reranker internals with OTel child spans that nest under the search trace.

**Tech Stack:** `@opentelemetry/api`, `@langfuse/tracing`, `@langfuse/core` (all already installed)

---

## File Map

| File                            | Action | Responsibility                                    |
|---------------------------------|--------|---------------------------------------------------|
| `src/lib/observability.ts`      | Modify | Add `runEvalTrace`, `runEvalQuerySpan`, `withActiveSpan` |
| `src/commands/eval.ts`          | Modify | Wrap eval pipeline in trace helpers               |
| `src/lib/search/reranker.ts`    | Modify | Add internal spans (prepare, queue-wait, api-call) |
| `src/lib/search/ai-search.ts`   | Modify | Activate rerank span for child nesting            |
| `tests/observability.test.ts`   | Modify | Add tests for new helpers                         |
| `tests/reranker.test.ts`        | Create | Tests for reranker span instrumentation           |

---

### Task 1: Add `withActiveSpan` helper to observability.ts

Allows activating a passive OTel span so child spans nest under it. Needed for reranker nesting.

**Files:**
- Modify: `src/lib/observability.ts`
- Modify: `tests/observability.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/observability.test.ts` inside a new describe block:

```typescript
describe('withActiveSpan', () => {
  it('invokes work and returns result when observability is disabled', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const { initObservability, startSpan, withActiveSpan } = await import('../src/lib/observability.js');
    initObservability();
    const span = startSpan('parent');
    const result = await withActiveSpan(span, async () => 'nested-result');
    expect(result).toBe('nested-result');
    span.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/observability.test.ts`
Expected: FAIL with "withActiveSpan is not exported" or similar

- [ ] **Step 3: Implement `withActiveSpan` and `IActiveObservationHandle`**

In `src/lib/observability.ts`, after the existing `IObservationHandle` interface (line 30), add:

```typescript
export interface IActiveObservationHandle extends IObservationHandle {
  _otelSpan: OTelSpan | null;
}

const NOOP_ACTIVE_HANDLE: IActiveObservationHandle = {
  update: () => {},
  end: () => {},
  _otelSpan: null,
};
```

Add the import for `context` from `@opentelemetry/api` by updating the existing import (line 17):

```typescript
import { trace as otelTrace, context as otelContext, type Span as OTelSpan } from '@opentelemetry/api';
```

Then add the `withActiveSpan` function after `recordChildSpan` (end of file):

```typescript
/**
 * Execute work within an active OTel context for the given span.
 *
 * Child spans created inside `work` (via startSpan or recordChildSpan)
 * will nest under this span. Used to activate a passive span created
 * by startSpan before calling code that needs to emit children.
 *
 * No-op when observability is disabled or span has no OTel reference.
 */
export async function withActiveSpan<T>(
  handle: IObservationHandle,
  work: () => Promise<T>,
): Promise<T> {
  const activeHandle = handle as IActiveObservationHandle;
  if (!enabled || !activeHandle._otelSpan) return work();

  return otelContext.with(
    otelTrace.setSpan(otelContext.active(), activeHandle._otelSpan),
    work,
  );
}
```

Also update `startSpan` to return `IActiveObservationHandle` instead of `IObservationHandle`. Change the return type and store the OTel span reference. The function signature stays the same (return type is a superset):

Replace the current `startSpan` return block (the `return { update, end }` part) with:

```typescript
  return {
    update: (data: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(data)) {
        span.setAttribute(
          `langfuse.span.${key}`,
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      }
    },
    end: () => span.end(),
    _otelSpan: span,
  };
```

Update the disabled early return in `startSpan` from `NOOP_HANDLE` to `NOOP_ACTIVE_HANDLE`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/observability.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: 231+ tests PASS

- [ ] **Step 6: Commit**

```bash
cd ~/repos/ledger
git add src/lib/observability.ts tests/observability.test.ts
git commit -m "feat(observability): add withActiveSpan helper for child span nesting"
```

---

### Task 2: Add `runEvalTrace` and `runEvalQuerySpan` helpers

Root trace for eval runs and per-query child spans.

**Files:**
- Modify: `src/lib/observability.ts`
- Modify: `tests/observability.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/observability.test.ts`:

```typescript
describe('runEvalTrace', () => {
  it('invokes work with a no-op handle when observability is disabled', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const { initObservability, runEvalTrace } = await import('../src/lib/observability.js');
    initObservability();
    const result = await runEvalTrace(
      { sessionId: 'eval-test-123', tags: ['eval', 'run'], config: { threshold: 0.38 }, dryRun: false },
      async (trace) => {
        expect(trace.update).toBeTypeOf('function');
        expect(trace.end).toBeTypeOf('function');
        trace.update({ output: { hitRate: 96.2 } });
        return 'eval-done';
      },
    );
    expect(result).toBe('eval-done');
  });
});

describe('runEvalQuerySpan', () => {
  it('invokes work with a no-op handle when observability is disabled', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    const { initObservability, runEvalQuerySpan } = await import('../src/lib/observability.js');
    initObservability();
    const result = await runEvalQuerySpan(
      { query: 'test query', goldenId: 42, tags: ['simple'], expectedDocs: [1, 2] },
      async (span) => {
        expect(span.update).toBeTypeOf('function');
        expect(span.end).toBeTypeOf('function');
        span.update({ output: { hit: true, position: 0 } });
        return 'query-done';
      },
    );
    expect(result).toBe('query-done');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/repos/ledger && npx vitest run tests/observability.test.ts`
Expected: FAIL with "runEvalTrace is not exported"

- [ ] **Step 3: Implement `runEvalTrace`**

Add to `src/lib/observability.ts` after `runSearchTrace`, before `recordChildSpan`:

```typescript
// =============================================================================
// Eval-specific helpers (Phase 3)
// =============================================================================

export interface IStartEvalTraceProps {
  sessionId: string;
  tags: string[];
  config: Record<string, unknown>;
  dryRun: boolean;
}

/**
 * Run an eval execution inside an open Langfuse trace.
 *
 * Creates a root trace named 'eval-run' that groups all per-query spans
 * under one session. The search traces from Phase 2 (runSearchTrace)
 * auto-nest under per-query spans via OTel context propagation.
 *
 * When observability is disabled, `work` runs with a no-op handle.
 */
export async function runEvalTrace<T>(
  props: IStartEvalTraceProps,
  work: (trace: IObservationHandle) => Promise<T>,
): Promise<T> {
  if (!enabled) return work(NOOP_HANDLE);

  const tags = props.dryRun ? [...props.tags, 'dry-run'] : props.tags;

  return propagateAttributes(
    {
      sessionId: props.sessionId,
      tags,
    },
    async (): Promise<T> => {
      return startActiveObservation('eval-run', async (observation): Promise<T> => {
        observation.update({
          input: props.config,
          environment: 'eval',
          ...({ sessionId: props.sessionId, tags } as Record<string, unknown>),
        });
        const handle: IObservationHandle = {
          update: (data: Record<string, unknown>) => observation.update(data),
          end: () => observation.end(),
        };
        return work(handle);
      });
    },
  );
}
```

- [ ] **Step 4: Implement `runEvalQuerySpan`**

Add directly after `runEvalTrace`:

```typescript
export interface IStartEvalQuerySpanProps {
  query: string;
  goldenId: number;
  tags: string[];
  expectedDocs: number[];
}

/**
 * Run a single eval query inside a child span of the eval trace.
 *
 * Wraps the searchHybrid call + scoring for one golden dataset query.
 * The search trace (runSearchTrace) fires inside this span and auto-nests.
 *
 * When observability is disabled, `work` runs with a no-op handle.
 */
export async function runEvalQuerySpan<T>(
  props: IStartEvalQuerySpanProps,
  work: (span: IObservationHandle) => Promise<T>,
): Promise<T> {
  if (!enabled) return work(NOOP_HANDLE);

  return startActiveObservation('eval-query', async (observation): Promise<T> => {
    observation.update({
      input: {
        query: props.query,
        goldenId: props.goldenId,
        tags: props.tags,
        expectedDocs: props.expectedDocs,
      },
    });
    const handle: IObservationHandle = {
      update: (data: Record<string, unknown>) => observation.update(data),
      end: () => observation.end(),
    };
    return work(handle);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/repos/ledger && npx vitest run tests/observability.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: 231+ tests PASS

- [ ] **Step 7: Commit**

```bash
cd ~/repos/ledger
git add src/lib/observability.ts tests/observability.test.ts
git commit -m "feat(observability): add runEvalTrace and runEvalQuerySpan helpers"
```

---

### Task 3: Instrument eval command with trace helpers

Wrap the eval pipeline in `runEvalTrace` and each query in `runEvalQuerySpan`.

**Files:**
- Modify: `src/commands/eval.ts`

- [ ] **Step 1: Add imports**

At the top of `src/commands/eval.ts`, add the observability imports after the existing imports (line 8):

```typescript
import { runEvalTrace, runEvalQuerySpan, startSpan } from '../lib/observability.js';
```

- [ ] **Step 2: Wrap the eval loop in `runEvalTrace`**

Replace the body of `evalSearch` from the results array declaration (line 69) through the end of the function (line 137) with the traced version. The key structure:

```typescript
  await runEvalTrace({
    sessionId: clients.sessionId!,
    tags: ['eval', 'run'],
    config: CURRENT_SEARCH_CONFIG as unknown as Record<string, unknown>,
    dryRun: options.dryRun,
  }, async (evalTrace) => {

    const results: ITestResultProps[] = [];

    for (const testCase of testCases as IGoldenTestCaseProps[]) {
      const scored = await runEvalQuerySpan({
        query: testCase.query,
        goldenId: testCase.id,
        tags: testCase.tags,
        expectedDocs: testCase.judgments
          .filter(j => j.grade >= 2)
          .map(j => j.document_id),
      }, async (querySpan) => {
        const startTime = Date.now();
        const searchResults = await searchHybrid(clients, {
          query: testCase.query,
          limit: CURRENT_SEARCH_CONFIG.limit as number,
          reranker: CURRENT_SEARCH_CONFIG.reranker as 'none' | 'cohere',
        });
        const result = scoreTestCase(testCase, searchResults, Date.now() - startTime);
        querySpan.update({
          output: {
            hit: result.hit,
            firstResultHit: result.firstResultHit,
            position: result.position,
            reciprocalRank: result.reciprocalRank,
            normalizedDiscountedCumulativeGain: result.normalizedDiscountedCumulativeGain,
            responseTimeMs: Date.now() - startTime,
          },
        });
        return result;
      });

      results.push(scored);

      const isOutOfScope = !testCase.judgments.some(judgment => judgment.grade >= 2);
      if (isOutOfScope) {
        const status = scored.hit ? 'PASS' : `NOISE (${scored.returnedIds.length} results)`;
        console.log(`  [${status}] "${testCase.query}" (out-of-scope)`);
      } else {
        const status = scored.firstResultHit ? 'TOP' : scored.hit ? 'HIT' : 'MISS';
        const positionInfo = scored.position !== null ? `@${scored.position + 1}` : '';
        console.log(`  [${status}${positionInfo}] "${testCase.query}" → found ${scored.expectedFound}/${scored.expectedTotal}`);
      }
    }

    const metrics = computeMetrics(results);
    console.log('\n' + formatReport(metrics));

    // Advanced analysis
    const confidenceIntervals = computeConfidenceIntervals(results);
    const scoreCalibration = computeScoreCalibration(results);
    const coverageAnalysis = computeCoverageAnalysis(results);

    // Eval analysis span
    const analysisSpan = startSpan('eval-analysis');
    analysisSpan.update({
      input: {
        testCaseCount: results.length,
        normalCount: metrics.normalCases,
        outOfScopeCount: metrics.outOfScopeCases,
      },
    });

    if (!options.dryRun) {
      const runId = await saveEvalRun(clients.supabase, {
        metrics,
        config: CURRENT_SEARCH_CONFIG,
        results,
        confidenceIntervals,
        scoreCalibration,
        coverageAnalysis,
      });
      process.stderr.write(`\nRun saved to eval_runs (id: ${runId})\n`);
    }

    let comparisonSeverity = 'ok';
    if (previousRun) {
      const comparison = compareRuns(
        {
          hitRate:                              metrics.hitRate,
          firstResultAccuracy:                 metrics.firstResultAccuracy,
          recall:                              metrics.recall,
          zeroResultRate:                      metrics.zeroResultRate,
          meanReciprocalRank:                  metrics.meanReciprocalRank,
          normalizedDiscountedCumulativeGain:  metrics.normalizedDiscountedCumulativeGain,
          avgResponseTimeMs:                   metrics.avgResponseTimeMs,
        },
        {
          hitRate:                              previousRun.hit_rate,
          firstResultAccuracy:                 previousRun.first_result_accuracy,
          recall:                              previousRun.recall,
          zeroResultRate:                      previousRun.zero_result_rate,
          meanReciprocalRank:                  previousRun.mean_reciprocal_rank ?? 0,
          normalizedDiscountedCumulativeGain:  previousRun.normalized_discounted_cumulative_gain ?? 0,
          avgResponseTimeMs:                   previousRun.avg_response_time_ms,
        },
      );
      console.log('\n' + formatComparison(comparison));
      comparisonSeverity = comparison.severity;
    }

    analysisSpan.update({
      output: { metrics, comparisonSeverity },
    });
    analysisSpan.end();

    evalTrace.update({
      output: {
        hitRate: metrics.hitRate,
        firstResultAccuracy: metrics.firstResultAccuracy,
        recall: metrics.recall,
        meanReciprocalRank: metrics.meanReciprocalRank,
        normalizedDiscountedCumulativeGain: metrics.normalizedDiscountedCumulativeGain,
        comparisonSeverity,
      },
    });

    console.log('\n' + formatAdvancedReport(confidenceIntervals, scoreCalibration, coverageAnalysis));
  });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd ~/repos/ledger && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: 231+ tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/commands/eval.ts
git commit -m "feat(eval): instrument eval runner with Langfuse trace and per-query spans"
```

---

### Task 4: Instrument reranker internals

Add `rerank.prepare`, `rerank.queue-wait`, and `rerank.api-call` child spans inside `rerankResults`.

**Files:**
- Modify: `src/lib/search/reranker.ts`
- Create: `tests/reranker.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/reranker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('reranker module', () => {
  it('exports rerankResults function', async () => {
    const module = await import('../src/lib/search/reranker.js');
    expect(typeof module.rerankResults).toBe('function');
  });

  it('returns empty array for empty input', async () => {
    const { rerankResults } = await import('../src/lib/search/reranker.js');
    const result = await rerankResults('test query', [], { apiKey: 'fake-key' });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (baseline)**

Run: `cd ~/repos/ledger && npx vitest run tests/reranker.test.ts`
Expected: PASS (confirms module loads and empty-input path works)

- [ ] **Step 3: Add spans to `rerankResults`**

In `src/lib/search/reranker.ts`, add the import at the top (after existing imports):

```typescript
import { startSpan } from '../observability.js';
```

Replace the body of `rerankResults` (lines 65-123) with the instrumented version:

```typescript
export async function rerankResults(
  query: string,
  searchResults: ISearchResultProps[],
  options: IRerankOptionsProps,
): Promise<ISearchResultProps[]> {
  if (searchResults.length === 0) return [];

  const topN = options.topN ?? searchResults.length;
  const model = options.model ?? COHERE_RERANK_MODEL;

  // --- rerank.prepare ---
  const prepareSpan = startSpan('rerank.prepare');
  const documents = searchResults.map(searchResult => ({
    text: searchResult.content,
  }));
  const totalContentLength = documents.reduce((sum, doc) => sum + doc.text.length, 0);
  prepareSpan.update({ output: { documentCount: documents.length, totalContentLength } });
  prepareSpan.end();

  // --- rerank.queue-wait + rerank.api-call ---
  const queueSpan = startSpan('rerank.queue-wait');
  let response: Response;
  try {
    response = await cohereLimiter.schedule(() => {
      queueSpan.end();

      const apiSpan = startSpan('rerank.api-call');
      apiSpan.update({ input: { model, topN, documentCount: documents.length } });
      const apiStartMs = Date.now();

      return fetch(COHERE_RERANK_URL, {
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
      }).then(res => {
        apiSpan.update({
          output: {
            statusCode: res.status,
            latencyMs: Date.now() - apiStartMs,
          },
        });
        apiSpan.end();
        return res;
      }).catch(fetchError => {
        apiSpan.update({
          output: {
            error: (fetchError as Error).message,
            errorType: 'network',
            latencyMs: Date.now() - apiStartMs,
          },
        });
        apiSpan.end();
        throw fetchError;
      });
    });
  } catch (_networkError) {
    return searchResults;
  }

  if (!response.ok) {
    return searchResults;
  }

  let cohereResponse: ICohereRerankResponse;
  try {
    cohereResponse = (await response.json()) as ICohereRerankResponse;
  } catch (_parseError) {
    return searchResults;
  }

  if (!cohereResponse.results || !Array.isArray(cohereResponse.results)) {
    return searchResults;
  }

  const rerankedResults: ISearchResultProps[] = cohereResponse.results.map(
    (cohereResult) => ({
      ...searchResults[cohereResult.index],
      score: cohereResult.relevance_score,
    }),
  );

  return rerankedResults;
}
```

- [ ] **Step 4: Run tests to verify everything passes**

Run: `cd ~/repos/ledger && npx vitest run tests/reranker.test.ts`
Expected: PASS

Run: `cd ~/repos/ledger && npx vitest run`
Expected: 231+ tests PASS (plus 2 new reranker tests)

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd ~/repos/ledger && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd ~/repos/ledger
git add src/lib/search/reranker.ts tests/reranker.test.ts
git commit -m "feat(reranker): add internal spans for prepare, queue-wait, api-call"
```

---

### Task 5: Activate rerank span context for child nesting

Replace the passive `startSpan('rerank')` in `ai-search.ts` with `withActiveSpan` so the reranker's internal spans nest correctly.

**Files:**
- Modify: `src/lib/search/ai-search.ts`

- [ ] **Step 1: Update import**

In `src/lib/search/ai-search.ts` (line 15), add `withActiveSpan` to the import:

```typescript
import { runSearchTrace, startSpan, recordChildSpan, withActiveSpan } from '../observability.js';
```

- [ ] **Step 2: Replace the rerank block**

Replace lines 464-473 of `src/lib/search/ai-search.ts`:

```typescript
  if (useReranker && results.length > 0) {
    const rerankSpan = startSpan('rerank');
    const inputCount = results.length;
    results = await rerankResults(props.query, results, {
      apiKey: clients.cohereApiKey!,
      topN: desiredLimit,
    });
    rerankSpan.update({ output: { inputCount, outputCount: results.length } });
    rerankSpan.end();
  }
```

With:

```typescript
  if (useReranker && results.length > 0) {
    const rerankSpan = startSpan('rerank');
    const inputCount = results.length;
    results = await withActiveSpan(rerankSpan, async () => {
      return rerankResults(props.query, results, {
        apiKey: clients.cohereApiKey!,
        topN: desiredLimit,
      });
    });
    rerankSpan.update({ output: { inputCount, outputCount: results.length } });
    rerankSpan.end();
  }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd ~/repos/ledger && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/repos/ledger
git add src/lib/search/ai-search.ts
git commit -m "feat(search): activate rerank span context for child span nesting"
```

---

### Task 6: TypeScript build + compile verification

Verify the full build compiles and the MCP server can load with the new code.

**Files:**
- No changes (verification only)

- [ ] **Step 1: Full TypeScript compile**

Run: `cd ~/repos/ledger && npx tsc`
Expected: Clean compile, no errors. `dist/` directory updated.

- [ ] **Step 2: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: All tests PASS (233+ total: 231 original + 2 reranker + new observability tests)

- [ ] **Step 3: Verify MCP server loads**

Run: `cd ~/repos/ledger && node dist/mcp-server.js --help 2>&1 || echo "MCP server loaded (exits normally with no stdio)"` 

The MCP server expects stdio transport, so it won't run interactively, but it should load without import errors.

- [ ] **Step 4: Commit build output if dist/ is tracked**

Check: `cd ~/repos/ledger && git status dist/`
If dist/ is tracked, commit. If gitignored, skip.

---

### Task 7: Run eval baseline (run 15) and verify traces

Execute the eval runner with tracing and verify the complete trace tree in Langfuse.

**Files:**
- No code changes (execution + verification)

- [ ] **Step 1: Run eval (saved, not dry-run)**

Run: `cd ~/repos/ledger && npx tsx src/cli.ts eval`
Expected: 
- 144 test cases loaded and executed
- Metrics printed
- Comparison against run 14 printed
- Advanced stats (CI, calibration, coverage) printed
- "Run saved to eval_runs (id: 15)" (or next available ID)

- [ ] **Step 2: Wait for Langfuse flush, then verify root trace**

Run:
```bash
cd ~/repos/ledger && source .env && sleep 5 && \
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/traces?limit=3&orderBy=timestamp.desc" | \
  jq '.data[] | select(.name == "eval-run") | {name, sessionId, tags, output: (.output // {} | keys)}'
```

Expected: One `eval-run` trace with `sessionId: "eval-..."`, `tags: ["eval", "run"]`, output keys including `hitRate`, `comparisonSeverity`.

- [ ] **Step 3: Verify per-query child spans**

Get the eval-run trace ID from Step 2, then:

```bash
cd ~/repos/ledger && source .env && \
TRACE_ID="<paste trace id>" && \
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "$LANGFUSE_BASE_URL/api/public/observations?traceId=$TRACE_ID&limit=200" | \
  jq '[.data[] | .name] | group_by(.) | map({name: .[0], count: length}) | sort_by(-.count)'
```

Expected: ~144 `eval-query` spans, each with nested `search` spans, plus `semantic-cache-lookup`, `retrieve`, `OpenAI.embeddings`, and `eval-analysis`.

- [ ] **Step 4: Pull historical trend**

Run:
```bash
cd ~/repos/ledger && npx tsx -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sb.from('eval_runs')
  .select('id, run_date, test_case_count, hit_rate, first_result_accuracy, recall, mean_reciprocal_rank, normalized_discounted_cumulative_gain, avg_response_time_ms')
  .order('id')
  .then(({ data }) => {
    console.log('Run | Date       | Cases | Hit%   | First% | Recall | MRR    | NDCG   | Avg ms');
    console.log('----|------------|-------|--------|--------|--------|--------|--------|-------');
    for (const r of data) {
      const d = new Date(r.run_date).toISOString().slice(0, 10);
      console.log(
        String(r.id).padStart(3) + ' | ' +
        d + ' | ' +
        String(r.test_case_count).padStart(5) + ' | ' +
        r.hit_rate.toFixed(1).padStart(5) + '% | ' +
        r.first_result_accuracy.toFixed(1).padStart(5) + '% | ' +
        r.recall.toFixed(1).padStart(5) + '% | ' +
        (r.mean_reciprocal_rank ?? 0).toFixed(3).padStart(6) + ' | ' +
        (r.normalized_discounted_cumulative_gain ?? 0).toFixed(3).padStart(6) + ' | ' +
        r.avg_response_time_ms.toFixed(0).padStart(5)
      );
    }
  });
"
```

Expected: A table showing runs 7, 11, 13, 14, 15 with metric progression.

- [ ] **Step 5: Record results**

Note the run 15 metrics, comparison against run 14, and any regressions. This is the new baseline with Phase 2 nesting fix + eval tracing live.
