// eval-advanced.ts
// Advanced eval utilities — confidence intervals via bootstrap resampling,
// score calibration for relevant vs irrelevant result distributions.
// Pure functions — no I/O, no database calls.

import { computeMetrics, type ITestResultProps } from './eval.js';

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
 * Separates scores into relevant (returned doc was in expected_doc_ids) and
 * irrelevant buckets, then computes distribution stats for each.
 *
 * Out-of-scope results (expected_doc_ids is empty) are skipped entirely.
 * Separation = relevant mean − irrelevant mean.
 */
export function computeScoreCalibration(results: ITestResultProps[]): IScoreCalibrationProps {
  const relevantScoreValues: number[] = [];
  const irrelevantScoreValues: number[] = [];

  for (const result of results) {
    if (result.testCase.expected_doc_ids.length === 0) continue;

    for (let position = 0; position < result.returnedIds.length; position++) {
      const docId = result.returnedIds[position];
      const score = result.returnedScores[position];

      if (result.testCase.expected_doc_ids.includes(docId)) {
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
