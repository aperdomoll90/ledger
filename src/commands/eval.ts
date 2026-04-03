import type { LedgerConfig } from '../lib/config.js';
import type { IClientsProps } from '../lib/documents/classification.js';
import { searchHybrid } from '../lib/search/ai-search.js';
import { scoreTestCase, computeMetrics, formatReport, compareRuns, formatComparison } from '../lib/eval/eval.js';
import type { IGoldenTestCaseProps, ITestResultProps } from '../lib/eval/eval.js';
import { saveEvalRun, loadPreviousRun, CURRENT_SEARCH_CONFIG } from '../lib/eval/eval-store.js';
import { computeConfidenceIntervals, computeScoreCalibration, computeCoverageAnalysis, formatAdvancedReport } from '../lib/eval/eval-advanced.js';

// =============================================================================
// Interfaces
// =============================================================================

export interface IEvalOptionsProps {
  dryRun: boolean;
}

export interface ISweepOptionsProps {
  thresholds: string;
}

// Search config imported from eval-store.ts (single source of truth)

// =============================================================================
// Command
// =============================================================================

export async function evalSearch(config: LedgerConfig, options: IEvalOptionsProps): Promise<void> {
  const clients: IClientsProps = {
    supabase:     config.supabase,
    openai:       config.openai,
    cohereApiKey: config.cohereApiKey,
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
    .select('id, query, expected_doc_ids, tags')
    .order('id');

  if (error || !testCases) {
    process.stderr.write(`Failed to load golden dataset: ${(error as { message: string } | null)?.message ?? 'no data'}\n`);
    process.exit(1);
  }

  console.log(`Loaded ${(testCases as IGoldenTestCaseProps[]).length} test cases.\n`);

  const results: ITestResultProps[] = [];

  for (const testCase of testCases as IGoldenTestCaseProps[]) {
    const startTime = Date.now();
    const searchResults = await searchHybrid(clients, {
      query: testCase.query,
      limit: CURRENT_SEARCH_CONFIG.limit as number,
      reranker: CURRENT_SEARCH_CONFIG.reranker as 'none' | 'cohere',
    });
    const result = scoreTestCase(testCase, searchResults, Date.now() - startTime);
    results.push(result);

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

  const metrics = computeMetrics(results);
  console.log('\n' + formatReport(metrics));

  // Compute advanced analysis before saving so everything is persisted
  const confidenceIntervals = computeConfidenceIntervals(results);
  const scoreCalibration = computeScoreCalibration(results);
  const coverageAnalysis = computeCoverageAnalysis(results);

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
  }

  console.log('\n' + formatAdvancedReport(confidenceIntervals, scoreCalibration, coverageAnalysis));
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
  const clients: IClientsProps = {
    supabase:     config.supabase,
    openai:       config.openai,
    cohereApiKey: config.cohereApiKey,
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
    .select('id, query, expected_doc_ids, tags')
    .order('id');

  if (error || !testCases) {
    console.error('Failed to load golden dataset:', (error as { message: string } | null)?.message ?? 'no data');
    process.exit(1);
  }

  const goldenCases = testCases as IGoldenTestCaseProps[];
  const normalCount = goldenCases.filter(testCase => testCase.expected_doc_ids.length > 0).length;
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
