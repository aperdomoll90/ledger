// eval-store.ts
// Persistence layer for eval runs — save results to eval_runs table and load previous runs.

import type { ISupabaseClientProps } from '../documents/classification.js';
import type { IEvalMetricsProps, ITestResultProps } from './eval.js';
import type { IMetricConfidenceIntervalsProps, IScoreCalibrationProps, ICoverageAnalysisProps } from './eval-advanced.js';

// =============================================================================
// Interfaces
// =============================================================================

export interface IEvalConfigProps {
  threshold:              number;
  reciprocalRankFusionK:  number;
  embedding_model:        string;
  [key: string]:          unknown;
}

/**
 * Current search configuration. Saved with each eval run for reproducibility.
 * Single source of truth — used by both the eval script and CLI command.
 * Update this when search parameters change (threshold, model, reranker, etc.).
 */
export const CURRENT_SEARCH_CONFIG: IEvalConfigProps = {
  threshold:                0.38,
  reciprocalRankFusionK:    60,
  embedding_model:          'openai/text-embedding-3-small',
  limit:                    10,
  chunking:                 'recursive',
  chunk_max_size:           1000,
  chunk_overlap:            200,
  context_enrichment:       true,
  context_enrichment_model: 'gpt-4o-mini',
  reranker:                 'none',
};

export interface ISaveEvalRunProps {
  metrics:                IEvalMetricsProps;
  config:                 IEvalConfigProps | Record<string, unknown>;
  results:                ITestResultProps[];
  confidenceIntervals?:   IMetricConfidenceIntervalsProps;
  scoreCalibration?:      IScoreCalibrationProps;
  coverageAnalysis?:      ICoverageAnalysisProps;
}

export interface IEvalRunRowProps {
  id:                                    number;
  run_date:                              string;
  config:                                IEvalConfigProps | Record<string, unknown>;
  test_case_count:                       number;
  hit_rate:                              number;
  first_result_accuracy:                 number;
  recall:                                number;
  zero_result_rate:                      number;
  avg_response_time_ms:                  number;
  mean_reciprocal_rank:                  number | null;
  normalized_discounted_cumulative_gain: number | null;
  results_by_tag:                        Record<string, { total: number; hits: number; firstHits: number }> | null;
  missed_queries:                        Array<{ query: string; tags: string[]; expected: number[]; got: number[]; gotScores: number[] }> | null;
  per_query_results:                     Array<Record<string, unknown>> | null;
  confidence_intervals:                  IMetricConfidenceIntervalsProps | null;
  score_calibration:                     IScoreCalibrationProps | null;
  coverage_analysis:                     ICoverageAnalysisProps | null;
}

// =============================================================================
// Save
// =============================================================================

export async function saveEvalRun(
  supabase: ISupabaseClientProps,
  props: ISaveEvalRunProps,
): Promise<number> {
  const { metrics, config, results, confidenceIntervals, scoreCalibration, coverageAnalysis } = props;

  const row = {
    config,
    test_case_count:                       metrics.totalCases,
    hit_rate:                              metrics.hitRate,
    first_result_accuracy:                 metrics.firstResultAccuracy,
    recall:                                metrics.recall,
    zero_result_rate:                      metrics.zeroResultRate,
    avg_response_time_ms:                  metrics.avgResponseTimeMs,
    mean_reciprocal_rank:                  metrics.meanReciprocalRank,
    normalized_discounted_cumulative_gain: metrics.normalizedDiscountedCumulativeGain,
    confidence_intervals:                  confidenceIntervals ?? null,
    score_calibration:                     scoreCalibration ?? null,
    coverage_analysis:                     coverageAnalysis ?? null,
    results_by_tag:                        metrics.tagStats,
    missed_queries:        metrics.missed.map(missedResult => ({
      query:          missedResult.testCase.query,
      tags:           missedResult.testCase.tags,
      expected:       missedResult.testCase.expected_doc_ids,
      got:            missedResult.returnedIds,
      gotScores:      missedResult.returnedScores,
    })),
    per_query_results: results.map(testResult => ({
      query:                              testResult.testCase.query,
      tags:                               testResult.testCase.tags,
      expectedDocIds:                     testResult.testCase.expected_doc_ids,
      hit:                                testResult.hit,
      firstResultHit:                     testResult.firstResultHit,
      position:                           testResult.position,
      expectedFound:                      testResult.expectedFound,
      expectedTotal:                      testResult.expectedTotal,
      responseTimeMs:                     testResult.responseTimeMs,
      reciprocalRank:                     testResult.reciprocalRank,
      normalizedDiscountedCumulativeGain: testResult.normalizedDiscountedCumulativeGain,
      returnedIds:                        testResult.returnedIds,
      returnedScores:                     testResult.returnedScores,
    })),
  };

  const { data, error } = await supabase
    .from('eval_runs')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return (data as { id: number }).id;
}

// =============================================================================
// Load
// =============================================================================

export async function loadPreviousRun(
  supabase: ISupabaseClientProps,
): Promise<IEvalRunRowProps | null> {
  const { data, error } = await supabase
    .from('eval_runs')
    .select('*')
    .order('run_date', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    return null;
  }

  return data as IEvalRunRowProps;
}

export async function loadEvalRun(
  supabase: ISupabaseClientProps,
  runId: number,
): Promise<IEvalRunRowProps | null> {
  const { data, error } = await supabase
    .from('eval_runs')
    .select('*')
    .eq('id', runId)
    .single();

  if (error) {
    return null;
  }

  return data as IEvalRunRowProps;
}
