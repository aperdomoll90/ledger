# Eval Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ledger's search evaluation production-grade — persist runs, auto-compare, detect regressions, add MRR metric — so the Phase 4.5 tuning work has a safety net.

**Architecture:** The eval system has three layers: pure computation (`src/lib/eval/eval.ts` — types, scoring, metrics, formatting), database persistence (`src/lib/eval/eval-store.ts` — save/load eval runs via Supabase), and orchestration (`src/scripts/eval-search.ts` — thin runner that wires everything together). All new database operations use the existing `eval_runs` table (already created in Supabase). No new tables.

**Tech Stack:** TypeScript (strict), Supabase (Postgres), Vitest

---

## File Map

| File                              | Action | Responsibility                                    |
|-----------------------------------|--------|---------------------------------------------------|
| `src/lib/eval/eval.ts`            | Modify | Add MRR metric to scoring + metrics + formatting  |
| `src/lib/eval/eval-store.ts`      | Create | Save eval runs to DB, load previous run, compare  |
| `src/scripts/eval-search.ts`      | Modify | Wire persistence + comparison into runner          |
| `tests/eval.test.ts`              | Create | Unit tests for scoring, metrics, MRR, comparison  |
| `tests/eval-store.test.ts`        | Create | Unit tests for persistence layer (mocked Supabase) |

---

## Task 1: Add MRR metric to eval computation

MRR (Mean Reciprocal Rank) captures *where* the right doc appears, not just *whether*. A system with 90% hit rate but MRR of 0.3 means the right doc is usually 3rd — agents pick the wrong one.

**Files:**
- Modify: `src/lib/eval/eval.ts`
- Create: `tests/eval.test.ts`

- [ ] **Step 1: Write failing tests for `scoreTestCase`**

```typescript
// tests/eval.test.ts
import { describe, it, expect } from 'vitest';
import { scoreTestCase, computeMetrics, formatReport } from '../src/lib/eval/eval.js';
import type { ISearchResultProps } from '../src/lib/search/ai-search.js';

function makeResult(id: number, score: number): ISearchResultProps {
  return {
    id, content: '', name: `doc-${id}`, domain: 'general',
    document_type: 'knowledge', project: null, protection: 'open',
    description: null, agent: null, status: null, file_path: null,
    skill_ref: null, owner_type: 'user', owner_id: null,
    is_auto_load: false, content_hash: null, score,
  };
}

describe('scoreTestCase', () => {
  it('scores a hit at position 0 with reciprocal rank 1.0', () => {
    const result = scoreTestCase(
      { id: 1, query: 'test', expected_doc_ids: [10], tags: ['simple'] },
      [makeResult(10, 0.9), makeResult(20, 0.5)],
      100,
    );
    expect(result.hit).toBe(true);
    expect(result.firstResultHit).toBe(true);
    expect(result.position).toBe(0);
    expect(result.reciprocalRank).toBe(1.0);
  });

  it('scores a hit at position 2 with reciprocal rank 1/3', () => {
    const result = scoreTestCase(
      { id: 2, query: 'test', expected_doc_ids: [30], tags: ['simple'] },
      [makeResult(10, 0.9), makeResult(20, 0.8), makeResult(30, 0.7)],
      100,
    );
    expect(result.hit).toBe(true);
    expect(result.firstResultHit).toBe(false);
    expect(result.position).toBe(2);
    expect(result.reciprocalRank).toBeCloseTo(1 / 3);
  });

  it('scores a miss with reciprocal rank 0', () => {
    const result = scoreTestCase(
      { id: 3, query: 'test', expected_doc_ids: [99], tags: ['simple'] },
      [makeResult(10, 0.9)],
      100,
    );
    expect(result.hit).toBe(false);
    expect(result.reciprocalRank).toBe(0);
  });

  it('scores out-of-scope with no results as hit', () => {
    const result = scoreTestCase(
      { id: 4, query: 'nonsense', expected_doc_ids: [], tags: ['out-of-scope'] },
      [],
      50,
    );
    expect(result.hit).toBe(true);
    expect(result.reciprocalRank).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: FAIL — `reciprocalRank` does not exist on `ITestResultProps`

- [ ] **Step 3: Add `reciprocalRank` to `ITestResultProps` and `scoreTestCase`**

In `src/lib/eval/eval.ts`, add `reciprocalRank` to the interface:

```typescript
export interface ITestResultProps {
  testCase: IGoldenTestCaseProps;
  returnedIds: number[];
  returnedScores: number[];
  hit: boolean;
  firstResultHit: boolean;
  expectedFound: number;
  expectedTotal: number;
  position: number | null;
  reciprocalRank: number;    // ← ADD: 1/(position+1) or 0 if not found
  responseTimeMs: number;
}
```

In the `scoreTestCase` function, compute `reciprocalRank` for both branches:

Out-of-scope branch — add `reciprocalRank: 0` to the return object.

Normal branch — add after `firstExpectedPosition` is computed:

```typescript
const reciprocalRank = firstExpectedPosition !== null ? 1 / (firstExpectedPosition + 1) : 0;
```

And add `reciprocalRank` to the return object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write failing tests for `computeMetrics` with MRR**

Add to `tests/eval.test.ts`:

```typescript
describe('computeMetrics', () => {
  it('computes MRR across multiple results', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [10], tags: ['simple'] },
        [makeResult(10, 0.9)], 100,
      ),
      scoreTestCase(
        { id: 2, query: 'q2', expected_doc_ids: [20], tags: ['simple'] },
        [makeResult(5, 0.9), makeResult(20, 0.5)], 100,
      ),
      scoreTestCase(
        { id: 3, query: 'q3', expected_doc_ids: [30], tags: ['simple'] },
        [makeResult(5, 0.9)], 100,
      ),
    ];
    const metrics = computeMetrics(results);
    // MRR = (1/1 + 1/2 + 0) / 3 = 1.5/3 = 0.5
    expect(metrics.mrr).toBeCloseTo(0.5);
  });

  it('excludes out-of-scope from MRR', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [10], tags: ['simple'] },
        [makeResult(10, 0.9)], 100,
      ),
      scoreTestCase(
        { id: 2, query: 'oos', expected_doc_ids: [], tags: ['out-of-scope'] },
        [], 50,
      ),
    ];
    const metrics = computeMetrics(results);
    // MRR = 1/1 / 1 = 1.0 (out-of-scope excluded)
    expect(metrics.mrr).toBe(1.0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: FAIL — `mrr` does not exist on `IEvalMetricsProps`

- [ ] **Step 7: Add MRR to `IEvalMetricsProps` and `computeMetrics`**

In `src/lib/eval/eval.ts`, add `mrr` to the interface:

```typescript
export interface IEvalMetricsProps {
  // ... existing fields ...
  mrr: number;               // ← ADD: Mean Reciprocal Rank
  tagStats: Record<string, { total: number; hits: number; firstHits: number }>;
  missed: ITestResultProps[];
}
```

In `computeMetrics`, compute MRR from normal results:

```typescript
const mrrSum = normalResults.reduce((sum, r) => sum + r.reciprocalRank, 0);
```

Add to the return object:

```typescript
mrr: totalNormal > 0 ? mrrSum / totalNormal : 0,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 9: Add MRR to `formatReport`**

In the `formatReport` function, add after the `Avg response time` line:

```typescript
lines.push(`  MRR:                   ${metrics.mrr.toFixed(3)} (1.0 = perfect ranking, 0.5 = avg position 2)`);
```

- [ ] **Step 10: Write test for `formatReport` including MRR**

Add to `tests/eval.test.ts`:

```typescript
describe('formatReport', () => {
  it('includes MRR in output', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [10], tags: ['simple'] },
        [makeResult(10, 0.9)], 100,
      ),
    ];
    const metrics = computeMetrics(results);
    const report = formatReport(metrics);
    expect(report).toContain('MRR:');
    expect(report).toContain('1.000');
  });
});
```

- [ ] **Step 11: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: ALL PASS (existing 95 + new eval tests)

- [ ] **Step 12: Commit**

```bash
git add src/lib/eval/eval.ts tests/eval.test.ts
git commit -m "feat(eval): add MRR metric to scoring, metrics, and report"
```

---

## Task 2: Create eval persistence layer

Save eval runs to the `eval_runs` table so we can track improvement over time. The table already exists in Supabase with this schema:

```sql
CREATE TABLE eval_runs (
  id                    bigserial    PRIMARY KEY,
  run_date              timestamptz  NOT NULL DEFAULT now(),
  config                jsonb        NOT NULL,
  test_case_count       int          NOT NULL,
  hit_rate              float        NOT NULL,
  first_result_accuracy float        NOT NULL,
  recall                float        NOT NULL,
  zero_result_rate      float        NOT NULL,
  avg_response_time_ms  float        NOT NULL,
  results_by_tag        jsonb,
  missed_queries        jsonb,
  per_query_results     jsonb
);
```

**Files:**
- Create: `src/lib/eval/eval-store.ts`
- Create: `tests/eval-store.test.ts`

- [ ] **Step 1: Write failing tests for `saveEvalRun`**

```typescript
// tests/eval-store.test.ts
import { describe, it, expect, vi } from 'vitest';
import { saveEvalRun, loadPreviousRun } from '../src/lib/eval/eval-store.js';
import type { IEvalMetricsProps, ITestResultProps } from '../src/lib/eval/eval.js';

function createMockSupabase(resolveWith: { data: any; error: any }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(resolveWith),
    then: vi.fn((resolve: any) => resolve(resolveWith)),
  };
  return { from: vi.fn().mockReturnValue(chain), rpc: vi.fn(), _chain: chain } as any;
}

function makeMetrics(overrides: Partial<IEvalMetricsProps> = {}): IEvalMetricsProps {
  return {
    totalCases: 10, normalCases: 8, outOfScopeCases: 2,
    hits: 7, firstResultHits: 4, totalExpected: 12, totalFound: 9,
    zeroResults: 0, outOfScopeCorrect: 1, avgResponseTimeMs: 500,
    hitRate: 87.5, firstResultAccuracy: 50.0, recall: 75.0,
    zeroResultRate: 0, outOfScopeAccuracy: 50.0, mrr: 0.65,
    tagStats: { simple: { total: 5, hits: 4, firstHits: 3 } },
    missed: [],
    ...overrides,
  };
}

describe('saveEvalRun', () => {
  it('inserts a row into eval_runs with metrics and config', async () => {
    const supabase = createMockSupabase({ data: { id: 1 }, error: null });
    const metrics = makeMetrics();
    const config = { threshold: 0.25, rrf_k: 60, embedding_model: 'openai/text-embedding-3-small' };

    const id = await saveEvalRun(supabase, { metrics, config, results: [] });

    expect(supabase.from).toHaveBeenCalledWith('eval_runs');
    expect(supabase._chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        hit_rate: 87.5,
        first_result_accuracy: 50.0,
        recall: 75.0,
        zero_result_rate: 0,
        avg_response_time_ms: 500,
        test_case_count: 10,
        config: expect.objectContaining({ threshold: 0.25 }),
      }),
    );
    expect(id).toBe(1);
  });

  it('throws on database error', async () => {
    const supabase = createMockSupabase({ data: null, error: { message: 'insert failed' } });
    const metrics = makeMetrics();

    await expect(saveEvalRun(supabase, { metrics, config: {}, results: [] }))
      .rejects.toThrow('Failed to save eval run: insert failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-store.test.ts`
Expected: FAIL — module `eval-store.js` does not exist

- [ ] **Step 3: Implement `saveEvalRun`**

```typescript
// src/lib/eval/eval-store.ts
// Persistence layer for eval runs — save to and load from eval_runs table.

import type { ISupabaseClientProps } from '../documents/classification.js';
import type { IEvalMetricsProps, ITestResultProps } from './eval.js';

export interface IEvalConfigProps {
  threshold: number;
  rrf_k: number;
  embedding_model: string;
  [key: string]: unknown;
}

export interface ISaveEvalRunProps {
  metrics: IEvalMetricsProps;
  config: IEvalConfigProps | Record<string, unknown>;
  results: ITestResultProps[];
}

export interface IEvalRunRowProps {
  id: number;
  run_date: string;
  config: Record<string, unknown>;
  test_case_count: number;
  hit_rate: number;
  first_result_accuracy: number;
  recall: number;
  zero_result_rate: number;
  avg_response_time_ms: number;
  results_by_tag: Record<string, unknown> | null;
  missed_queries: unknown[] | null;
  per_query_results: unknown[] | null;
}

export async function saveEvalRun(
  supabase: ISupabaseClientProps,
  props: ISaveEvalRunProps,
): Promise<number> {
  const { metrics, config, results } = props;

  const missedQueries = metrics.missed.map(m => ({
    query: m.testCase.query,
    expected: m.testCase.expected_doc_ids,
    got: m.returnedIds.slice(0, 5),
  }));

  const perQueryResults = results.map(r => ({
    query: r.testCase.query,
    tags: r.testCase.tags,
    expected: r.testCase.expected_doc_ids,
    returned: r.returnedIds,
    scores: r.returnedScores,
    hit: r.hit,
    firstResultHit: r.firstResultHit,
    position: r.position,
    reciprocalRank: r.reciprocalRank,
    responseTimeMs: r.responseTimeMs,
  }));

  const row = {
    config,
    test_case_count: metrics.totalCases,
    hit_rate: metrics.hitRate,
    first_result_accuracy: metrics.firstResultAccuracy,
    recall: metrics.recall,
    zero_result_rate: metrics.zeroResultRate,
    avg_response_time_ms: metrics.avgResponseTimeMs,
    results_by_tag: metrics.tagStats,
    missed_queries: missedQueries,
    per_query_results: perQueryResults,
  };

  const { data, error } = await supabase
    .from('eval_runs')
    .insert(row)
    .select('id')
    .single() as { data: { id: number } | null; error: { message: string } | null };

  if (error) throw new Error(`Failed to save eval run: ${error.message}`);
  return data!.id;
}
```

Note: The mock Supabase chain needs `.select()` added. Update the mock in the test:

```typescript
function createMockSupabase(resolveWith: { data: any; error: any }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(resolveWith),
    then: vi.fn((resolve: any) => resolve(resolveWith)),
  };
  return { from: vi.fn().mockReturnValue(chain), rpc: vi.fn(), _chain: chain } as any;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-store.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Write failing tests for `loadPreviousRun`**

Add to `tests/eval-store.test.ts`:

```typescript
describe('loadPreviousRun', () => {
  it('returns the most recent eval run', async () => {
    const row: IEvalRunRowProps = {
      id: 5, run_date: '2026-04-01T00:00:00Z',
      config: { threshold: 0.25 }, test_case_count: 56,
      hit_rate: 88.5, first_result_accuracy: 46.2, recall: 73.7,
      zero_result_rate: 0, avg_response_time_ms: 958,
      results_by_tag: null, missed_queries: null, per_query_results: null,
    };
    const supabase = createMockSupabase({ data: row, error: null });

    const prev = await loadPreviousRun(supabase);

    expect(prev).not.toBeNull();
    expect(prev!.id).toBe(5);
    expect(prev!.hit_rate).toBe(88.5);
    expect(supabase._chain.order).toHaveBeenCalledWith('run_date', { ascending: false });
    expect(supabase._chain.limit).toHaveBeenCalledWith(1);
  });

  it('returns null when no previous runs exist', async () => {
    const supabase = createMockSupabase({ data: null, error: null });

    const prev = await loadPreviousRun(supabase);

    expect(prev).toBeNull();
  });
});
```

Import `IEvalRunRowProps` from `eval-store.js` at the top of the test file.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-store.test.ts`
Expected: FAIL — `loadPreviousRun` not exported

- [ ] **Step 7: Implement `loadPreviousRun`**

Add to `src/lib/eval/eval-store.ts`:

```typescript
export async function loadPreviousRun(
  supabase: ISupabaseClientProps,
): Promise<IEvalRunRowProps | null> {
  const { data, error } = await supabase
    .from('eval_runs')
    .select('*')
    .order('run_date', { ascending: false })
    .limit(1)
    .single() as { data: IEvalRunRowProps | null; error: { message: string } | null };

  if (error || !data) return null;
  return data;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-store.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add src/lib/eval/eval-store.ts tests/eval-store.test.ts
git commit -m "feat(eval): add persistence layer — save runs to eval_runs, load previous"
```

---

## Task 3: Auto-compare and regression detection

After each eval run, automatically compare against the previous run. Flag regressions using thresholds from the reference doc: warning at >2% drop, block at >5%.

**Files:**
- Modify: `src/lib/eval/eval.ts`
- Modify: `tests/eval.test.ts`

- [ ] **Step 1: Write failing tests for `compareRuns`**

Add to `tests/eval.test.ts`:

```typescript
import { scoreTestCase, computeMetrics, formatReport, compareRuns } from '../src/lib/eval/eval.js';
import type { IEvalComparisonProps } from '../src/lib/eval/eval.js';

describe('compareRuns', () => {
  it('reports all improved when metrics go up', () => {
    const comparison = compareRuns(
      { hitRate: 92, firstResultAccuracy: 55, recall: 80, zeroResultRate: 2, mrr: 0.7, avgResponseTimeMs: 400 },
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 4, mrr: 0.6, avgResponseTimeMs: 500 },
    );
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.improvements.length).toBeGreaterThan(0);
    expect(comparison.severity).toBe('ok');
  });

  it('flags warning when a metric drops > 2%', () => {
    const comparison = compareRuns(
      { hitRate: 85, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
    );
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0].metric).toBe('hitRate');
    expect(comparison.severity).toBe('warning');
  });

  it('flags block when a metric drops > 5%', () => {
    const comparison = compareRuns(
      { hitRate: 82, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
    );
    expect(comparison.severity).toBe('block');
  });

  it('flags critical when hit rate drops below 80%', () => {
    const comparison = compareRuns(
      { hitRate: 78, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
    );
    expect(comparison.severity).toBe('critical');
  });

  it('treats zero-result rate decrease as improvement', () => {
    const comparison = compareRuns(
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 1, mrr: 0.6, avgResponseTimeMs: 500 },
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 5, mrr: 0.6, avgResponseTimeMs: 500 },
    );
    // zeroResultRate going DOWN is good
    expect(comparison.regressions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: FAIL — `compareRuns` not exported

- [ ] **Step 3: Implement `compareRuns`**

Add to `src/lib/eval/eval.ts`:

```typescript
// =============================================================================
// Run comparison — compare current metrics against a previous run
// =============================================================================

export type ComparisonSeverity = 'ok' | 'warning' | 'block' | 'critical';

export interface IMetricDiffProps {
  metric: string;
  current: number;
  previous: number;
  diff: number;
}

export interface IEvalComparisonProps {
  improvements: IMetricDiffProps[];
  regressions: IMetricDiffProps[];
  unchanged: IMetricDiffProps[];
  severity: ComparisonSeverity;
}

interface IComparableMetricsProps {
  hitRate: number;
  firstResultAccuracy: number;
  recall: number;
  zeroResultRate: number;
  mrr: number;
  avgResponseTimeMs: number;
}

export function compareRuns(
  current: IComparableMetricsProps,
  previous: IComparableMetricsProps,
): IEvalComparisonProps {
  // For most metrics, higher is better. For zeroResultRate and avgResponseTimeMs, lower is better.
  const invertedMetrics = new Set(['zeroResultRate', 'avgResponseTimeMs']);

  const metrics: Array<{ key: keyof IComparableMetricsProps; label: string }> = [
    { key: 'hitRate', label: 'hitRate' },
    { key: 'firstResultAccuracy', label: 'firstResultAccuracy' },
    { key: 'recall', label: 'recall' },
    { key: 'zeroResultRate', label: 'zeroResultRate' },
    { key: 'mrr', label: 'mrr' },
    { key: 'avgResponseTimeMs', label: 'avgResponseTimeMs' },
  ];

  const improvements: IMetricDiffProps[] = [];
  const regressions: IMetricDiffProps[] = [];
  const unchanged: IMetricDiffProps[] = [];

  for (const { key, label } of metrics) {
    const diff = current[key] - previous[key];
    const entry: IMetricDiffProps = { metric: label, current: current[key], previous: previous[key], diff };

    if (Math.abs(diff) < 0.01) {
      unchanged.push(entry);
    } else {
      const isImprovement = invertedMetrics.has(key) ? diff < 0 : diff > 0;
      if (isImprovement) {
        improvements.push(entry);
      } else {
        regressions.push(entry);
      }
    }
  }

  // Determine severity
  let severity: ComparisonSeverity = 'ok';

  if (current.hitRate < 80 || current.zeroResultRate > 10) {
    severity = 'critical';
  } else {
    const maxDropPct = Math.max(
      ...regressions
        .filter(r => !invertedMetrics.has(r.metric))
        .map(r => r.previous > 0 ? Math.abs(r.diff) : 0),
      0,
    );
    const maxInvertedRisePct = Math.max(
      ...regressions
        .filter(r => invertedMetrics.has(r.metric))
        .map(r => Math.abs(r.diff)),
      0,
    );
    const worstDrop = Math.max(maxDropPct, maxInvertedRisePct);

    if (worstDrop > 5) severity = 'block';
    else if (worstDrop > 2) severity = 'warning';
  }

  return { improvements, regressions, unchanged, severity };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: PASS (all eval tests)

- [ ] **Step 5: Write failing test for `formatComparison`**

Add to `tests/eval.test.ts`:

```typescript
import { compareRuns, formatComparison } from '../src/lib/eval/eval.js';

describe('formatComparison', () => {
  it('formats improvements and regressions', () => {
    const comparison = compareRuns(
      { hitRate: 92, firstResultAccuracy: 42, recall: 80, zeroResultRate: 0, mrr: 0.7, avgResponseTimeMs: 400 },
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
    );
    const output = formatComparison(comparison);
    expect(output).toContain('hitRate');
    expect(output).toContain('+');
    expect(output).toContain('REGRESSION');
  });

  it('shows severity label', () => {
    const comparison = compareRuns(
      { hitRate: 78, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
      { hitRate: 88, firstResultAccuracy: 46, recall: 74, zeroResultRate: 0, mrr: 0.6, avgResponseTimeMs: 500 },
    );
    const output = formatComparison(comparison);
    expect(output).toContain('CRITICAL');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: FAIL — `formatComparison` not exported

- [ ] **Step 7: Implement `formatComparison`**

Add to `src/lib/eval/eval.ts`:

```typescript
export function formatComparison(comparison: IEvalComparisonProps): string {
  const lines: string[] = [];
  const severityLabels: Record<ComparisonSeverity, string> = {
    ok: 'ALL STABLE OR IMPROVED',
    warning: 'WARNING — metric regression detected',
    block: 'BLOCK — metric dropped > 5%, do not deploy',
    critical: 'CRITICAL — hit rate below 80% or zero-result rate above 10%',
  };

  lines.push('='.repeat(60));
  lines.push(`Comparison: ${severityLabels[comparison.severity]}`);
  lines.push('='.repeat(60));
  lines.push('');

  if (comparison.improvements.length > 0) {
    lines.push('IMPROVEMENTS:');
    for (const imp of comparison.improvements) {
      const sign = imp.diff > 0 ? '+' : '';
      lines.push(`  ${imp.metric}: ${imp.previous.toFixed(1)} → ${imp.current.toFixed(1)} (${sign}${imp.diff.toFixed(1)})`);
    }
    lines.push('');
  }

  if (comparison.regressions.length > 0) {
    lines.push('REGRESSION:');
    for (const reg of comparison.regressions) {
      const sign = reg.diff > 0 ? '+' : '';
      lines.push(`  ${reg.metric}: ${reg.previous.toFixed(1)} → ${reg.current.toFixed(1)} (${sign}${reg.diff.toFixed(1)})`);
    }
    lines.push('');
  }

  if (comparison.unchanged.length > 0) {
    lines.push('UNCHANGED:');
    for (const unch of comparison.unchanged) {
      lines.push(`  ${unch.metric}: ${unch.current.toFixed(1)}`);
    }
    lines.push('');
  }

  lines.push('='.repeat(60));
  return lines.join('\n');
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: PASS (all eval tests)

- [ ] **Step 9: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: ALL PASS

- [ ] **Step 10: Commit**

```bash
git add src/lib/eval/eval.ts tests/eval.test.ts
git commit -m "feat(eval): add run comparison with regression detection"
```

---

## Task 4: Wire everything into the eval runner

Update `eval-search.ts` to: persist results, load previous run, compare, and print the diff.

**Files:**
- Modify: `src/scripts/eval-search.ts`

- [ ] **Step 1: Update eval-search.ts to persist and compare**

Replace the current `runEval` function in `src/scripts/eval-search.ts`:

```typescript
// eval-search.ts
// Run the golden dataset through search, compute metrics, print report.
//
// Run: npx tsx src/scripts/eval-search.ts
// This gives us a measurable score for search quality.
// Every future change gets compared against this baseline.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import type { IClientsProps } from '../lib/documents/classification.js';
import { searchHybrid } from '../lib/search/ai-search.js';
import { scoreTestCase, computeMetrics, formatReport, compareRuns, formatComparison } from '../lib/eval/eval.js';
import type { IGoldenTestCaseProps, ITestResultProps } from '../lib/eval/eval.js';
import { saveEvalRun, loadPreviousRun } from '../lib/eval/eval-store.js';

// =============================================================================
// Setup
// =============================================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey || !openaiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY');
  process.exit(1);
}

const clients: IClientsProps = {
  supabase: createClient(supabaseUrl, supabaseKey),
  openai: new OpenAI({ apiKey: openaiKey }),
};

// Current search config — snapshot saved with each run for reproducibility
const SEARCH_CONFIG = {
  threshold: 0.25,
  rrf_k: 60,
  embedding_model: 'openai/text-embedding-3-small',
  limit: 10,
  chunking: 'paragraph',
  reranker: 'none',
};

// =============================================================================
// Run eval
// =============================================================================

async function runEval(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Ledger Search Evaluation');
  console.log('='.repeat(60) + '\n');

  // Load previous run for comparison (before running new eval)
  const previousRun = await loadPreviousRun(clients.supabase);
  if (previousRun) {
    console.log(`Previous run: ${previousRun.run_date} (id: ${previousRun.id})\n`);
  } else {
    console.log('No previous run found — this will be the first stored run.\n');
  }

  // Load golden dataset
  const { data: testCases, error } = await clients.supabase
    .from('eval_golden_dataset')
    .select('id, query, expected_doc_ids, tags')
    .order('id');

  if (error || !testCases) {
    console.error('Failed to load golden dataset:', error?.message);
    process.exit(1);
  }

  console.log(`Loaded ${testCases.length} test cases.\n`);

  // Run each test case
  const results: ITestResultProps[] = [];

  for (const testCase of testCases as IGoldenTestCaseProps[]) {
    const startTime = Date.now();
    const searchResults = await searchHybrid(clients, { query: testCase.query, limit: SEARCH_CONFIG.limit });
    const result = scoreTestCase(testCase, searchResults, Date.now() - startTime);
    results.push(result);

    // Live progress
    const isOutOfScope = testCase.expected_doc_ids.length === 0;
    if (isOutOfScope) {
      const status = result.hit ? 'PASS' : `NOISE (${result.returnedIds.length} results)`;
      console.log(`  [${status}] "${testCase.query}" (out-of-scope)`);
    } else {
      const status = result.firstResultHit ? 'TOP' : result.hit ? 'HIT' : 'MISS';
      const positionInfo = result.position !== null ? `@${result.position + 1}` : '';
      console.log(`  [${status}${positionInfo}] "${testCase.query}" → found ${result.expectedFound}/${result.expectedTotal}`);
    }
  }

  // Compute and print metrics
  const metrics = computeMetrics(results);
  console.log('\n' + formatReport(metrics));

  // Save to eval_runs
  const runId = await saveEvalRun(clients.supabase, {
    metrics,
    config: SEARCH_CONFIG,
    results,
  });
  console.log(`\nRun saved to eval_runs (id: ${runId})`);

  // Compare against previous run
  if (previousRun) {
    const comparison = compareRuns(
      {
        hitRate: metrics.hitRate,
        firstResultAccuracy: metrics.firstResultAccuracy,
        recall: metrics.recall,
        zeroResultRate: metrics.zeroResultRate,
        mrr: metrics.mrr,
        avgResponseTimeMs: metrics.avgResponseTimeMs,
      },
      {
        hitRate: previousRun.hit_rate,
        firstResultAccuracy: previousRun.first_result_accuracy,
        recall: previousRun.recall,
        zeroResultRate: previousRun.zero_result_rate,
        mrr: 0, // Previous runs before MRR was added won't have it
        avgResponseTimeMs: previousRun.avg_response_time_ms,
      },
    );
    console.log('\n' + formatComparison(comparison));
  }
}

runEval().catch((error) => {
  console.error('Eval crashed:', error);
  process.exit(1);
});
```

- [ ] **Step 2: Type check**

Run: `cd ~/repos/ledger && npx tsc --noEmit`
Expected: Clean compile (0 errors)

- [ ] **Step 3: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/scripts/eval-search.ts
git commit -m "feat(eval): wire persistence and auto-compare into runner"
```

---

## Task 5: Verify against live database

Run the eval runner against the real Supabase database to confirm the `eval_runs` table accepts our data and the full pipeline works end-to-end.

**Files:** None modified — this is a verification step.

- [ ] **Step 1: Run the eval runner**

Run: `cd ~/repos/ledger && npx tsx src/scripts/eval-search.ts`

Expected output (structure, not exact numbers):
```
Ledger Search Evaluation
============================================================

No previous run found — this will be the first stored run.

Loaded 56 test cases.

  [TOP@1] "..." → found 1/1
  ...

============================================================
Results
============================================================

Test cases:          56 total (52 normal, 4 out-of-scope)

METRICS:
  Hit rate:              ~88%
  First-result accuracy: ~46%
  Recall:                ~73%
  Zero-result rate:      0.0%
  Out-of-scope accuracy: 0.0%
  Avg response time:     ~900ms
  MRR:                   ~0.xxx

Run saved to eval_runs (id: 1)
```

- [ ] **Step 2: Run it again to verify comparison works**

Run: `cd ~/repos/ledger && npx tsx src/scripts/eval-search.ts`

Expected: Same metrics report PLUS a comparison section showing all metrics unchanged (since nothing changed between runs).

- [ ] **Step 3: Verify data in eval_runs table**

Run: `cd ~/repos/ledger && npx tsx -e "
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { data } = await s.from('eval_runs').select('id, run_date, hit_rate, first_result_accuracy, recall').order('run_date', { ascending: false }).limit(3);
console.log(JSON.stringify(data, null, 2));
"`

Expected: Two rows with matching metrics.

- [ ] **Step 4: Commit (no code changes — just verification)**

No commit needed. If any step failed, fix the issue and commit the fix.

---

## Summary

| Task | What | New Tests | Depends On |
|------|------|-----------|------------|
| 1    | MRR metric in scoring + metrics + report | 7 tests | — |
| 2    | Persistence layer (save/load eval runs) | 4 tests | Task 1 (reciprocalRank field) |
| 3    | Auto-compare + regression detection | 7 tests | Task 1 (mrr field) |
| 4    | Wire into eval runner script | 0 (integration) | Tasks 1-3 |
| 5    | Live verification | 0 (manual) | Task 4 |

After this plan completes, the eval system supports:
- Storing every run with config snapshot, metrics, and per-query detail
- Automatic comparison against the previous run
- Regression detection with severity levels (ok / warning / block / critical)
- MRR as a ranking quality metric alongside hit rate and recall

This gives Phase 4.5 (tuning) a safety net: change threshold/chunking/reranker → run eval → see if it helped or hurt → decide to deploy or revert.
