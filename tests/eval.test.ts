// eval.test.ts
// Unit tests for eval.ts — scoreTestCase, computeMetrics, formatReport, compareRuns, formatComparison.

import { describe, it, expect } from 'vitest';
import type { ISearchResultProps } from '../src/lib/search/ai-search.js';
import {
  scoreTestCase,
  computeMetrics,
  formatReport,
  compareRuns,
  formatComparison,
  type IGoldenTestCaseProps,
  type ITestResultProps,
  type IComparableMetricsProps,
} from '../src/lib/eval/eval.js';

// =============================================================================
// Helpers
// =============================================================================

function makeResult(id: number): ISearchResultProps {
  return {
    id,
    content: '',
    name: `doc-${id}`,
    domain: 'general',
    document_type: 'note',
    project: null,
    protection: 'none',
    description: null,
    agent: null,
    status: null,
    file_path: null,
    skill_ref: null,
    owner_type: 'user',
    owner_id: null,
    is_auto_load: false,
    content_hash: null,
    score: 0.9,
  };
}

function makeTestCase(expected_doc_ids: number[]): IGoldenTestCaseProps {
  return { id: 1, query: 'test query', expected_doc_ids, tags: [] };
}

// =============================================================================
// scoreTestCase — reciprocalRank
// =============================================================================

describe('scoreTestCase — reciprocalRank', () => {
  it('hit at position 0 → reciprocalRank 1.0', () => {
    const testCase = makeTestCase([42]);
    const results = [makeResult(42), makeResult(7), makeResult(99)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.reciprocalRank).toBe(1.0);
  });

  it('hit at position 2 → reciprocalRank 1/3', () => {
    const testCase = makeTestCase([99]);
    const results = [makeResult(1), makeResult(2), makeResult(99)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.reciprocalRank).toBeCloseTo(1 / 3);
  });

  it('miss (expected doc not in results) → reciprocalRank 0', () => {
    const testCase = makeTestCase([42]);
    const results = [makeResult(1), makeResult(2), makeResult(3)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.reciprocalRank).toBe(0);
  });

  it('out-of-scope (no expected docs) → reciprocalRank 0', () => {
    const testCase = makeTestCase([]);
    const results: ISearchResultProps[] = [];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.reciprocalRank).toBe(0);
  });

  it('multiple expected docs — uses earliest position', () => {
    // expected: [5, 10]. Results: [1, 10, 5]. Position of 10 is 1, position of 5 is 2.
    // firstExpectedPosition = 1 → reciprocalRank = 1/2
    const testCase = makeTestCase([5, 10]);
    const results = [makeResult(1), makeResult(10), makeResult(5)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.reciprocalRank).toBeCloseTo(0.5);
  });
});

// =============================================================================
// computeMetrics — meanReciprocalRank
// =============================================================================

describe('computeMetrics — meanReciprocalRank', () => {
  it('computes MRR across multiple results: (1/1 + 1/2 + 0) / 3 = 0.5', () => {
    const results: ITestResultProps[] = [
      // position 0 → RR = 1
      scoreTestCase(makeTestCase([10]), [makeResult(10)], 50),
      // position 1 → RR = 0.5
      scoreTestCase(makeTestCase([20]), [makeResult(99), makeResult(20)], 50),
      // miss → RR = 0
      scoreTestCase(makeTestCase([30]), [makeResult(1), makeResult(2)], 50),
    ];
    const metrics = computeMetrics(results);
    expect(metrics.meanReciprocalRank).toBeCloseTo((1 + 0.5 + 0) / 3);
  });

  it('out-of-scope results are excluded from MRR denominator', () => {
    const results: ITestResultProps[] = [
      // normal: position 0 → RR = 1
      scoreTestCase(makeTestCase([10]), [makeResult(10)], 50),
      // out-of-scope
      scoreTestCase(makeTestCase([]), [], 50),
    ];
    const metrics = computeMetrics(results);
    // Only 1 normal result; MRR = 1 / 1 = 1.0
    expect(metrics.meanReciprocalRank).toBeCloseTo(1.0);
  });

  it('no normal results → meanReciprocalRank is 0', () => {
    const results: ITestResultProps[] = [
      scoreTestCase(makeTestCase([]), [], 50),
    ];
    const metrics = computeMetrics(results);
    expect(metrics.meanReciprocalRank).toBe(0);
  });
});

// =============================================================================
// formatReport — MRR line
// =============================================================================

describe('formatReport — MRR line', () => {
  it('output contains "MRR:" label and formatted value', () => {
    const results: ITestResultProps[] = [
      scoreTestCase(makeTestCase([10]), [makeResult(10)], 50),
      scoreTestCase(makeTestCase([20]), [makeResult(99), makeResult(20)], 50),
      scoreTestCase(makeTestCase([30]), [makeResult(1), makeResult(2)], 50),
    ];
    const metrics = computeMetrics(results);
    const report = formatReport(metrics);
    expect(report).toContain('MRR:');
    // MRR = (1 + 0.5 + 0) / 3 ≈ 0.500
    expect(report).toContain('0.500');
  });

  it('MRR line appears after Avg response time line', () => {
    const results: ITestResultProps[] = [
      scoreTestCase(makeTestCase([10]), [makeResult(10)], 100),
    ];
    const metrics = computeMetrics(results);
    const report = formatReport(metrics);
    const averageResponseTimeIndex = report.indexOf('Avg response time:');
    const meanReciprocalRankIndex = report.indexOf('MRR:');
    expect(averageResponseTimeIndex).toBeGreaterThanOrEqual(0);
    expect(meanReciprocalRankIndex).toBeGreaterThan(averageResponseTimeIndex);
  });
});

// =============================================================================
// scoreTestCase — normalizedDiscountedCumulativeGain
// =============================================================================

describe('scoreTestCase — normalizedDiscountedCumulativeGain', () => {
  it('perfect ranking (all expected at top) → NDCG 1.0', () => {
    // expected: [10, 20]. Results: [10, 20, 99]. Both expected docs at positions 0 and 1.
    // DCG = 1/log2(2) + 1/log2(3) = 1.0 + 0.6309 = 1.6309
    // IDCG = 1/log2(2) + 1/log2(3) = 1.6309
    // NDCG = 1.0
    const testCase = makeTestCase([10, 20]);
    const results = [makeResult(10), makeResult(20), makeResult(99)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.normalizedDiscountedCumulativeGain).toBeCloseTo(1.0);
  });

  it('imperfect ranking (expected docs not at top) → NDCG ≈ 0.6934', () => {
    // expected: [10]. Results: [99, 88, 10]. Expected doc at position 2.
    // DCG = 0/log2(2) + 0/log2(3) + 1/log2(4) = 0 + 0 + 0.5 = 0.5
    // IDCG = 1/log2(2) = 1.0
    // NDCG = 0.5 / 1.0 = 0.5
    // Correction: expected [10, 20], results [99, 10, 88, 20, 77]
    // DCG = 0/log2(2) + 1/log2(3) + 0/log2(4) + 1/log2(5)
    //     = 0 + 0.6309 + 0 + 0.4307 = 1.0616
    // IDCG = 1/log2(2) + 1/log2(3) = 1.0 + 0.6309 = 1.6309
    // NDCG = 1.0616 / 1.6309 ≈ 0.6509 ... not quite 0.6934
    // Use: expected [10], results [99, 10]. Position 1.
    // DCG = 0 + 1/log2(3) = 0.6309
    // IDCG = 1/log2(2) = 1.0
    // NDCG = 0.6309 — close to 0.6309, not 0.6934
    // Use: expected [10, 20], results [99, 10, 20].
    // DCG = 0 + 1/log2(3) + 1/log2(4) = 0.6309 + 0.5 = 1.1309
    // IDCG = 1/log2(2) + 1/log2(3) = 1.0 + 0.6309 = 1.6309
    // NDCG = 1.1309 / 1.6309 ≈ 0.6934
    const testCase = makeTestCase([10, 20]);
    const results = [makeResult(99), makeResult(10), makeResult(20)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.normalizedDiscountedCumulativeGain).toBeCloseTo(0.6934, 3);
  });

  it('no expected docs found → NDCG 0', () => {
    const testCase = makeTestCase([42]);
    const results = [makeResult(1), makeResult(2), makeResult(3)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.normalizedDiscountedCumulativeGain).toBe(0);
  });

  it('out-of-scope → NDCG 0', () => {
    const testCase = makeTestCase([]);
    const results: ISearchResultProps[] = [];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.normalizedDiscountedCumulativeGain).toBe(0);
  });

  it('single expected doc at position 0 → NDCG 1.0', () => {
    const testCase = makeTestCase([42]);
    const results = [makeResult(42), makeResult(7)];
    const scored = scoreTestCase(testCase, results, 100);
    expect(scored.normalizedDiscountedCumulativeGain).toBeCloseTo(1.0);
  });
});

// =============================================================================
// computeMetrics — normalizedDiscountedCumulativeGain
// =============================================================================

describe('computeMetrics — normalizedDiscountedCumulativeGain', () => {
  it('averages NDCG across normal results', () => {
    const results: ITestResultProps[] = [
      // perfect: NDCG = 1.0
      scoreTestCase(makeTestCase([10]), [makeResult(10)], 50),
      // miss: NDCG = 0
      scoreTestCase(makeTestCase([20]), [makeResult(1), makeResult(2)], 50),
    ];
    const metrics = computeMetrics(results);
    // (1.0 + 0) / 2 = 0.5
    expect(metrics.normalizedDiscountedCumulativeGain).toBeCloseTo(0.5);
  });

  it('excludes out-of-scope from NDCG average', () => {
    const results: ITestResultProps[] = [
      // normal: perfect → NDCG = 1.0
      scoreTestCase(makeTestCase([10]), [makeResult(10)], 50),
      // out-of-scope: NDCG = 0 but should be excluded from denominator
      scoreTestCase(makeTestCase([]), [], 50),
    ];
    const metrics = computeMetrics(results);
    // Only 1 normal result; NDCG = 1.0 / 1 = 1.0
    expect(metrics.normalizedDiscountedCumulativeGain).toBeCloseTo(1.0);
  });
});

// =============================================================================
// Helpers for compareRuns / formatComparison
// =============================================================================

function makeComparableMetrics(overrides: Partial<IComparableMetricsProps> = {}): IComparableMetricsProps {
  return {
    hitRate: 90,
    firstResultAccuracy: 85,
    recall: 80,
    zeroResultRate: 5,
    meanReciprocalRank: 0.75,
    normalizedDiscountedCumulativeGain: 0.8,
    avgResponseTimeMs: 200,
    ...overrides,
  };
}

// =============================================================================
// compareRuns — severity
// =============================================================================

describe('compareRuns — severity', () => {
  it('all metrics improved → severity ok, regressions empty', () => {
    const current = makeComparableMetrics({
      hitRate: 92,
      firstResultAccuracy: 87,
      recall: 82,
      zeroResultRate: 4,
      meanReciprocalRank: 0.80,
      avgResponseTimeMs: 180,
    });
    const previous = makeComparableMetrics();
    const comparison = compareRuns(current, previous);
    expect(comparison.severity).toBe('ok');
    expect(comparison.regressions).toHaveLength(0);
  });

  it('hitRate drops by 3% → severity warning', () => {
    const current = makeComparableMetrics({ hitRate: 87 });
    const previous = makeComparableMetrics({ hitRate: 90 });
    const comparison = compareRuns(current, previous);
    expect(comparison.severity).toBe('warning');
    expect(comparison.regressions.some(diff => diff.metric === 'hitRate')).toBe(true);
  });

  it('hitRate drops by 6% → severity block', () => {
    const current = makeComparableMetrics({ hitRate: 84 });
    const previous = makeComparableMetrics({ hitRate: 90 });
    const comparison = compareRuns(current, previous);
    expect(comparison.severity).toBe('block');
  });

  it('hitRate below 80% → severity critical', () => {
    const current = makeComparableMetrics({ hitRate: 78 });
    const previous = makeComparableMetrics({ hitRate: 85 });
    const comparison = compareRuns(current, previous);
    expect(comparison.severity).toBe('critical');
  });

  it('zeroResultRate above 10% → severity critical', () => {
    const current = makeComparableMetrics({ zeroResultRate: 12 });
    const previous = makeComparableMetrics({ zeroResultRate: 8 });
    const comparison = compareRuns(current, previous);
    expect(comparison.severity).toBe('critical');
  });
});

// =============================================================================
// compareRuns — inverted metrics
// =============================================================================

describe('compareRuns — inverted metrics', () => {
  it('zeroResultRate decrease is an improvement', () => {
    const current = makeComparableMetrics({ zeroResultRate: 3 });
    const previous = makeComparableMetrics({ zeroResultRate: 5 });
    const comparison = compareRuns(current, previous);
    expect(comparison.improvements.some(diff => diff.metric === 'zeroResultRate')).toBe(true);
    expect(comparison.regressions.some(diff => diff.metric === 'zeroResultRate')).toBe(false);
  });

  it('avgResponseTimeMs decrease is an improvement', () => {
    const current = makeComparableMetrics({ avgResponseTimeMs: 150 });
    const previous = makeComparableMetrics({ avgResponseTimeMs: 200 });
    const comparison = compareRuns(current, previous);
    expect(comparison.improvements.some(diff => diff.metric === 'avgResponseTimeMs')).toBe(true);
    expect(comparison.regressions.some(diff => diff.metric === 'avgResponseTimeMs')).toBe(false);
  });

  it('zeroResultRate increase is a regression', () => {
    const current = makeComparableMetrics({ zeroResultRate: 8 });
    const previous = makeComparableMetrics({ zeroResultRate: 5 });
    const comparison = compareRuns(current, previous);
    expect(comparison.regressions.some(diff => diff.metric === 'zeroResultRate')).toBe(true);
    expect(comparison.improvements.some(diff => diff.metric === 'zeroResultRate')).toBe(false);
  });

  it('avgResponseTimeMs increase is a regression', () => {
    const current = makeComparableMetrics({ avgResponseTimeMs: 250 });
    const previous = makeComparableMetrics({ avgResponseTimeMs: 200 });
    const comparison = compareRuns(current, previous);
    expect(comparison.regressions.some(diff => diff.metric === 'avgResponseTimeMs')).toBe(true);
    expect(comparison.improvements.some(diff => diff.metric === 'avgResponseTimeMs')).toBe(false);
  });
});

// =============================================================================
// compareRuns — unchanged threshold
// =============================================================================

describe('compareRuns — unchanged threshold', () => {
  it('change smaller than 0.01 is classified as unchanged', () => {
    const current = makeComparableMetrics({ hitRate: 90.005 });
    const previous = makeComparableMetrics({ hitRate: 90 });
    const comparison = compareRuns(current, previous);
    expect(comparison.unchanged.some(diff => diff.metric === 'hitRate')).toBe(true);
    expect(comparison.improvements.some(diff => diff.metric === 'hitRate')).toBe(false);
    expect(comparison.regressions.some(diff => diff.metric === 'hitRate')).toBe(false);
  });
});

// =============================================================================
// formatComparison
// =============================================================================

describe('formatComparison', () => {
  it('includes severity label in output', () => {
    const current = makeComparableMetrics({ hitRate: 87 });
    const previous = makeComparableMetrics({ hitRate: 90 });
    const comparison = compareRuns(current, previous);
    const report = formatComparison(comparison);
    expect(report).toContain('warning');
  });

  it('shows REGRESSIONS section when regressions exist', () => {
    const current = makeComparableMetrics({ hitRate: 87 });
    const previous = makeComparableMetrics({ hitRate: 90 });
    const comparison = compareRuns(current, previous);
    const report = formatComparison(comparison);
    expect(report).toContain('REGRESSIONS');
    expect(report).toContain('hitRate');
  });

  it('shows IMPROVEMENTS section when improvements exist', () => {
    const current = makeComparableMetrics({ hitRate: 95 });
    const previous = makeComparableMetrics({ hitRate: 90 });
    const comparison = compareRuns(current, previous);
    const report = formatComparison(comparison);
    expect(report).toContain('IMPROVEMENTS');
    expect(report).toContain('hitRate');
  });

  it('shows UNCHANGED section when unchanged metrics exist', () => {
    const current = makeComparableMetrics({ hitRate: 90.005 });
    const previous = makeComparableMetrics();
    const comparison = compareRuns(current, previous);
    const report = formatComparison(comparison);
    expect(report).toContain('UNCHANGED');
  });

  it('formats MRR with .toFixed(3) precision', () => {
    const current = makeComparableMetrics({ meanReciprocalRank: 0.825 });
    const previous = makeComparableMetrics({ meanReciprocalRank: 0.75 });
    const comparison = compareRuns(current, previous);
    const report = formatComparison(comparison);
    expect(report).toContain('0.825');
  });
});
