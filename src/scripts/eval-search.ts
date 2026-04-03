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
import { saveEvalRun, loadPreviousRun, CURRENT_SEARCH_CONFIG } from '../lib/eval/eval-store.js';
import { computeConfidenceIntervals, computeScoreCalibration, computeCoverageAnalysis, formatAdvancedReport } from '../lib/eval/eval-advanced.js';

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

// Search config imported from eval-store.ts (single source of truth)

// =============================================================================
// Run eval
// =============================================================================

async function runEval(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Ledger Search Evaluation');
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
    console.error('Failed to load golden dataset:', error?.message);
    process.exit(1);
  }

  console.log(`Loaded ${testCases.length} test cases.\n`);

  const results: ITestResultProps[] = [];

  for (const testCase of testCases as IGoldenTestCaseProps[]) {
    const startTime = Date.now();
    const searchResults = await searchHybrid(clients, { query: testCase.query, limit: 10 });
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

  const metrics = computeMetrics(results);
  console.log('\n' + formatReport(metrics));

  // Compute advanced analysis before saving so everything is persisted
  const confidenceIntervals = computeConfidenceIntervals(results);
  const scoreCalibration = computeScoreCalibration(results);
  const coverageAnalysis = computeCoverageAnalysis(results);

  const runId = await saveEvalRun(clients.supabase, {
    metrics,
    config: CURRENT_SEARCH_CONFIG,
    results,
    confidenceIntervals,
    scoreCalibration,
    coverageAnalysis,
  });
  console.log(`\nRun saved to eval_runs (id: ${runId})`);

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

runEval().catch((error) => {
  console.error('Eval crashed:', error);
  process.exit(1);
});
