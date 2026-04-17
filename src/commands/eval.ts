import { randomUUID } from 'node:crypto';
import type { LedgerConfig } from '../lib/config.js';
import type { IClientsProps } from '../lib/documents/classification.js';
import { searchHybrid } from '../lib/search/ai-search.js';
import { scoreTestCase, computeMetrics, formatReport, compareRuns, formatComparison } from '../lib/eval/eval.js';
import type { IGoldenTestCaseProps, ITestResultProps } from '../lib/eval/eval.js';
import { saveEvalRun, loadPreviousRun, loadEvalRun, CURRENT_SEARCH_CONFIG } from '../lib/eval/eval-store.js';
import { computeConfidenceIntervals, computeScoreCalibration, computeCoverageAnalysis, formatAdvancedReport } from '../lib/eval/eval-advanced.js';
import { runEvalTrace, runEvalQuerySpan, startSpan } from '../lib/observability.js';

// =============================================================================
// Interfaces
// =============================================================================

export interface IEvalOptionsProps {
  dryRun: boolean;
}

export interface ISweepOptionsProps {
  thresholds: string;
}

export interface IShowOptionsProps {
  full: boolean;
}

// Search config imported from eval-store.ts (single source of truth)

// =============================================================================
// Command
// =============================================================================

export async function evalSearch(config: LedgerConfig, options: IEvalOptionsProps): Promise<void> {
  // Tag every search trace from this eval run with environment=eval and a
  // shared session ID so the Langfuse dashboard can filter eval traffic from
  // prod and group all queries in this run under one session.
  const evalRunUuid = randomUUID();
  const clients: IClientsProps = {
    supabase:                 config.supabase,
    openai:                   config.openai,
    cohereApiKey:             config.cohereApiKey,
    sessionId:                `eval-${evalRunUuid}`,
    observabilityEnvironment: 'eval',
  };

  console.log('\n' + '='.repeat(60));
  console.log('Ledger Search Evaluation');
  if (options.dryRun) console.log('(dry run — results will not be saved)');
  console.log('='.repeat(60) + '\n');

  const previousRun = await loadPreviousRun(clients.supabase);
  if (previousRun) {
    console.log(`Previous run: ${previousRun.run_date} (id: ${previousRun.id})\n`);
  } else {
    console.log('No previous run found — this will be the first stored run.\n');
  }

  const { data: testCases, error } = await clients.supabase
    .from('eval_golden_dataset')
    .select('id, query, tags, judgments:eval_golden_judgments(document_id, grade)')
    .order('id');

  if (error || !testCases) {
    process.stderr.write(`Failed to load golden dataset: ${(error as { message: string } | null)?.message ?? 'no data'}\n`);
    process.exit(1);
  }

  console.log(`Loaded ${(testCases as IGoldenTestCaseProps[]).length} test cases.\n`);

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
          .filter(judgment => judgment.grade >= 2)
          .map(judgment => judgment.document_id),
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

    let comparisonSeverity = 'none';
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
}

// =============================================================================
// Threshold sweep — test multiple thresholds to find optimal value
// =============================================================================

/**
 * Run the golden dataset at multiple similarity thresholds and compare.
 * Prints a table showing how each metric changes with the threshold.
 *
 * Usage: ledger eval:sweep
 *        ledger eval:sweep --thresholds 0.15,0.20,0.25,0.30,0.35,0.40
 */
export async function sweepThreshold(config: LedgerConfig, options: ISweepOptionsProps): Promise<void> {
  const sweepRunUuid = randomUUID();
  const clients: IClientsProps = {
    supabase:                 config.supabase,
    openai:                   config.openai,
    cohereApiKey:             config.cohereApiKey,
    sessionId:                `eval-sweep-${sweepRunUuid}`,
    observabilityEnvironment: 'eval',
  };

  const thresholds = options.thresholds
    .split(',')
    .map(value => parseFloat(value.trim()))
    .filter(value => !isNaN(value) && value > 0 && value < 1);

  if (thresholds.length === 0) {
    console.error('No valid thresholds provided. Use comma-separated values like: 0.15,0.20,0.25');
    process.exit(1);
  }

  const { data: testCases, error } = await clients.supabase
    .from('eval_golden_dataset')
    .select('id, query, tags, judgments:eval_golden_judgments(document_id, grade)')
    .order('id');

  if (error || !testCases) {
    console.error('Failed to load golden dataset:', (error as { message: string } | null)?.message ?? 'no data');
    process.exit(1);
  }

  const goldenCases = testCases as IGoldenTestCaseProps[];
  const normalCount = goldenCases.filter(
    testCase => testCase.judgments.some(judgment => judgment.grade >= 2),
  ).length;
  console.log(`\nLoaded ${goldenCases.length} test cases (${normalCount} normal)\n`);

  console.log('threshold | hit_rate | first_result | recall   | MRR    | NDCG   | avg_ms');
  console.log('----------|----------|--------------|----------|--------|--------|-------');

  for (const threshold of thresholds) {
    const results: ITestResultProps[] = [];

    for (const testCase of goldenCases) {
      const startTime = Date.now();
      const searchResults = await searchHybrid(clients, {
        query: testCase.query,
        limit: CURRENT_SEARCH_CONFIG.limit as number,
        threshold,
        reranker: CURRENT_SEARCH_CONFIG.reranker as 'none' | 'cohere',
      });
      results.push(scoreTestCase(testCase, searchResults, Date.now() - startTime));
    }

    const metrics = computeMetrics(results);
    // metrics.hitRate etc are already percentages (0-100) from computeMetrics
    console.log(
      `${threshold.toFixed(2).padStart(9)} | ` +
      `${metrics.hitRate.toFixed(1).padStart(6)}% | ` +
      `${metrics.firstResultAccuracy.toFixed(1).padStart(10)}% | ` +
      `${metrics.recall.toFixed(1).padStart(6)}% | ` +
      `${metrics.meanReciprocalRank.toFixed(3).padStart(6)} | ` +
      `${metrics.normalizedDiscountedCumulativeGain.toFixed(3).padStart(6)} | ` +
      `${metrics.avgResponseTimeMs.toFixed(0).padStart(5)}`
    );
  }

  console.log(`\nCurrent threshold: ${CURRENT_SEARCH_CONFIG.threshold}`);
}

// =============================================================================
// Show — inspect a saved eval run, focused on missed queries
// =============================================================================

interface IDocLookupProps {
  id:      number;
  name:    string;
  snippet: string;
}

async function fetchDocLookup(
  supabase: IClientsProps['supabase'],
  docIds:   number[],
): Promise<Map<number, IDocLookupProps>> {
  const lookup = new Map<number, IDocLookupProps>();
  if (docIds.length === 0) return lookup;

  const { data, error } = await supabase
    .from('documents')
    .select('id, name, content')
    .in('id', docIds);

  if (error || !data) return lookup;

  for (const documentRow of data as Array<{ id: number; name: string; content: string | null }>) {
    const content = documentRow.content ?? '';
    const snippet = content.replace(/\s+/g, ' ').slice(0, 140);
    lookup.set(documentRow.id, { id: documentRow.id, name: documentRow.name, snippet });
  }
  return lookup;
}

export async function showEvalRun(
  config:  LedgerConfig,
  runId:   number,
  options: IShowOptionsProps,
): Promise<void> {
  const supabase = config.supabase;

  const run = await loadEvalRun(supabase, runId);
  if (!run) {
    process.stderr.write(`Eval run ${runId} not found\n`);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Eval Run ${run.id} — ${run.run_date}`);
  console.log('='.repeat(60));
  console.log(`Test cases:        ${run.test_case_count}`);
  console.log(`Hit rate:          ${run.hit_rate.toFixed(1)}%`);
  console.log(`First-result acc:  ${run.first_result_accuracy.toFixed(1)}%`);
  console.log(`Recall:            ${run.recall.toFixed(1)}%`);
  console.log(`MRR:               ${(run.mean_reciprocal_rank ?? 0).toFixed(3)}`);
  console.log(`NDCG:              ${(run.normalized_discounted_cumulative_gain ?? 0).toFixed(3)}`);
  console.log(`Zero-result rate:  ${run.zero_result_rate.toFixed(1)}%`);
  console.log(`Avg response (ms): ${run.avg_response_time_ms.toFixed(0)}`);

  const missedQueries = run.missed_queries ?? [];
  console.log(`\nMissed queries: ${missedQueries.length}\n`);

  if (missedQueries.length === 0) {
    console.log('  (none)');
    return;
  }

  // Support both the new graded shape (judgments) and the legacy binary shape
  // (expected) so eval:show still works against historical runs.
  const expectedDocsFor = (missedQuery: Record<string, unknown>): Array<{ id: number; grade?: number }> => {
    const judgments = missedQuery.judgments as Array<{ document_id: number; grade: number }> | undefined;
    if (judgments && judgments.length > 0) {
      return judgments
        .filter(judgment => judgment.grade >= 2)
        .map(judgment => ({ id: judgment.document_id, grade: judgment.grade }));
    }
    const expected = missedQuery.expected as number[] | undefined;
    return (expected ?? []).map(id => ({ id }));
  };

  // Resolve doc ids → names + snippets in one batch
  const allDocIds = new Set<number>();
  for (const missedQuery of missedQueries) {
    for (const expected of expectedDocsFor(missedQuery as unknown as Record<string, unknown>)) allDocIds.add(expected.id);
    for (const returnedId of missedQuery.got.slice(0, 3)) allDocIds.add(returnedId);
  }
  const lookup = await fetchDocLookup(supabase, Array.from(allDocIds));

  const formatDoc = (docId: number, score?: number): string => {
    const document    = lookup.get(docId);
    const documentName = document?.name ?? '<unknown>';
    const scoreLabel  = score !== undefined ? ` (${score.toFixed(3)})` : '';
    return `#${docId} ${documentName}${scoreLabel}`;
  };

  for (const [missedIndex, missedQuery] of missedQueries.entries()) {
    console.log(`[${missedIndex + 1}] "${missedQuery.query}"`);
    if (missedQuery.tags.length > 0) console.log(`    tags: ${missedQuery.tags.join(', ')}`);

    const expectedDocs = expectedDocsFor(missedQuery as unknown as Record<string, unknown>);
    console.log(`    expected:`);
    for (const expected of expectedDocs) {
      const gradeLabel = expected.grade !== undefined ? ` (grade ${expected.grade})` : '';
      console.log(`      - ${formatDoc(expected.id)}${gradeLabel}`);
    }

    if (missedQuery.got.length === 0) {
      console.log(`    got: (none — zero results)`);
    } else {
      console.log(`    got (top 3):`);
      const topReturned = Math.min(3, missedQuery.got.length);
      for (let position = 0; position < topReturned; position++) {
        console.log(`      ${position + 1}. ${formatDoc(missedQuery.got[position], missedQuery.gotScores[position])}`);
      }
      const topDoc = lookup.get(missedQuery.got[0]);
      if (topDoc?.snippet) console.log(`    top1 snippet: "${topDoc.snippet}…"`);
    }
    console.log('');
  }

  if (options.full && run.per_query_results) {
    console.log('='.repeat(60));
    console.log('Per-query results (full)');
    console.log('='.repeat(60));
    for (const queryResult of run.per_query_results) {
      console.log(JSON.stringify(queryResult));
    }
  }
}
