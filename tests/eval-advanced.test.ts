// eval-advanced.test.ts
// Unit tests for eval-advanced.ts — computeConfidenceIntervals, bootstrap helpers.

import { describe, it, expect } from 'vitest';
import type { ISearchResultProps } from '../src/lib/search/ai-search.js';
import { scoreTestCase, type IGoldenTestCaseProps } from '../src/lib/eval/eval.js';
import { computeConfidenceIntervals, computeScoreCalibration } from '../src/lib/eval/eval-advanced.js';

// =============================================================================
// Helpers
// =============================================================================

function makeResult(id: number, score: number): ISearchResultProps {
  return {
    id,
    content: '',
    name: `doc-${id}`,
    domain: 'general',
    document_type: 'knowledge',
    project: null,
    protection: 'open',
    description: null,
    agent: null,
    status: null,
    file_path: null,
    skill_ref: null,
    owner_type: 'user',
    owner_id: null,
    is_auto_load: false,
    content_hash: null,
    score,
  };
}

function makeTestCase(id: number, expected_doc_ids: number[]): IGoldenTestCaseProps {
  return { id, query: `query-${id}`, expected_doc_ids, tags: [] };
}

// 20 test results: 16 hits, 4 misses — varied enough for non-trivial intervals
function buildMixedResults() {
  const testResults = [];

  // 16 hits: expected doc is first result
  for (let position = 1; position <= 16; position++) {
    const testCase = makeTestCase(position, [position]);
    const searchResults = [makeResult(position, 0.95), makeResult(99, 0.5)];
    testResults.push(scoreTestCase(testCase, searchResults, 50));
  }

  // 4 misses: expected doc not in results
  for (let position = 17; position <= 20; position++) {
    const testCase = makeTestCase(position, [position]);
    const searchResults = [makeResult(99, 0.5), makeResult(100, 0.4)];
    testResults.push(scoreTestCase(testCase, searchResults, 50));
  }

  return testResults;
}

// 20 perfect test results: all hits, expected doc always first
function buildPerfectResults() {
  const testResults = [];

  for (let position = 1; position <= 20; position++) {
    const testCase = makeTestCase(position, [position]);
    const searchResults = [makeResult(position, 0.99), makeResult(99, 0.5)];
    testResults.push(scoreTestCase(testCase, searchResults, 50));
  }

  return testResults;
}

// =============================================================================
// computeConfidenceIntervals — structure
// =============================================================================

describe('computeConfidenceIntervals — structure', () => {
  it('returns intervals for all 6 metrics', () => {
    const testResults = buildMixedResults();
    const intervals = computeConfidenceIntervals(testResults, 100);

    expect(intervals).toHaveProperty('hitRate');
    expect(intervals).toHaveProperty('firstResultAccuracy');
    expect(intervals).toHaveProperty('recall');
    expect(intervals).toHaveProperty('zeroResultRate');
    expect(intervals).toHaveProperty('meanReciprocalRank');
    expect(intervals).toHaveProperty('normalizedDiscountedCumulativeGain');
  });

  it('each interval has point, lower, upper, width fields', () => {
    const testResults = buildMixedResults();
    const intervals = computeConfidenceIntervals(testResults, 100);

    for (const key of Object.keys(intervals) as Array<keyof typeof intervals>) {
      const interval = intervals[key];
      expect(interval).toHaveProperty('point');
      expect(interval).toHaveProperty('lower');
      expect(interval).toHaveProperty('upper');
      expect(interval).toHaveProperty('width');
    }
  });
});

// =============================================================================
// computeConfidenceIntervals — correctness
// =============================================================================

describe('computeConfidenceIntervals — correctness', () => {
  it('width equals upper minus lower', () => {
    const testResults = buildMixedResults();
    const intervals = computeConfidenceIntervals(testResults, 100);

    for (const key of Object.keys(intervals) as Array<keyof typeof intervals>) {
      const interval = intervals[key];
      expect(interval.width).toBeCloseTo(interval.upper - interval.lower, 10);
    }
  });

  it('point estimate is within the interval (lower <= point <= upper)', () => {
    const testResults = buildMixedResults();
    const intervals = computeConfidenceIntervals(testResults, 100);

    for (const key of Object.keys(intervals) as Array<keyof typeof intervals>) {
      const interval = intervals[key];
      expect(interval.lower).toBeLessThanOrEqual(interval.point + 1e-10);
      expect(interval.upper).toBeGreaterThanOrEqual(interval.point - 1e-10);
    }
  });

  it('perfect results have tight intervals near 100% for hitRate', () => {
    const testResults = buildPerfectResults();
    const intervals = computeConfidenceIntervals(testResults, 100);

    expect(intervals.hitRate.lower).toBeGreaterThan(90);
    expect(intervals.hitRate.upper).toBeCloseTo(100, 0);
  });

  it('perfect results have tight intervals near 100% for firstResultAccuracy', () => {
    const testResults = buildPerfectResults();
    const intervals = computeConfidenceIntervals(testResults, 100);

    expect(intervals.firstResultAccuracy.lower).toBeGreaterThan(90);
    expect(intervals.firstResultAccuracy.upper).toBeCloseTo(100, 0);
  });
});

// =============================================================================
// computeScoreCalibration
// =============================================================================

describe('computeScoreCalibration', () => {
  it('computes separate stats for relevant and irrelevant results, relevant mean > irrelevant mean, correct counts', () => {
    // 4 results: each has 1 relevant doc (score 0.9) + 1 irrelevant doc (score 0.4)
    const testResults = [];
    for (let position = 1; position <= 4; position++) {
      const testCase = makeTestCase(position, [position]);
      const searchResults = [makeResult(position, 0.9), makeResult(99, 0.4)];
      testResults.push(scoreTestCase(testCase, searchResults, 50));
    }

    const calibration = computeScoreCalibration(testResults);

    expect(calibration.relevantScores.count).toBe(4);
    expect(calibration.irrelevantScores.count).toBe(4);
    expect(calibration.relevantScores.mean).toBeCloseTo(0.9, 5);
    expect(calibration.irrelevantScores.mean).toBeCloseTo(0.4, 5);
    expect(calibration.relevantScores.mean).toBeGreaterThan(calibration.irrelevantScores.mean);
  });

  it('handles no relevant results (all misses) — relevant count 0', () => {
    // All results return only docs that are NOT in expected_doc_ids
    const testResults = [];
    for (let position = 1; position <= 3; position++) {
      const testCase = makeTestCase(position, [position]);
      const searchResults = [makeResult(99, 0.6), makeResult(100, 0.5)];
      testResults.push(scoreTestCase(testCase, searchResults, 50));
    }

    const calibration = computeScoreCalibration(testResults);

    expect(calibration.relevantScores.count).toBe(0);
    expect(calibration.relevantScores.mean).toBe(0);
    expect(calibration.irrelevantScores.count).toBe(6);
  });

  it('separation is positive when relevant scores are higher', () => {
    const testResults = [];
    for (let position = 1; position <= 5; position++) {
      const testCase = makeTestCase(position, [position]);
      const searchResults = [makeResult(position, 0.85), makeResult(99, 0.3)];
      testResults.push(scoreTestCase(testCase, searchResults, 50));
    }

    const calibration = computeScoreCalibration(testResults);

    expect(calibration.separation).toBeGreaterThan(0);
    expect(calibration.separation).toBeCloseTo(
      calibration.relevantScores.mean - calibration.irrelevantScores.mean,
      10,
    );
  });
});
