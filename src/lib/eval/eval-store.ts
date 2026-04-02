// eval-store.ts
// Persistence layer for eval runs — save results to eval_runs table and load previous runs.

import type { ISupabaseClientProps } from '../documents/classification.js';
import type { IEvalMetricsProps, ITestResultProps } from './eval.js';

// =============================================================================
// Interfaces
// =============================================================================

export interface IEvalConfigProps {
  threshold:        number;
  reciprocalRankFusionK: number;
  embedding_model:  string;
  [key: string]:    unknown;
}

export interface ISaveEvalRunProps {
  metrics: IEvalMetricsProps;
  config:  IEvalConfigProps | Record<string, unknown>;
  results: ITestResultProps[];
}

export interface IEvalRunRowProps {
  id:                    number;
  run_date:              string;
  config:                IEvalConfigProps | Record<string, unknown>;
  test_case_count:       number;
  hit_rate:              number;
  first_result_accuracy: number;
  recall:                number;
  zero_result_rate:      number;
  avg_response_time_ms:  number;
  results_by_tag:        Record<string, { total: number; hits: number; firstHits: number }> | null;
  missed_queries:        Array<{ query: string; expected: number[]; got: number[] }> | null;
  per_query_results:     Array<Record<string, unknown>> | null;
}

// =============================================================================
// Save
// =============================================================================

export async function saveEvalRun(
  supabase: ISupabaseClientProps,
  props: ISaveEvalRunProps,
): Promise<number> {
  const { metrics, config, results } = props;

  const row = {
    config,
    test_case_count:       metrics.totalCases,
    hit_rate:              metrics.hitRate,
    first_result_accuracy: metrics.firstResultAccuracy,
    recall:                metrics.recall,
    zero_result_rate:      metrics.zeroResultRate,
    avg_response_time_ms:  metrics.avgResponseTimeMs,
    results_by_tag:        metrics.tagStats,
    missed_queries:        metrics.missed.map(missedResult => ({
      query:    missedResult.testCase.query,
      expected: missedResult.testCase.expected_doc_ids,
      got:      missedResult.returnedIds,
    })),
    per_query_results: results.map(testResult => ({
      query:            testResult.testCase.query,
      hit:              testResult.hit,
      firstResultHit:   testResult.firstResultHit,
      position:         testResult.position,
      expectedFound:    testResult.expectedFound,
      expectedTotal:    testResult.expectedTotal,
      responseTimeMs:   testResult.responseTimeMs,
      reciprocalRank:   testResult.reciprocalRank,
      returnedIds:      testResult.returnedIds,
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
