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
    };
  }

  const foundExpected = testCase.expected_doc_ids.filter(expectedId =>
    returnedIds.includes(expectedId),
  );

  const firstExpectedPosition = testCase.expected_doc_ids
    .map(expectedId => returnedIds.indexOf(expectedId))
    .filter(position => position >= 0)
    .sort((a, b) => a - b)[0] ?? null;

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
  };
}

// =============================================================================
// Aggregate metrics from scored results
// =============================================================================

export function computeMetrics(results: ITestResultProps[]): IEvalMetricsProps {
  const normalResults = results.filter(r => r.testCase.expected_doc_ids.length > 0);
  const outOfScopeResults = results.filter(r => r.testCase.expected_doc_ids.length === 0);

  const totalNormal = normalResults.length;
  const hits = normalResults.filter(r => r.hit).length;
  const firstResultHits = normalResults.filter(r => r.firstResultHit).length;
  const totalExpected = normalResults.reduce((sum, r) => sum + r.expectedTotal, 0);
  const totalFound = normalResults.reduce((sum, r) => sum + r.expectedFound, 0);
  const zeroResults = normalResults.filter(r => r.returnedIds.length === 0).length;
  const outOfScopeCorrect = outOfScopeResults.filter(r => r.hit).length;
  const avgResponseTimeMs = results.length > 0
    ? results.reduce((sum, r) => sum + r.responseTimeMs, 0) / results.length
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
    tagStats,
    missed: normalResults.filter(r => !r.hit),
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
  lines.push('');

  if (metrics.missed.length > 0) {
    lines.push('MISSED QUERIES (expected doc not found in results):');
    for (const miss of metrics.missed) {
      lines.push(`  "${miss.testCase.query}" — expected [${miss.testCase.expected_doc_ids.join(', ')}], got [${miss.returnedIds.slice(0, 5).join(', ')}]`);
    }
    lines.push('');
  }

  lines.push('BY TAG:');
  const sortedTags = Object.entries(metrics.tagStats).sort((a, b) => b[1].total - a[1].total);
  for (const [tag, stats] of sortedTags) {
    const hitPct = ((stats.hits / stats.total) * 100).toFixed(0);
    const firstPct = ((stats.firstHits / stats.total) * 100).toFixed(0);
    lines.push(`  ${tag}: ${hitPct}% hit rate, ${firstPct}% first-result (${stats.total} queries)`);
  }

  lines.push('');
  lines.push('='.repeat(60));

  return lines.join('\n');
}
