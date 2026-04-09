// eval-advanced.ts
// Advanced eval utilities — confidence intervals via bootstrap resampling,
// score calibration for relevant vs irrelevant result distributions.
// Pure functions — no I/O, no database calls.

import { computeMetrics, HIT_THRESHOLD, type ITestResultProps } from './eval.js';

// =============================================================================
// Types
// =============================================================================

export interface IScoreDistributionProps {
  count:  number;
  mean:   number;
  median: number;
  min:    number;
  max:    number;
}

export interface IScoreCalibrationProps {
  relevantScores:   IScoreDistributionProps;
  irrelevantScores: IScoreDistributionProps;
  separation:       number; // relevantScores.mean - irrelevantScores.mean
}

export interface ICoverageAnalysisProps {
  totalQueries:            number;
  normalCount:             number;
  outOfScopeCount:         number;
  totalTags:               number;
  queriesPerTag:           Record<string, number>;
  uniqueExpectedDocuments: number;
  expectedDocumentIds:     number[];
}

export interface IConfidenceIntervalProps {
  point: number;   // the actual metric value
  lower: number;   // 2.5th percentile
  upper: number;   // 97.5th percentile
  width: number;   // upper - lower
}

export interface IMetricConfidenceIntervalsProps {
  hitRate:             IConfidenceIntervalProps;
  firstResultAccuracy: IConfidenceIntervalProps;
  recall:              IConfidenceIntervalProps;
  zeroResultRate:      IConfidenceIntervalProps;
  meanReciprocalRank:  IConfidenceIntervalProps;
  normalizedDiscountedCumulativeGain:             IConfidenceIntervalProps;
}

// =============================================================================
// resampleWithReplacement
// =============================================================================

/**
 * Creates a new array of the same length by randomly picking items from the
 * original with replacement. Each position independently draws a random item,
 * so the same item may appear multiple times.
 */
export function resampleWithReplacement(results: ITestResultProps[]): ITestResultProps[] {
  const resampled: ITestResultProps[] = [];
  for (let sampleIndex = 0; sampleIndex < results.length; sampleIndex++) {
    const randomIndex = Math.floor(Math.random() * results.length);
    resampled.push(results[randomIndex]);
  }
  return resampled;
}

// =============================================================================
// percentile
// =============================================================================

/**
 * Computes the percentile of a sorted array using linear interpolation.
 * fraction=0.025 gives the 2.5th percentile; fraction=0.975 gives 97.5th.
 *
 * Assumes sortedValues is already sorted ascending.
 */
export function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0];

  const position = fraction * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];

  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];
  const fraction_ = position - lowerIndex;

  return lowerValue + fraction_ * (upperValue - lowerValue);
}

// =============================================================================
// buildInterval
// =============================================================================

/**
 * Sorts bootstrap values, computes the 2.5th and 97.5th percentiles, then
 * returns a complete IConfidenceIntervalProps with point estimate, lower,
 * upper, and width.
 */
export function buildInterval(
  bootstrapValues: number[],
  pointEstimate: number,
): IConfidenceIntervalProps {
  const sortedValues = [...bootstrapValues].sort((valueA, valueB) => valueA - valueB);
  const lower = percentile(sortedValues, 0.025);
  const upper = percentile(sortedValues, 0.975);
  return {
    point: pointEstimate,
    lower,
    upper,
    width: upper - lower,
  };
}

// =============================================================================
// computeConfidenceIntervals
// =============================================================================

/**
 * Computes 95% confidence intervals for all eval metrics using bootstrap
 * resampling.
 *
 * 1. Computes point estimates from actual results via computeMetrics().
 * 2. Runs `iterations` bootstrap rounds, each resampling with replacement.
 * 3. For each metric, sorts the collected bootstrap values and takes the
 *    2.5th and 97.5th percentiles as lower and upper bounds.
 */
export function computeConfidenceIntervals(
  results: ITestResultProps[],
  iterations: number = 1000,
): IMetricConfidenceIntervalsProps {
  const pointMetrics = computeMetrics(results);

  const bootstrapHitRates:             number[] = [];
  const bootstrapFirstResultAccuracies: number[] = [];
  const bootstrapRecalls:              number[] = [];
  const bootstrapZeroResultRates:      number[] = [];
  const bootstrapMeanReciprocalRanks:  number[] = [];
  const bootstrapNormalizedDiscountedCumulativeGainValues:        number[] = [];

  for (let iteration = 0; iteration < iterations; iteration++) {
    const resampledResults = resampleWithReplacement(results);
    const resampledMetrics = computeMetrics(resampledResults);

    bootstrapHitRates.push(resampledMetrics.hitRate);
    bootstrapFirstResultAccuracies.push(resampledMetrics.firstResultAccuracy);
    bootstrapRecalls.push(resampledMetrics.recall);
    bootstrapZeroResultRates.push(resampledMetrics.zeroResultRate);
    bootstrapMeanReciprocalRanks.push(resampledMetrics.meanReciprocalRank);
    bootstrapNormalizedDiscountedCumulativeGainValues.push(resampledMetrics.normalizedDiscountedCumulativeGain);
  }

  return {
    hitRate:             buildInterval(bootstrapHitRates,             pointMetrics.hitRate),
    firstResultAccuracy: buildInterval(bootstrapFirstResultAccuracies, pointMetrics.firstResultAccuracy),
    recall:              buildInterval(bootstrapRecalls,              pointMetrics.recall),
    zeroResultRate:      buildInterval(bootstrapZeroResultRates,      pointMetrics.zeroResultRate),
    meanReciprocalRank:  buildInterval(bootstrapMeanReciprocalRanks,  pointMetrics.meanReciprocalRank),
    normalizedDiscountedCumulativeGain:             buildInterval(bootstrapNormalizedDiscountedCumulativeGainValues,        pointMetrics.normalizedDiscountedCumulativeGain),
  };
}

// =============================================================================
// computeDistribution
// =============================================================================

/**
 * Computes summary statistics for an array of numeric scores.
 * Returns all-zero IScoreDistributionProps if the array is empty.
 * Median is the middle value of the sorted array, or the average of the two
 * middle values when the array has even length.
 */
export function computeDistribution(scores: number[]): IScoreDistributionProps {
  if (scores.length === 0) {
    return { count: 0, mean: 0, median: 0, min: 0, max: 0 };
  }

  const sorted = [...scores].sort((scoreA, scoreB) => scoreA - scoreB);
  const count = sorted.length;

  const sum = sorted.reduce((total, score) => total + score, 0);
  const mean = sum / count;

  const middleIndex = Math.floor(count / 2);
  const median = count % 2 === 1
    ? sorted[middleIndex]
    : (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;

  return {
    count,
    mean,
    median,
    min: sorted[0],
    max: sorted[count - 1],
  };
}

// =============================================================================
// computeScoreCalibration
// =============================================================================

/**
 * Separates scores into relevant (returned doc graded >= HIT_THRESHOLD) and
 * irrelevant buckets, then computes distribution stats for each.
 *
 * Out-of-scope results (no judgments at grade >= HIT_THRESHOLD) are skipped.
 * Separation = relevant mean − irrelevant mean.
 */
export function computeScoreCalibration(results: ITestResultProps[]): IScoreCalibrationProps {
  const relevantScoreValues:   number[] = [];
  const irrelevantScoreValues: number[] = [];

  for (const result of results) {
    const relevantDocIds = new Set(
      result.testCase.judgments
        .filter(judgment => judgment.grade >= HIT_THRESHOLD)
        .map(judgment => judgment.document_id),
    );

    if (relevantDocIds.size === 0) continue;

    for (let position = 0; position < result.returnedIds.length; position++) {
      const docId = result.returnedIds[position];
      const score = result.returnedScores[position];

      if (relevantDocIds.has(docId)) {
        relevantScoreValues.push(score);
      } else {
        irrelevantScoreValues.push(score);
      }
    }
  }

  const relevantScores   = computeDistribution(relevantScoreValues);
  const irrelevantScores = computeDistribution(irrelevantScoreValues);

  return {
    relevantScores,
    irrelevantScores,
    separation: relevantScores.mean - irrelevantScores.mean,
  };
}

// =============================================================================
// computeCoverageAnalysis
// =============================================================================

/**
 * Analyses golden set coverage — which parts of the knowledge base are
 * well-tested vs blind spots.
 *
 * - Normal queries: at least one judgment at grade >= HIT_THRESHOLD
 * - Out-of-scope queries: no judgments at grade >= HIT_THRESHOLD
 * - queriesPerTag: how many queries carry each tag
 * - expectedDocumentIds: deduplicated union of all grade>=HIT_THRESHOLD doc ids, sorted ascending
 */
export function computeCoverageAnalysis(results: ITestResultProps[]): ICoverageAnalysisProps {
  let normalCount     = 0;
  let outOfScopeCount = 0;
  const queriesPerTag:   Record<string, number> = {};
  const seenDocumentIds: Set<number>            = new Set();

  for (const result of results) {
    const relevantJudgments = result.testCase.judgments.filter(
      judgment => judgment.grade >= HIT_THRESHOLD,
    );

    if (relevantJudgments.length === 0) {
      outOfScopeCount++;
    } else {
      normalCount++;
    }

    for (const tag of result.testCase.tags) {
      queriesPerTag[tag] = (queriesPerTag[tag] ?? 0) + 1;
    }

    for (const judgment of relevantJudgments) {
      seenDocumentIds.add(judgment.document_id);
    }
  }

  const expectedDocumentIds = [...seenDocumentIds].sort(
    (documentIdA, documentIdB) => documentIdA - documentIdB,
  );

  return {
    totalQueries:            results.length,
    normalCount,
    outOfScopeCount,
    totalTags:               Object.keys(queriesPerTag).length,
    queriesPerTag,
    uniqueExpectedDocuments: expectedDocumentIds.length,
    expectedDocumentIds,
  };
}

// =============================================================================
// formatAdvancedReport
// =============================================================================

/**
 * Formats confidence intervals, score calibration, and coverage analysis into
 * a human-readable string for display in the CLI or eval runner.
 *
 * - Percentage metrics (hitRate, firstResultAccuracy, recall, zeroResultRate)
 *   render as: 88.5% (±4.2%, 95% CI: 84.3–92.7%)
 * - Ratio metrics (meanReciprocalRank, normalizedDiscountedCumulativeGain)
 *   render as: 0.601 (±0.052, 95% CI: 0.549–0.653)
 * - Tags with fewer than 3 queries are marked as undertested.
 */
export function formatAdvancedReport(
  intervals: IMetricConfidenceIntervalsProps,
  calibration: IScoreCalibrationProps,
  coverage: ICoverageAnalysisProps,
): string {
  const lines: string[] = [];

  // ---------------------------------------------------------------------------
  // Section 1 — CONFIDENCE INTERVALS
  // ---------------------------------------------------------------------------

  lines.push('='.repeat(60));
  lines.push('CONFIDENCE INTERVALS (95%, bootstrap)');
  lines.push('='.repeat(60));
  lines.push('');

  function formatPercentInterval(interval: IConfidenceIntervalProps): string {
    const halfWidth = interval.width / 2;
    return `${interval.point.toFixed(1)}% (±${halfWidth.toFixed(1)}%, 95% CI: ${interval.lower.toFixed(1)}–${interval.upper.toFixed(1)}%)`;
  }

  function formatRatioInterval(interval: IConfidenceIntervalProps): string {
    const intervalWidth = interval.width / 2;
    return `${interval.point.toFixed(3)} (±${intervalWidth.toFixed(3)}, 95% CI: ${interval.lower.toFixed(3)}–${interval.upper.toFixed(3)})`;
  }

  lines.push(`  Hit rate:              ${formatPercentInterval(intervals.hitRate)}`);
  lines.push(`  First-result accuracy: ${formatPercentInterval(intervals.firstResultAccuracy)}`);
  lines.push(`  Recall:                ${formatPercentInterval(intervals.recall)}`);
  lines.push(`  Zero-result rate:      ${formatPercentInterval(intervals.zeroResultRate)}`);
  lines.push(`  MRR:                   ${formatRatioInterval(intervals.meanReciprocalRank)}`);
  lines.push(`  NDCG@k:                ${formatRatioInterval(intervals.normalizedDiscountedCumulativeGain)}`);
  lines.push('');

  // ---------------------------------------------------------------------------
  // Section 2 — SCORE CALIBRATION
  // ---------------------------------------------------------------------------

  lines.push('='.repeat(60));
  lines.push('SCORE CALIBRATION');
  lines.push('='.repeat(60));
  lines.push('');

  const relevant   = calibration.relevantScores;
  const irrelevant = calibration.irrelevantScores;

  lines.push(`  Relevant scores   (n=${relevant.count}):`);
  lines.push(`    mean: ${relevant.mean.toFixed(3)}, median: ${relevant.median.toFixed(3)}, range: [${relevant.min.toFixed(3)}–${relevant.max.toFixed(3)}]`);
  lines.push('');
  lines.push(`  Irrelevant scores (n=${irrelevant.count}):`);
  lines.push(`    mean: ${irrelevant.mean.toFixed(3)}, median: ${irrelevant.median.toFixed(3)}, range: [${irrelevant.min.toFixed(3)}–${irrelevant.max.toFixed(3)}]`);
  lines.push('');
  lines.push(`  separation: ${calibration.separation.toFixed(3)} (higher = better distinction between relevant and irrelevant)`);
  lines.push('');

  // ---------------------------------------------------------------------------
  // Section 3 — COVERAGE ANALYSIS
  // ---------------------------------------------------------------------------

  lines.push('='.repeat(60));
  lines.push('COVERAGE ANALYSIS');
  lines.push('='.repeat(60));
  lines.push('');

  lines.push(`  Total queries:    ${coverage.totalQueries} (${coverage.normalCount} normal, ${coverage.outOfScopeCount} out-of-scope)`);
  lines.push(`  Unique docs:      ${coverage.uniqueExpectedDocuments}`);
  lines.push(`  Tags covered:     ${coverage.totalTags}`);
  lines.push('');

  const sortedTagEntries = Object.entries(coverage.queriesPerTag).sort(
    ([, countA], [, countB]) => countB - countA,
  );

  for (const [tag, count] of sortedTagEntries) {
    const undertested = count < 3 ? ' ← undertested' : '';
    lines.push(`    ${tag}: ${count}${undertested}`);
  }

  if (sortedTagEntries.length === 0) {
    lines.push('    (no tags)');
  }

  lines.push('');

  return lines.join('\n');
}
