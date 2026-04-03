// eval-advanced.ts
// Advanced eval utilities — confidence intervals via bootstrap resampling.
// Pure functions — no I/O, no database calls.

import { computeMetrics, type ITestResultProps } from './eval.js';

// =============================================================================
// Types
// =============================================================================

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
  ndcgAtK:             IConfidenceIntervalProps;
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
  const bootstrapNdcgAtKValues:        number[] = [];

  for (let iteration = 0; iteration < iterations; iteration++) {
    const resampledResults = resampleWithReplacement(results);
    const resampledMetrics = computeMetrics(resampledResults);

    bootstrapHitRates.push(resampledMetrics.hitRate);
    bootstrapFirstResultAccuracies.push(resampledMetrics.firstResultAccuracy);
    bootstrapRecalls.push(resampledMetrics.recall);
    bootstrapZeroResultRates.push(resampledMetrics.zeroResultRate);
    bootstrapMeanReciprocalRanks.push(resampledMetrics.meanReciprocalRank);
    bootstrapNdcgAtKValues.push(resampledMetrics.ndcgAtK);
  }

  return {
    hitRate:             buildInterval(bootstrapHitRates,             pointMetrics.hitRate),
    firstResultAccuracy: buildInterval(bootstrapFirstResultAccuracies, pointMetrics.firstResultAccuracy),
    recall:              buildInterval(bootstrapRecalls,              pointMetrics.recall),
    zeroResultRate:      buildInterval(bootstrapZeroResultRates,      pointMetrics.zeroResultRate),
    meanReciprocalRank:  buildInterval(bootstrapMeanReciprocalRanks,  pointMetrics.meanReciprocalRank),
    ndcgAtK:             buildInterval(bootstrapNdcgAtKValues,        pointMetrics.ndcgAtK),
  };
}
