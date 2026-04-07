# Advanced Eval Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add NDCG@k (Normalized Discounted Cumulative Gain), confidence intervals, score calibration, and golden set coverage analysis to Ledger's eval system — bringing it to production-grade measurement capability.

**Architecture:** New advanced metrics live in a separate file `src/lib/eval/eval-advanced.ts` to keep `eval.ts` focused on core scoring/comparison (~367 lines). The advanced metrics are pure functions that consume the same `ITestResultProps[]` and `IEvalMetricsProps` types. NDCG is computed per-query in `scoreTestCase` (added to `ITestResultProps`), then aggregated in `computeMetrics`. Confidence intervals, score calibration, and coverage analysis operate on the full results array and produce their own report sections.

**Tech Stack:** TypeScript (strict), Vitest, no external dependencies (all computation is built-in)

---

## File Map

| File                                | Action | Responsibility                                              |
|-------------------------------------|--------|-------------------------------------------------------------|
| `src/lib/eval/eval.ts`             | Modify | Add `ndcgAtK` to `ITestResultProps`, `ndcgAtK` to `IEvalMetricsProps`, compute in `scoreTestCase` + `computeMetrics`, add to `formatReport` |
| `src/lib/eval/eval-advanced.ts`    | Create | Confidence intervals, score calibration, coverage analysis   |
| `src/lib/eval/eval.ts`             | Modify | Add `ndcgAtK` to `IComparableMetricsProps` + `compareRuns`  |
| `src/scripts/eval-search.ts`       | Modify | Wire advanced report into eval runner output                 |
| `src/commands/eval.ts`             | Modify | Wire advanced report into CLI command output                 |
| `tests/eval.test.ts`              | Modify | NDCG tests                                                   |
| `tests/eval-advanced.test.ts`     | Create | Confidence intervals, calibration, coverage tests            |

---

## Task 1: Add NDCG@k to scoring and metrics

NDCG (Normalized Discounted Cumulative Gain) scores all positions in search results, not just the first hit. It answers: "are ALL relevant documents ranked near the top?"

The formula: for each returned result, compute `relevance / log2(position + 2)` (position is 0-indexed, so we add 2 to avoid log(1)=0). Sum those (DCG). Compute the ideal sum if relevant docs were perfectly ranked (IDCG). NDCG = DCG / IDCG.

With binary relevance (our current model), relevance is 1 if the doc is in `expected_doc_ids`, 0 otherwise.

**Files:**
- Modify: `src/lib/eval/eval.ts`
- Modify: `tests/eval.test.ts`

- [ ] **Step 1: Write failing tests for NDCG in `scoreTestCase`**

Add to `tests/eval.test.ts`:

```typescript
describe('scoreTestCase — ndcgAtK', () => {
  it('perfect ranking: all expected docs at top positions', () => {
    const result = scoreTestCase(
      { id: 1, query: 'test', expected_doc_ids: [10, 20], tags: ['multi-doc'] },
      [makeResult(10, 0.9), makeResult(20, 0.8), makeResult(30, 0.5)],
      100,
    );
    // DCG  = 1/log2(2) + 1/log2(3) = 1.0 + 0.6309 = 1.6309
    // IDCG = same (already perfect) = 1.6309
    // NDCG = 1.0
    expect(result.ndcgAtK).toBeCloseTo(1.0);
  });

  it('imperfect ranking: expected docs not at top', () => {
    const result = scoreTestCase(
      { id: 2, query: 'test', expected_doc_ids: [20, 30], tags: ['multi-doc'] },
      [makeResult(10, 0.9), makeResult(20, 0.8), makeResult(30, 0.7)],
      100,
    );
    // DCG  = 0/log2(2) + 1/log2(3) + 1/log2(4) = 0 + 0.6309 + 0.5 = 1.1309
    // IDCG = 1/log2(2) + 1/log2(3) = 1.0 + 0.6309 = 1.6309
    // NDCG = 1.1309 / 1.6309 ≈ 0.6934
    expect(result.ndcgAtK).toBeCloseTo(0.6934, 3);
  });

  it('no expected docs found: NDCG is 0', () => {
    const result = scoreTestCase(
      { id: 3, query: 'test', expected_doc_ids: [99], tags: ['simple'] },
      [makeResult(10, 0.9), makeResult(20, 0.8)],
      100,
    );
    expect(result.ndcgAtK).toBe(0);
  });

  it('out-of-scope: NDCG is 0', () => {
    const result = scoreTestCase(
      { id: 4, query: 'nonsense', expected_doc_ids: [], tags: ['out-of-scope'] },
      [],
      50,
    );
    expect(result.ndcgAtK).toBe(0);
  });

  it('single expected doc at position 0: NDCG is 1.0', () => {
    const result = scoreTestCase(
      { id: 5, query: 'test', expected_doc_ids: [10], tags: ['simple'] },
      [makeResult(10, 0.9)],
      100,
    );
    expect(result.ndcgAtK).toBeCloseTo(1.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: FAIL — `ndcgAtK` does not exist on `ITestResultProps`

- [ ] **Step 3: Add NDCG computation to `scoreTestCase` and types**

In `src/lib/eval/eval.ts`:

Add `ndcgAtK: number` to `ITestResultProps` interface (after `reciprocalRank`).

Add a helper function before `scoreTestCase`:

```typescript
function computeNdcgAtK(returnedIds: number[], expectedDocIds: number[]): number {
  if (expectedDocIds.length === 0) return 0;

  // DCG: sum of relevance / log2(position + 2) for each returned result
  // Binary relevance: 1 if doc is expected, 0 otherwise
  let discountedCumulativeGain = 0;
  for (let position = 0; position < returnedIds.length; position++) {
    const relevance = expectedDocIds.includes(returnedIds[position]) ? 1 : 0;
    discountedCumulativeGain += relevance / Math.log2(position + 2);
  }

  // IDCG: ideal DCG if all expected docs were ranked first
  let idealDiscountedCumulativeGain = 0;
  const idealCount = Math.min(expectedDocIds.length, returnedIds.length);
  for (let position = 0; position < idealCount; position++) {
    idealDiscountedCumulativeGain += 1 / Math.log2(position + 2);
  }

  if (idealDiscountedCumulativeGain === 0) return 0;
  return discountedCumulativeGain / idealDiscountedCumulativeGain;
}
```

In `scoreTestCase`, add to the out-of-scope return: `ndcgAtK: 0`

In the normal return: `ndcgAtK: computeNdcgAtK(returnedIds, testCase.expected_doc_ids)`

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing tests for NDCG in `computeMetrics`**

Add to `tests/eval.test.ts`:

```typescript
describe('computeMetrics — ndcgAtK', () => {
  it('averages NDCG across normal results', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [10], tags: ['simple'] },
        [makeResult(10, 0.9)], 100,
      ),
      scoreTestCase(
        { id: 2, query: 'q2', expected_doc_ids: [20], tags: ['simple'] },
        [makeResult(5, 0.9), makeResult(20, 0.5)], 100,
      ),
    ];
    const metrics = computeMetrics(results);
    // First: NDCG=1.0, Second: DCG=1/log2(3)=0.6309, IDCG=1/log2(2)=1.0, NDCG=0.6309
    // Average: (1.0 + 0.6309) / 2 = 0.8155
    expect(metrics.ndcgAtK).toBeCloseTo(0.8155, 3);
  });

  it('excludes out-of-scope from NDCG average', () => {
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
    expect(metrics.ndcgAtK).toBeCloseTo(1.0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: FAIL — `ndcgAtK` does not exist on `IEvalMetricsProps`

- [ ] **Step 7: Add NDCG to `IEvalMetricsProps` and `computeMetrics`**

Add `ndcgAtK: number` to `IEvalMetricsProps` (after `meanReciprocalRank`).

In `computeMetrics`, add to the return object:

```typescript
ndcgAtK: totalNormal > 0
  ? normalResults.reduce((sum, result) => sum + result.ndcgAtK, 0) / totalNormal
  : 0,
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval.test.ts`
Expected: PASS

- [ ] **Step 9: Add NDCG to `formatReport`**

In `formatReport`, add after the MRR line:

```typescript
lines.push(`  NDCG@k:                ${metrics.ndcgAtK.toFixed(3)} (1.0 = perfect ranking of all relevant docs)`);
```

- [ ] **Step 10: Add NDCG to `IComparableMetricsProps` and `compareRuns`**

Add `ndcgAtK: number` to `IComparableMetricsProps`.

Add `'ndcgAtK'` to the `metricKeys` array in `compareRuns`.

Update `formatMetricValue` to handle `ndcgAtK`:

```typescript
if (metricKey === 'meanReciprocalRank' || metricKey === 'ndcgAtK') return value.toFixed(3);
```

- [ ] **Step 11: Update eval runner and CLI to pass NDCG in comparisons**

In `src/scripts/eval-search.ts`, add `ndcgAtK` to both the current and previous metrics objects in the `compareRuns` call:

Current: `ndcgAtK: metrics.ndcgAtK,`
Previous: `ndcgAtK: 0, // Previous runs before NDCG was added won't have it`

Same change in `src/commands/eval.ts`.

- [ ] **Step 12: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: ALL PASS

- [ ] **Step 13: Commit**

```bash
git add src/lib/eval/eval.ts tests/eval.test.ts src/scripts/eval-search.ts src/commands/eval.ts
git commit -m "feat(eval): add NDCG@k metric — scores all positions, not just first hit"
```

---

## Task 2: Add confidence intervals via bootstrap resampling

Confidence intervals tell you whether a metric change is real or noise. With 56 test cases, a 2% swing might be random — the interval tells you "hit rate is 88.5% ± 4.2%", so anything within that range isn't a meaningful change.

Bootstrap resampling: resample the test results with replacement 1000 times, compute metrics on each resample, take the 2.5th and 97.5th percentiles as the 95% confidence interval.

**Files:**
- Create: `src/lib/eval/eval-advanced.ts`
- Create: `tests/eval-advanced.test.ts`

- [ ] **Step 1: Write failing tests for confidence intervals**

```typescript
// tests/eval-advanced.test.ts
import { describe, it, expect } from 'vitest';
import { computeConfidenceIntervals } from '../src/lib/eval/eval-advanced.js';
import { scoreTestCase } from '../src/lib/eval/eval.js';
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

describe('computeConfidenceIntervals', () => {
  it('returns intervals for all metrics', () => {
    const results = Array.from({ length: 20 }, (_, index) =>
      scoreTestCase(
        { id: index, query: `q${index}`, expected_doc_ids: [index * 10], tags: ['simple'] },
        index % 4 === 0
          ? [makeResult(99, 0.5)]  // miss every 4th query
          : [makeResult(index * 10, 0.9)],
        100,
      ),
    );

    const intervals = computeConfidenceIntervals(results);

    expect(intervals.hitRate.lower).toBeLessThan(intervals.hitRate.point);
    expect(intervals.hitRate.upper).toBeGreaterThan(intervals.hitRate.point);
    expect(intervals.hitRate.point).toBeCloseTo(75, 0); // 15/20 = 75%

    expect(intervals.meanReciprocalRank.lower).toBeGreaterThanOrEqual(0);
    expect(intervals.meanReciprocalRank.upper).toBeLessThanOrEqual(1);

    expect(intervals.ndcgAtK).toBeDefined();
    expect(intervals.recall).toBeDefined();
  });

  it('perfect results have tight intervals near 100%', () => {
    const results = Array.from({ length: 20 }, (_, index) =>
      scoreTestCase(
        { id: index, query: `q${index}`, expected_doc_ids: [index * 10], tags: ['simple'] },
        [makeResult(index * 10, 0.9)],
        100,
      ),
    );

    const intervals = computeConfidenceIntervals(results);
    expect(intervals.hitRate.lower).toBeGreaterThan(90);
    expect(intervals.hitRate.upper).toBe(100);
  });

  it('returns interval width', () => {
    const results = Array.from({ length: 20 }, (_, index) =>
      scoreTestCase(
        { id: index, query: `q${index}`, expected_doc_ids: [index * 10], tags: ['simple'] },
        index % 3 === 0
          ? [makeResult(99, 0.5)]
          : [makeResult(index * 10, 0.9)],
        100,
      ),
    );

    const intervals = computeConfidenceIntervals(results);
    expect(intervals.hitRate.width).toBeCloseTo(
      intervals.hitRate.upper - intervals.hitRate.lower,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement confidence intervals**

Create `src/lib/eval/eval-advanced.ts`:

```typescript
// eval-advanced.ts
// Advanced eval metrics — confidence intervals, score calibration, coverage analysis.
// Pure functions — no I/O, no database calls.

import { computeMetrics } from './eval.js';
import type { ITestResultProps, IEvalMetricsProps } from './eval.js';

// =============================================================================
// Confidence Intervals via Bootstrap Resampling
// =============================================================================

const BOOTSTRAP_ITERATIONS = 1000;
const CONFIDENCE_LEVEL_LOWER = 0.025; // 2.5th percentile
const CONFIDENCE_LEVEL_UPPER = 0.975; // 97.5th percentile

export interface IConfidenceIntervalProps {
  point: number;
  lower: number;
  upper: number;
  width: number;
}

export interface IMetricConfidenceIntervalsProps {
  hitRate:              IConfidenceIntervalProps;
  firstResultAccuracy:  IConfidenceIntervalProps;
  recall:               IConfidenceIntervalProps;
  zeroResultRate:       IConfidenceIntervalProps;
  meanReciprocalRank:   IConfidenceIntervalProps;
  ndcgAtK:              IConfidenceIntervalProps;
}

function resampleWithReplacement(results: ITestResultProps[]): ITestResultProps[] {
  const resampled: ITestResultProps[] = [];
  for (let sampleIndex = 0; sampleIndex < results.length; sampleIndex++) {
    const randomIndex = Math.floor(Math.random() * results.length);
    resampled.push(results[randomIndex]);
  }
  return resampled;
}

function percentile(sortedValues: number[], fraction: number): number {
  const position = fraction * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const interpolation = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - interpolation) + sortedValues[upperIndex] * interpolation;
}

function buildInterval(bootstrapValues: number[], pointEstimate: number): IConfidenceIntervalProps {
  const sorted = [...bootstrapValues].sort((valueA, valueB) => valueA - valueB);
  const lower = percentile(sorted, CONFIDENCE_LEVEL_LOWER);
  const upper = percentile(sorted, CONFIDENCE_LEVEL_UPPER);
  return { point: pointEstimate, lower, upper, width: upper - lower };
}

export function computeConfidenceIntervals(
  results: ITestResultProps[],
  iterations: number = BOOTSTRAP_ITERATIONS,
): IMetricConfidenceIntervalsProps {
  const pointMetrics = computeMetrics(results);

  const bootstrapHitRates: number[] = [];
  const bootstrapFirstResultAccuracies: number[] = [];
  const bootstrapRecalls: number[] = [];
  const bootstrapZeroResultRates: number[] = [];
  const bootstrapMeanReciprocalRanks: number[] = [];
  const bootstrapNdcgAtKs: number[] = [];

  for (let iteration = 0; iteration < iterations; iteration++) {
    const resampled = resampleWithReplacement(results);
    const resampledMetrics = computeMetrics(resampled);
    bootstrapHitRates.push(resampledMetrics.hitRate);
    bootstrapFirstResultAccuracies.push(resampledMetrics.firstResultAccuracy);
    bootstrapRecalls.push(resampledMetrics.recall);
    bootstrapZeroResultRates.push(resampledMetrics.zeroResultRate);
    bootstrapMeanReciprocalRanks.push(resampledMetrics.meanReciprocalRank);
    bootstrapNdcgAtKs.push(resampledMetrics.ndcgAtK);
  }

  return {
    hitRate:              buildInterval(bootstrapHitRates, pointMetrics.hitRate),
    firstResultAccuracy:  buildInterval(bootstrapFirstResultAccuracies, pointMetrics.firstResultAccuracy),
    recall:               buildInterval(bootstrapRecalls, pointMetrics.recall),
    zeroResultRate:       buildInterval(bootstrapZeroResultRates, pointMetrics.zeroResultRate),
    meanReciprocalRank:   buildInterval(bootstrapMeanReciprocalRanks, pointMetrics.meanReciprocalRank),
    ndcgAtK:              buildInterval(bootstrapNdcgAtKs, pointMetrics.ndcgAtK),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/eval/eval-advanced.ts tests/eval-advanced.test.ts
git commit -m "feat(eval): add confidence intervals via bootstrap resampling"
```

---

## Task 3: Add score calibration analysis

Score calibration shows how similarity scores are distributed — are they well-separated (relevant docs score high, irrelevant score low) or compressed (everything scores similarly)? Also identifies the optimal threshold.

**Files:**
- Modify: `src/lib/eval/eval-advanced.ts`
- Modify: `tests/eval-advanced.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/eval-advanced.test.ts`:

```typescript
import { computeConfidenceIntervals, computeScoreCalibration } from '../src/lib/eval/eval-advanced.js';

describe('computeScoreCalibration', () => {
  it('computes score statistics for relevant and irrelevant results', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [10], tags: ['simple'] },
        [makeResult(10, 0.9), makeResult(20, 0.3)],
        100,
      ),
      scoreTestCase(
        { id: 2, query: 'q2', expected_doc_ids: [30], tags: ['simple'] },
        [makeResult(30, 0.85), makeResult(40, 0.25)],
        100,
      ),
    ];

    const calibration = computeScoreCalibration(results);

    expect(calibration.relevantScores.mean).toBeGreaterThan(calibration.irrelevantScores.mean);
    expect(calibration.relevantScores.count).toBe(2);
    expect(calibration.irrelevantScores.count).toBe(2);
    expect(calibration.separation).toBeGreaterThan(0);
  });

  it('handles no relevant results', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [99], tags: ['simple'] },
        [makeResult(10, 0.5)],
        100,
      ),
    ];

    const calibration = computeScoreCalibration(results);
    expect(calibration.relevantScores.count).toBe(0);
    expect(calibration.irrelevantScores.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: FAIL — `computeScoreCalibration` not exported

- [ ] **Step 3: Implement score calibration**

Add to `src/lib/eval/eval-advanced.ts`:

```typescript
// =============================================================================
// Score Calibration — how well-separated are relevant vs irrelevant scores?
// =============================================================================

export interface IScoreDistributionProps {
  count:  number;
  mean:   number;
  median: number;
  min:    number;
  max:    number;
}

export interface IScoreCalibrationProps {
  relevantScores:   IScoreDistributionProps;
  irrelevantScores: IScoreDistributionProps;
  separation:       number; // difference between relevant mean and irrelevant mean
}

function computeDistribution(scores: number[]): IScoreDistributionProps {
  if (scores.length === 0) {
    return { count: 0, mean: 0, median: 0, min: 0, max: 0 };
  }
  const sorted = [...scores].sort((scoreA, scoreB) => scoreA - scoreB);
  const sum = sorted.reduce((total, score) => total + score, 0);
  const middleIndex = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middleIndex - 1] + sorted[middleIndex]) / 2
    : sorted[middleIndex];

  return {
    count:  sorted.length,
    mean:   sum / sorted.length,
    median,
    min:    sorted[0],
    max:    sorted[sorted.length - 1],
  };
}

export function computeScoreCalibration(results: ITestResultProps[]): IScoreCalibrationProps {
  const relevantScores: number[] = [];
  const irrelevantScores: number[] = [];

  for (const result of results) {
    if (result.testCase.expected_doc_ids.length === 0) continue; // skip out-of-scope

    for (let position = 0; position < result.returnedIds.length; position++) {
      const score = result.returnedScores[position];
      if (result.testCase.expected_doc_ids.includes(result.returnedIds[position])) {
        relevantScores.push(score);
      } else {
        irrelevantScores.push(score);
      }
    }
  }

  const relevantDistribution = computeDistribution(relevantScores);
  const irrelevantDistribution = computeDistribution(irrelevantScores);

  return {
    relevantScores:   relevantDistribution,
    irrelevantScores: irrelevantDistribution,
    separation:       relevantDistribution.mean - irrelevantDistribution.mean,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/eval/eval-advanced.ts tests/eval-advanced.test.ts
git commit -m "feat(eval): add score calibration — relevant vs irrelevant score distribution"
```

---

## Task 4: Add golden set coverage analysis

Coverage analysis shows which document types, domains, and query categories are well-tested vs undertested. Helps identify blind spots in the golden dataset.

**Files:**
- Modify: `src/lib/eval/eval-advanced.ts`
- Modify: `tests/eval-advanced.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/eval-advanced.test.ts`:

```typescript
import { computeConfidenceIntervals, computeScoreCalibration, computeCoverageAnalysis } from '../src/lib/eval/eval-advanced.js';

describe('computeCoverageAnalysis', () => {
  it('counts queries per tag and identifies undertested tags', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [10], tags: ['simple', 'search'] },
        [makeResult(10, 0.9)], 100,
      ),
      scoreTestCase(
        { id: 2, query: 'q2', expected_doc_ids: [20], tags: ['simple', 'search'] },
        [makeResult(20, 0.9)], 100,
      ),
      scoreTestCase(
        { id: 3, query: 'q3', expected_doc_ids: [30], tags: ['conceptual'] },
        [makeResult(30, 0.9)], 100,
      ),
    ];

    const coverage = computeCoverageAnalysis(results);

    expect(coverage.queriesPerTag['simple']).toBe(2);
    expect(coverage.queriesPerTag['search']).toBe(2);
    expect(coverage.queriesPerTag['conceptual']).toBe(1);
    expect(coverage.totalQueries).toBe(3);
    expect(coverage.totalTags).toBe(3);
  });

  it('identifies unique expected documents tested', () => {
    const results = [
      scoreTestCase(
        { id: 1, query: 'q1', expected_doc_ids: [10, 20], tags: ['multi-doc'] },
        [makeResult(10, 0.9)], 100,
      ),
      scoreTestCase(
        { id: 2, query: 'q2', expected_doc_ids: [10], tags: ['simple'] },
        [makeResult(10, 0.9)], 100,
      ),
    ];

    const coverage = computeCoverageAnalysis(results);
    expect(coverage.uniqueExpectedDocuments).toBe(2); // docs 10 and 20
  });

  it('counts out-of-scope queries separately', () => {
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

    const coverage = computeCoverageAnalysis(results);
    expect(coverage.outOfScopeCount).toBe(1);
    expect(coverage.normalCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: FAIL — `computeCoverageAnalysis` not exported

- [ ] **Step 3: Implement coverage analysis**

Add to `src/lib/eval/eval-advanced.ts`:

```typescript
// =============================================================================
// Coverage Analysis — what's tested and what's missing?
// =============================================================================

export interface ICoverageAnalysisProps {
  totalQueries:             number;
  normalCount:              number;
  outOfScopeCount:          number;
  totalTags:                number;
  queriesPerTag:            Record<string, number>;
  uniqueExpectedDocuments:  number;
  expectedDocumentIds:      number[];
}

export function computeCoverageAnalysis(results: ITestResultProps[]): ICoverageAnalysisProps {
  const queriesPerTag: Record<string, number> = {};
  const expectedDocIdSet = new Set<number>();
  let normalCount = 0;
  let outOfScopeCount = 0;

  for (const result of results) {
    if (result.testCase.expected_doc_ids.length === 0) {
      outOfScopeCount++;
    } else {
      normalCount++;
    }

    for (const tag of result.testCase.tags) {
      queriesPerTag[tag] = (queriesPerTag[tag] ?? 0) + 1;
    }

    for (const documentId of result.testCase.expected_doc_ids) {
      expectedDocIdSet.add(documentId);
    }
  }

  return {
    totalQueries:            results.length,
    normalCount,
    outOfScopeCount,
    totalTags:               Object.keys(queriesPerTag).length,
    queriesPerTag,
    uniqueExpectedDocuments: expectedDocIdSet.size,
    expectedDocumentIds:     [...expectedDocIdSet].sort((idA, idB) => idA - idB),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/eval/eval-advanced.ts tests/eval-advanced.test.ts
git commit -m "feat(eval): add golden set coverage analysis"
```

---

## Task 5: Format advanced report and wire into runner

Create a `formatAdvancedReport` function that produces a human-readable section for confidence intervals, score calibration, and coverage. Wire it into both the eval runner script and the CLI command.

**Files:**
- Modify: `src/lib/eval/eval-advanced.ts`
- Modify: `tests/eval-advanced.test.ts`
- Modify: `src/scripts/eval-search.ts`
- Modify: `src/commands/eval.ts`

- [ ] **Step 1: Write failing test for format function**

Add to `tests/eval-advanced.test.ts`:

```typescript
import {
  computeConfidenceIntervals,
  computeScoreCalibration,
  computeCoverageAnalysis,
  formatAdvancedReport,
} from '../src/lib/eval/eval-advanced.js';

describe('formatAdvancedReport', () => {
  it('includes all three sections', () => {
    const results = Array.from({ length: 20 }, (_, index) =>
      scoreTestCase(
        { id: index, query: `q${index}`, expected_doc_ids: [index * 10], tags: ['simple'] },
        [makeResult(index * 10, 0.9), makeResult(99, 0.3)],
        100,
      ),
    );

    const intervals = computeConfidenceIntervals(results, 100); // fewer iterations for speed
    const calibration = computeScoreCalibration(results);
    const coverage = computeCoverageAnalysis(results);

    const report = formatAdvancedReport(intervals, calibration, coverage);

    expect(report).toContain('CONFIDENCE INTERVALS');
    expect(report).toContain('SCORE CALIBRATION');
    expect(report).toContain('COVERAGE ANALYSIS');
    expect(report).toContain('±');
    expect(report).toContain('separation');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: FAIL — `formatAdvancedReport` not exported

- [ ] **Step 3: Implement `formatAdvancedReport`**

Add to `src/lib/eval/eval-advanced.ts`:

```typescript
// =============================================================================
// Format advanced report
// =============================================================================

function formatInterval(interval: IConfidenceIntervalProps, isPercentage: boolean): string {
  if (isPercentage) {
    return `${interval.point.toFixed(1)}% (±${(interval.width / 2).toFixed(1)}%, 95% CI: ${interval.lower.toFixed(1)}–${interval.upper.toFixed(1)}%)`;
  }
  return `${interval.point.toFixed(3)} (±${(interval.width / 2).toFixed(3)}, 95% CI: ${interval.lower.toFixed(3)}–${interval.upper.toFixed(3)})`;
}

export function formatAdvancedReport(
  intervals: IMetricConfidenceIntervalsProps,
  calibration: IScoreCalibrationProps,
  coverage: ICoverageAnalysisProps,
): string {
  const lines: string[] = [];

  lines.push('='.repeat(60));
  lines.push('Advanced Analysis');
  lines.push('='.repeat(60));
  lines.push('');

  // Confidence intervals
  lines.push('CONFIDENCE INTERVALS (95%, bootstrap):');
  lines.push(`  Hit rate:              ${formatInterval(intervals.hitRate, true)}`);
  lines.push(`  First-result accuracy: ${formatInterval(intervals.firstResultAccuracy, true)}`);
  lines.push(`  Recall:                ${formatInterval(intervals.recall, true)}`);
  lines.push(`  Zero-result rate:      ${formatInterval(intervals.zeroResultRate, true)}`);
  lines.push(`  MRR:                   ${formatInterval(intervals.meanReciprocalRank, false)}`);
  lines.push(`  NDCG@k:                ${formatInterval(intervals.ndcgAtK, false)}`);
  lines.push('');

  // Score calibration
  lines.push('SCORE CALIBRATION:');
  lines.push(`  Relevant scores:    mean=${calibration.relevantScores.mean.toFixed(3)}, median=${calibration.relevantScores.median.toFixed(3)}, range=[${calibration.relevantScores.min.toFixed(3)}–${calibration.relevantScores.max.toFixed(3)}] (${calibration.relevantScores.count} scores)`);
  lines.push(`  Irrelevant scores:  mean=${calibration.irrelevantScores.mean.toFixed(3)}, median=${calibration.irrelevantScores.median.toFixed(3)}, range=[${calibration.irrelevantScores.min.toFixed(3)}–${calibration.irrelevantScores.max.toFixed(3)}] (${calibration.irrelevantScores.count} scores)`);
  lines.push(`  Score separation:   ${calibration.separation.toFixed(3)} (higher = better distinction between relevant and irrelevant)`);
  lines.push('');

  // Coverage
  lines.push('COVERAGE ANALYSIS:');
  lines.push(`  Total queries:         ${coverage.totalQueries} (${coverage.normalCount} normal, ${coverage.outOfScopeCount} out-of-scope)`);
  lines.push(`  Unique docs tested:    ${coverage.uniqueExpectedDocuments}`);
  lines.push(`  Tags covered:          ${coverage.totalTags}`);

  const sortedTags = Object.entries(coverage.queriesPerTag)
    .sort((entryA, entryB) => entryB[1] - entryA[1]);
  for (const [tag, count] of sortedTags) {
    const marker = count < 3 ? ' ← undertested' : '';
    lines.push(`    ${tag}: ${count} queries${marker}`);
  }

  lines.push('');
  lines.push('='.repeat(60));

  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/repos/ledger && npx vitest run tests/eval-advanced.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into eval runner script**

In `src/scripts/eval-search.ts`, add import:

```typescript
import { computeConfidenceIntervals, computeScoreCalibration, computeCoverageAnalysis, formatAdvancedReport } from '../lib/eval/eval-advanced.js';
```

After the comparison section (end of `runEval`), add:

```typescript
// Advanced analysis
const confidenceIntervals = computeConfidenceIntervals(results);
const scoreCalibration = computeScoreCalibration(results);
const coverageAnalysis = computeCoverageAnalysis(results);
console.log('\n' + formatAdvancedReport(confidenceIntervals, scoreCalibration, coverageAnalysis));
```

- [ ] **Step 6: Wire into CLI command**

In `src/commands/eval.ts`, add the same import and the same 4 lines after the comparison section.

- [ ] **Step 7: Run full test suite**

Run: `cd ~/repos/ledger && npx vitest run`
Expected: ALL PASS

- [ ] **Step 8: Type check**

Run: `cd ~/repos/ledger && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 9: Commit**

```bash
git add src/lib/eval/eval-advanced.ts tests/eval-advanced.test.ts src/scripts/eval-search.ts src/commands/eval.ts
git commit -m "feat(eval): add advanced report — confidence intervals, score calibration, coverage analysis"
```

---

## Task 6: Live verification

Run the eval against live Supabase to verify NDCG and the advanced report work end-to-end.

- [ ] **Step 1: Run eval**

Run: `cd ~/repos/ledger && npx tsx src/scripts/eval-search.ts`

Expected output includes:
- Standard metrics report (with new NDCG@k line)
- Run saved to eval_runs
- Comparison against previous run (with NDCG in diff)
- Advanced Analysis section with confidence intervals, score calibration, coverage

- [ ] **Step 2: Verify NDCG value makes sense**

NDCG@k should be between MRR (0.601) and hit rate (88.5%). For multi-doc queries where some expected docs rank low, NDCG will be lower than MRR. For single-doc queries, NDCG ≈ MRR.

- [ ] **Step 3: Verify confidence intervals are reasonable**

With 56 test cases, interval widths should be roughly:
- Hit rate: ±5-8%
- MRR: ±0.05-0.10
- These wide intervals correctly reflect the small dataset

---

## Summary

| Task | What                                              | New Tests | Depends On |
|------|---------------------------------------------------|-----------|------------|
| 1    | NDCG@k in scoring + metrics + comparison + report | 7         | —          |
| 2    | Confidence intervals via bootstrap                | 3         | Task 1 (ndcgAtK) |
| 3    | Score calibration (relevant vs irrelevant)         | 2         | —          |
| 4    | Coverage analysis (tags, docs, gaps)               | 3         | —          |
| 5    | Format report + wire into runner/CLI               | 1         | Tasks 2-4  |
| 6    | Live verification                                  | 0 (manual)| Task 5     |

After this plan completes, the eval system reports:
- **7 metrics:** hit rate, first-result accuracy, recall, zero-result rate, MRR, NDCG@k, out-of-scope accuracy
- **Confidence intervals** for all metrics (bootstrap, 95%)
- **Score calibration** showing how well scores distinguish relevant from irrelevant
- **Coverage analysis** showing which tags/docs are undertested
- **Run comparison** with regression detection
- **Persistent storage** of every run with config snapshot
