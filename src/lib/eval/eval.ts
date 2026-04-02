// eval.ts
// Types and metric computation for search evaluation.
// Pure functions — no I/O, no database calls.

import type { ISearchResultProps } from '../search/ai-search.js';

// =============================================================================
// Types
// =============================================================================

export interface IGoldenTestCaseProps {
  id: number;
  query: string;
  expected_doc_ids: number[];
  tags: string[];
}

export interface ITestResultProps {
  testCase: IGoldenTestCaseProps;
  returnedIds: number[];
  returnedScores: number[];
  hit: boolean;
  firstResultHit: boolean;
  expectedFound: number;
  expectedTotal: number;
  position: number | null;
  responseTimeMs: number;
  reciprocalRank: number;
}

export interface IEvalMetricsProps {
  totalCases: number;
  normalCases: number;
  outOfScopeCases: number;
  hits: number;
  firstResultHits: number;
  totalExpected: number;
  totalFound: number;
  zeroResults: number;
  outOfScopeCorrect: number;
  avgResponseTimeMs: number;
  hitRate: number;
  firstResultAccuracy: number;
  recall: number;
  zeroResultRate: number;
  outOfScopeAccuracy: number;
  meanReciprocalRank: number;
  tagStats: Record<string, { total: number; hits: number; firstHits: number }>;
  missed: ITestResultProps[];
}

// =============================================================================
// Scoring a single test case
// =============================================================================

export function scoreTestCase(
  testCase: IGoldenTestCaseProps,
  searchResults: ISearchResultProps[],
  responseTimeMs: number,
): ITestResultProps {
  const returnedIds = searchResults.map(result => result.id);
  const returnedScores = searchResults.map(result => result.score ?? result.similarity ?? 0);
  const isOutOfScope = testCase.expected_doc_ids.length === 0;

  if (isOutOfScope) {
    return {
      testCase,
      returnedIds,
      returnedScores,
      hit: searchResults.length === 0,
      firstResultHit: searchResults.length === 0,
      expectedFound: 0,
      expectedTotal: 0,
      position: null,
      responseTimeMs,
      reciprocalRank: 0,
    };
  }

  const foundExpected = testCase.expected_doc_ids.filter(expectedId =>
    returnedIds.includes(expectedId),
  );

  const firstExpectedPosition = testCase.expected_doc_ids
    .map(expectedId => returnedIds.indexOf(expectedId))
    .filter(position => position >= 0)
    .sort((positionA, positionB) => positionA - positionB)[0] ?? null;

  return {
    testCase,
    returnedIds,
    returnedScores,
    hit: foundExpected.length > 0,
    firstResultHit: testCase.expected_doc_ids.includes(returnedIds[0]),
    expectedFound: foundExpected.length,
    expectedTotal: testCase.expected_doc_ids.length,
    position: firstExpectedPosition,
    responseTimeMs,
    reciprocalRank: firstExpectedPosition !== null ? 1 / (firstExpectedPosition + 1) : 0,
  };
}

// =============================================================================
// Aggregate metrics from scored results
// =============================================================================

export function computeMetrics(results: ITestResultProps[]): IEvalMetricsProps {
  const normalResults = results.filter(result => result.testCase.expected_doc_ids.length > 0);
  const outOfScopeResults = results.filter(result => result.testCase.expected_doc_ids.length === 0);

  const totalNormal = normalResults.length;
  const hits = normalResults.filter(result => result.hit).length;
  const firstResultHits = normalResults.filter(result => result.firstResultHit).length;
  const totalExpected = normalResults.reduce((sum, result) => sum + result.expectedTotal, 0);
  const totalFound = normalResults.reduce((sum, result) => sum + result.expectedFound, 0);
  const zeroResults = normalResults.filter(result => result.returnedIds.length === 0).length;
  const outOfScopeCorrect = outOfScopeResults.filter(result => result.hit).length;
  const avgResponseTimeMs = results.length > 0
    ? results.reduce((sum, result) => sum + result.responseTimeMs, 0) / results.length
    : 0;

  const tagStats: Record<string, { total: number; hits: number; firstHits: number }> = {};
  for (const result of normalResults) {
    for (const tag of result.testCase.tags) {
      if (!tagStats[tag]) tagStats[tag] = { total: 0, hits: 0, firstHits: 0 };
      tagStats[tag].total++;
      if (result.hit) tagStats[tag].hits++;
      if (result.firstResultHit) tagStats[tag].firstHits++;
    }
  }

  return {
    totalCases: results.length,
    normalCases: totalNormal,
    outOfScopeCases: outOfScopeResults.length,
    hits,
    firstResultHits,
    totalExpected,
    totalFound,
    zeroResults,
    outOfScopeCorrect,
    avgResponseTimeMs,
    hitRate: totalNormal > 0 ? (hits / totalNormal) * 100 : 0,
    firstResultAccuracy: totalNormal > 0 ? (firstResultHits / totalNormal) * 100 : 0,
    recall: totalExpected > 0 ? (totalFound / totalExpected) * 100 : 0,
    zeroResultRate: totalNormal > 0 ? (zeroResults / totalNormal) * 100 : 0,
    outOfScopeAccuracy: outOfScopeResults.length > 0 ? (outOfScopeCorrect / outOfScopeResults.length) * 100 : 0,
    meanReciprocalRank: totalNormal > 0
      ? normalResults.reduce((sum, result) => sum + result.reciprocalRank, 0) / totalNormal
      : 0,
    tagStats,
    missed: normalResults.filter(result => !result.hit),
  };
}

// =============================================================================
// Format report as string (no console.log — caller decides output)
// =============================================================================

export function formatReport(metrics: IEvalMetricsProps): string {
  const lines: string[] = [];

  lines.push('='.repeat(60));
  lines.push('Results');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Test cases:          ${metrics.totalCases} total (${metrics.normalCases} normal, ${metrics.outOfScopeCases} out-of-scope)`);
  lines.push('');
  lines.push('METRICS:');
  lines.push(`  Hit rate:              ${metrics.hitRate.toFixed(1)}% (${metrics.hits}/${metrics.normalCases} queries found at least one expected doc)`);
  lines.push(`  First-result accuracy: ${metrics.firstResultAccuracy.toFixed(1)}% (${metrics.firstResultHits}/${metrics.normalCases} queries had correct #1 result)`);
  lines.push(`  Recall:                ${metrics.recall.toFixed(1)}% (${metrics.totalFound}/${metrics.totalExpected} expected docs found across all queries)`);
  lines.push(`  Zero-result rate:      ${metrics.zeroResultRate.toFixed(1)}% (${metrics.zeroResults}/${metrics.normalCases} queries returned nothing)`);
  lines.push(`  Out-of-scope accuracy: ${metrics.outOfScopeAccuracy.toFixed(1)}% (${metrics.outOfScopeCorrect}/${metrics.outOfScopeCases} correctly returned nothing)`);
  lines.push(`  Avg response time:     ${metrics.avgResponseTimeMs.toFixed(0)}ms`);
  lines.push(`  MRR:                   ${metrics.meanReciprocalRank.toFixed(3)} (1.0 = perfect ranking, 0.5 = avg position 2)`);
  lines.push('');

  if (metrics.missed.length > 0) {
    lines.push('MISSED QUERIES (expected doc not found in results):');
    for (const miss of metrics.missed) {
      lines.push(`  "${miss.testCase.query}" — expected [${miss.testCase.expected_doc_ids.join(', ')}], got [${miss.returnedIds.slice(0, 5).join(', ')}]`);
    }
    lines.push('');
  }

  lines.push('BY TAG:');
  const sortedTags = Object.entries(metrics.tagStats).sort((entryA, entryB) => entryB[1].total - entryA[1].total);
  for (const [tag, stats] of sortedTags) {
    const hitPercentage = ((stats.hits / stats.total) * 100).toFixed(0);
    const firstResultPercentage = ((stats.firstHits / stats.total) * 100).toFixed(0);
    lines.push(`  ${tag}: ${hitPercentage}% hit rate, ${firstResultPercentage}% first-result (${stats.total} queries)`);
  }

  lines.push('');
  lines.push('='.repeat(60));

  return lines.join('\n');
}

// =============================================================================
// Run comparison types
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

export interface IComparableMetricsProps {
  hitRate: number;
  firstResultAccuracy: number;
  recall: number;
  zeroResultRate: number;
  meanReciprocalRank: number;
  avgResponseTimeMs: number;
}

// =============================================================================
// compareRuns — diff two eval runs and detect regressions
// =============================================================================

const INVERTED_METRICS = new Set(['zeroResultRate', 'avgResponseTimeMs']);
const UNCHANGED_THRESHOLD = 0.01;

export function compareRuns(
  current: IComparableMetricsProps,
  previous: IComparableMetricsProps,
): IEvalComparisonProps {
  const metricKeys: Array<keyof IComparableMetricsProps> = [
    'hitRate',
    'firstResultAccuracy',
    'recall',
    'zeroResultRate',
    'meanReciprocalRank',
    'avgResponseTimeMs',
  ];

  const improvements: IMetricDiffProps[] = [];
  const regressions: IMetricDiffProps[] = [];
  const unchanged: IMetricDiffProps[] = [];

  for (const metricKey of metricKeys) {
    const currentValue = current[metricKey];
    const previousValue = previous[metricKey];
    const diff = currentValue - previousValue;

    const metricDiff: IMetricDiffProps = {
      metric: metricKey,
      current: currentValue,
      previous: previousValue,
      diff,
    };

    if (Math.abs(diff) < UNCHANGED_THRESHOLD) {
      unchanged.push(metricDiff);
      continue;
    }

    const isInverted = INVERTED_METRICS.has(metricKey);
    // For normal metrics: positive diff = improvement. For inverted: negative diff = improvement.
    const isImprovement = isInverted ? diff < 0 : diff > 0;

    if (isImprovement) {
      improvements.push(metricDiff);
    } else {
      regressions.push(metricDiff);
    }
  }

  const severity = determineSeverity(current, regressions);

  return { improvements, regressions, unchanged, severity };
}

function determineSeverity(
  current: IComparableMetricsProps,
  regressions: IMetricDiffProps[],
): ComparisonSeverity {
  if (current.hitRate < 80 || current.zeroResultRate > 10) {
    return 'critical';
  }

  if (regressions.length === 0) {
    return 'ok';
  }

  // Worst regression drop: for normal metrics use |diff| (diff is negative for regressions),
  // for inverted metrics use |diff| (diff is positive for regressions).
  // In both cases Math.abs(diff) gives the magnitude of the drop.
  const worstDrop = regressions.reduce((maxDrop, regression) => {
    const dropMagnitude = Math.abs(regression.diff);
    return dropMagnitude > maxDrop ? dropMagnitude : maxDrop;
  }, 0);

  if (worstDrop > 5) return 'block';
  if (worstDrop > 2) return 'warning';
  return 'ok';
}

// =============================================================================
// formatComparison — human-readable comparison report
// =============================================================================

const PERCENTAGE_METRICS = new Set(['hitRate', 'firstResultAccuracy', 'recall', 'zeroResultRate']);

function formatMetricValue(metricKey: string, value: number): string {
  if (metricKey === 'meanReciprocalRank') return value.toFixed(3);
  if (PERCENTAGE_METRICS.has(metricKey)) return `${value.toFixed(1)}%`;
  return value.toFixed(1);
}

export function formatComparison(comparison: IEvalComparisonProps): string {
  const lines: string[] = [];

  lines.push('='.repeat(60));
  lines.push(`Run Comparison — severity: ${comparison.severity}`);
  lines.push('='.repeat(60));
  lines.push('');

  if (comparison.improvements.length > 0) {
    lines.push('IMPROVEMENTS:');
    for (const metricDiff of comparison.improvements) {
      const previousFormatted = formatMetricValue(metricDiff.metric, metricDiff.previous);
      const currentFormatted = formatMetricValue(metricDiff.metric, metricDiff.current);
      const diffFormatted = formatMetricValue(metricDiff.metric, Math.abs(metricDiff.diff));
      lines.push(`  ${metricDiff.metric}: ${previousFormatted} → ${currentFormatted} (+${diffFormatted})`);
    }
    lines.push('');
  }

  if (comparison.regressions.length > 0) {
    lines.push('REGRESSIONS:');
    for (const metricDiff of comparison.regressions) {
      const previousFormatted = formatMetricValue(metricDiff.metric, metricDiff.previous);
      const currentFormatted = formatMetricValue(metricDiff.metric, metricDiff.current);
      const diffFormatted = formatMetricValue(metricDiff.metric, Math.abs(metricDiff.diff));
      lines.push(`  ${metricDiff.metric}: ${previousFormatted} → ${currentFormatted} (-${diffFormatted})`);
    }
    lines.push('');
  }

  if (comparison.unchanged.length > 0) {
    lines.push('UNCHANGED:');
    for (const metricDiff of comparison.unchanged) {
      const currentFormatted = formatMetricValue(metricDiff.metric, metricDiff.current);
      lines.push(`  ${metricDiff.metric}: ${currentFormatted}`);
    }
    lines.push('');
  }

  lines.push('='.repeat(60));

  return lines.join('\n');
}
