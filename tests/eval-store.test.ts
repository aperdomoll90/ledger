import { describe, it, expect, vi } from 'vitest';
import { saveEvalRun, loadPreviousRun } from '../src/lib/eval/eval-store.js';
import type { IEvalMetricsProps, ITestResultProps } from '../src/lib/eval/eval.js';

/**
 * Creates a mock Supabase client for eval_runs queries.
 *
 * saveEvalRun chain: from → insert → select → single
 * loadPreviousRun chain: from → select → order → limit → single
 */
function createMockSupabase(resolveWith: { data: any; error: any }) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(resolveWith),
    then: vi.fn((resolve: any) => resolve(resolveWith)),
  };

  return { from: vi.fn().mockReturnValue(chain), _chain: chain } as any;
}

// Minimal metrics fixture
const sampleMetrics: IEvalMetricsProps = {
  totalCases: 10,
  normalCases: 8,
  outOfScopeCases: 2,
  hits: 6,
  firstResultHits: 5,
  totalExpected: 12,
  totalFound: 9,
  zeroResults: 1,
  outOfScopeCorrect: 2,
  avgResponseTimeMs: 120.5,
  hitRate: 75.0,
  firstResultAccuracy: 62.5,
  recall: 75.0,
  zeroResultRate: 12.5,
  outOfScopeAccuracy: 100.0,
  meanReciprocalRank: 0.75,
  normalizedDiscountedCumulativeGain: 0.80,
  tagStats: { search: { total: 4, hits: 3, firstHits: 2 } },
  missed: [],
};

const sampleResult: ITestResultProps = {
  testCase: {
    id:        1,
    query:     'test query',
    tags:      ['search'],
    judgments: [{ document_id: 42, grade: 3 }],
  },
  returnedIds: [42, 99],
  returnedScores: [0.9, 0.7],
  hit: true,
  firstResultHit: true,
  expectedFound: 1,
  expectedTotal: 1,
  position: 0,
  responseTimeMs: 110,
  reciprocalRank: 1.0,
  normalizedDiscountedCumulativeGain: 1.0,
};

const sampleConfig = { threshold: 0.4, reciprocalRankFusionK: 60, embedding_model: 'text-embedding-3-small' };

describe('saveEvalRun', () => {
  it('inserts row with correct metrics mapping and returns the new id', async () => {
    const supabase = createMockSupabase({ data: { id: 7 }, error: null });

    const id = await saveEvalRun(supabase, {
      metrics: sampleMetrics,
      config: sampleConfig,
      results: [sampleResult],
    });

    expect(id).toBe(7);
    expect(supabase.from).toHaveBeenCalledWith('eval_runs');
    expect(supabase._chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        config: sampleConfig,
        test_case_count: sampleMetrics.totalCases,
        hit_rate: sampleMetrics.hitRate,
        first_result_accuracy: sampleMetrics.firstResultAccuracy,
        recall: sampleMetrics.recall,
        zero_result_rate: sampleMetrics.zeroResultRate,
        avg_response_time_ms: sampleMetrics.avgResponseTimeMs,
        mean_reciprocal_rank: sampleMetrics.meanReciprocalRank,
        normalized_discounted_cumulative_gain: sampleMetrics.normalizedDiscountedCumulativeGain,
      }),
    );
    expect(supabase._chain.select).toHaveBeenCalledWith('id');
    expect(supabase._chain.single).toHaveBeenCalled();
  });

  it('includes results_by_tag, missed_queries, and per_query_results as JSONB', async () => {
    const supabase = createMockSupabase({ data: { id: 3 }, error: null });

    await saveEvalRun(supabase, {
      metrics: sampleMetrics,
      config: sampleConfig,
      results: [sampleResult],
    });

    const insertedRow = supabase._chain.insert.mock.calls[0][0];
    expect(insertedRow.results_by_tag).toEqual(sampleMetrics.tagStats);
    expect(insertedRow.missed_queries).toEqual(
      sampleMetrics.missed.map(missedResult => ({
        query:     missedResult.testCase.query,
        tags:      missedResult.testCase.tags,
        judgments: missedResult.testCase.judgments,
        got:       missedResult.returnedIds,
        gotScores: missedResult.returnedScores,
      })),
    );
    expect(insertedRow.per_query_results).toHaveLength(1);
    expect(insertedRow.per_query_results[0]).toMatchObject({
      query:                              sampleResult.testCase.query,
      tags:                               sampleResult.testCase.tags,
      judgments:                          sampleResult.testCase.judgments,
      normalizedDiscountedCumulativeGain: sampleResult.normalizedDiscountedCumulativeGain,
      returnedScores:                     sampleResult.returnedScores,
    });
  });

  it('throws on database error', async () => {
    const supabase = createMockSupabase({ data: null, error: { message: 'insert failed' } });

    await expect(
      saveEvalRun(supabase, { metrics: sampleMetrics, config: sampleConfig, results: [] }),
    ).rejects.toThrow('insert failed');
  });
});

describe('loadPreviousRun', () => {
  it('returns the most recent run ordered by run_date DESC', async () => {
    const row = { id: 5, run_date: '2026-04-01T00:00:00Z', hit_rate: 80.0, config: sampleConfig };
    const supabase = createMockSupabase({ data: row, error: null });

    const result = await loadPreviousRun(supabase);

    expect(result).toEqual(row);
    expect(supabase.from).toHaveBeenCalledWith('eval_runs');
    expect(supabase._chain.select).toHaveBeenCalledWith('*');
    expect(supabase._chain.order).toHaveBeenCalledWith('run_date', { ascending: false });
    expect(supabase._chain.limit).toHaveBeenCalledWith(1);
    expect(supabase._chain.single).toHaveBeenCalled();
  });

  it('returns null when no runs exist', async () => {
    const supabase = createMockSupabase({ data: null, error: { code: 'PGRST116', message: 'no rows' } });

    const result = await loadPreviousRun(supabase);

    expect(result).toBeNull();
  });
});
