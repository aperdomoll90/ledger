// diagnose-first-result.ts
// Diagnostic analysis of first-result accuracy failures in eval run 16.
// Classifies every query by failure mode, analyzes score distributions,
// and writes a structured markdown report.
//
// Run: npx tsx src/scripts/diagnose-first-result.ts
// Custom run: npx tsx src/scripts/diagnose-first-result.ts --run 14

import 'dotenv/config';
import { resolve } from 'path';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { loadEvalRun, type IEvalRunRowProps } from '../lib/eval/eval-store.js';
import { writeFileSync, mkdirSync } from 'fs';

// Load .env from ~/.ledger/.env (same as other scripts)
config({ path: resolve(process.env.HOME ?? '', '.ledger', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Allow overriding run ID via --run flag, default to 16
const runIdArg = process.argv.indexOf('--run');
const RUN_ID = runIdArg !== -1 ? parseInt(process.argv[runIdArg + 1], 10) : 16;

// =============================================================================
// Types
// =============================================================================

interface IPerQueryResult {
  query:                              string;
  tags:                               string[];
  judgments:                          Array<{ document_id: number; grade: number }>;
  hit:                                boolean;
  firstResultHit:                     boolean;
  position:                           number | null;
  expectedFound:                      number;
  expectedTotal:                      number;
  responseTimeMs:                     number;
  reciprocalRank:                     number;
  normalizedDiscountedCumulativeGain: number;
  returnedIds:                        number[];
  returnedScores:                     number[];
}

type TFailureCategory =
  | 'top-1-correct'
  | 'near-miss'
  | 'buried'
  | 'absent'
  | 'unjudged-winner'
  | 'out-of-scope';

interface IClassifiedQuery {
  query:          string;
  tags:           string[];
  category:       TFailureCategory;
  position:       number | null;
  returnedIds:    number[];
  returnedScores: number[];
  judgments:      Array<{ document_id: number; grade: number }>;
  topDocId:       number | null;
  topDocGrade:    number | null;
  ndcg:           number;
}

// =============================================================================
// Classification (priority order per spec)
// =============================================================================

const HIT_THRESHOLD = 2;

function classify(result: IPerQueryResult): IClassifiedQuery {
  const topDocId = result.returnedIds.length > 0 ? result.returnedIds[0] : null;
  const judgmentMap = new Map(result.judgments.map(j => [j.document_id, j.grade]));
  const topDocGrade = topDocId !== null ? (judgmentMap.get(topDocId) ?? null) : null;

  let category: TFailureCategory;

  // Priority 1: out-of-scope
  if (result.tags.includes('out-of-scope')) {
    category = 'out-of-scope';
  }
  // Priority 2: top-1 correct
  else if (result.firstResultHit) {
    category = 'top-1-correct';
  }
  // Priority 3: unjudged winner (top doc has no judgment at all)
  else if (topDocId !== null && topDocGrade === null) {
    category = 'unjudged-winner';
  }
  // Priority 4: near miss (first correct at position 2-3, i.e., 0-indexed 1-2)
  else if (result.position !== null && result.position >= 1 && result.position <= 2) {
    category = 'near-miss';
  }
  // Priority 5: buried (first correct at position 4-10, i.e., 0-indexed 3-9)
  else if (result.position !== null && result.position >= 3 && result.position <= 9) {
    category = 'buried';
  }
  // Priority 6: absent (no grade >= 2 in top 10)
  else if (!result.hit) {
    category = 'absent';
  }
  // Fallback: position is set but doesn't match ranges (shouldn't happen)
  else {
    category = 'buried';
  }

  return {
    query: result.query,
    tags: result.tags,
    category,
    position: result.position,
    returnedIds: result.returnedIds,
    returnedScores: result.returnedScores,
    judgments: result.judgments,
    topDocId,
    topDocGrade,
    ndcg: result.normalizedDiscountedCumulativeGain,
  };
}

function classifyAll(results: IPerQueryResult[]): IClassifiedQuery[] {
  return results.map(classify);
}

// =============================================================================
// Score distribution analysis
// =============================================================================

interface ICategoryScoreStats {
  category:           TFailureCategory;
  count:              number;
  scoreAtPos1:        { min: number; median: number; max: number; mean: number };
  scoreGapPos1Pos2:   { min: number; median: number; max: number; mean: number };
  scoreOfFirstCorrect:{ min: number; median: number; max: number; mean: number } | null;
  scoreGapToCorrect:  { min: number; median: number; max: number; mean: number } | null;
  avgNdcg:            number;
}

function computeStats(values: number[]): { min: number; median: number; max: number; mean: number } {
  if (values.length === 0) return { min: 0, median: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    min:    sorted[0],
    median: sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
    max:    sorted[sorted.length - 1],
    mean:   sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
  };
}

function analyzeScores(classified: IClassifiedQuery[]): ICategoryScoreStats[] {
  const categories: TFailureCategory[] = ['near-miss', 'buried', 'absent', 'unjudged-winner'];
  const stats: ICategoryScoreStats[] = [];

  for (const category of categories) {
    const queries = classified.filter(q => q.category === category);
    if (queries.length === 0) continue;

    const scoreAtPos1 = queries
      .filter(q => q.returnedScores.length > 0)
      .map(q => q.returnedScores[0]);

    const scoreGapPos1Pos2 = queries
      .filter(q => q.returnedScores.length >= 2)
      .map(q => q.returnedScores[0] - q.returnedScores[1]);

    const queriesWithCorrect = queries.filter(q => q.position !== null);
    const scoreOfFirstCorrect = queriesWithCorrect.map(q => q.returnedScores[q.position!]);
    const scoreGapToCorrect = queriesWithCorrect.map(q => q.returnedScores[0] - q.returnedScores[q.position!]);

    stats.push({
      category,
      count: queries.length,
      scoreAtPos1:         computeStats(scoreAtPos1),
      scoreGapPos1Pos2:    computeStats(scoreGapPos1Pos2),
      scoreOfFirstCorrect: queriesWithCorrect.length > 0 ? computeStats(scoreOfFirstCorrect) : null,
      scoreGapToCorrect:   queriesWithCorrect.length > 0 ? computeStats(scoreGapToCorrect) : null,
      avgNdcg:             queries.reduce((sum, q) => sum + q.ndcg, 0) / queries.length,
    });
  }

  return stats;
}

// =============================================================================
// Tag-level breakdown
// =============================================================================

interface ITagBreakdown {
  tag:                 string;
  total:              number;
  correct:            number;
  nearMiss:           number;
  buried:             number;
  absent:             number;
  unjudged:           number;
  firstResultAccuracy: number;
  avgScoreGap:        number;
}

function analyzeByTag(classified: IClassifiedQuery[]): ITagBreakdown[] {
  const tagMap = new Map<string, IClassifiedQuery[]>();

  for (const query of classified) {
    if (query.category === 'out-of-scope') continue;
    for (const tag of query.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(query);
    }
  }

  const breakdowns: ITagBreakdown[] = [];

  for (const [tag, queries] of tagMap) {
    const correct   = queries.filter(q => q.category === 'top-1-correct').length;
    const nearMiss  = queries.filter(q => q.category === 'near-miss').length;
    const buried    = queries.filter(q => q.category === 'buried').length;
    const absent    = queries.filter(q => q.category === 'absent').length;
    const unjudged  = queries.filter(q => q.category === 'unjudged-winner').length;

    const gaps = queries
      .filter(q => q.returnedScores.length >= 2)
      .map(q => q.returnedScores[0] - q.returnedScores[1]);

    breakdowns.push({
      tag,
      total: queries.length,
      correct,
      nearMiss,
      buried,
      absent,
      unjudged,
      firstResultAccuracy: queries.length > 0 ? (correct / queries.length) * 100 : 0,
      avgScoreGap: gaps.length > 0 ? gaps.reduce((s, v) => s + v, 0) / gaps.length : 0,
    });
  }

  return breakdowns.sort((a, b) => a.firstResultAccuracy - b.firstResultAccuracy);
}

// =============================================================================
// Report generation
// =============================================================================

function generateReport(classified: IClassifiedQuery[], run: IEvalRunRowProps): string {
  const scoreStats = analyzeScores(classified);
  const tagBreakdowns = analyzeByTag(classified);

  const nonScope = classified.filter(q => q.category !== 'out-of-scope');
  const correct    = classified.filter(q => q.category === 'top-1-correct');
  const nearMiss   = classified.filter(q => q.category === 'near-miss');
  const buried     = classified.filter(q => q.category === 'buried');
  const absent     = classified.filter(q => q.category === 'absent');
  const unjudged   = classified.filter(q => q.category === 'unjudged-winner');
  const outOfScope = classified.filter(q => q.category === 'out-of-scope');

  const lines: string[] = [];

  // --- Header ---
  lines.push(`# First-Result Accuracy Diagnostic: Run ${run.id}`);
  lines.push('');
  lines.push(`> Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`> Run date: ${run.run_date}`);
  lines.push(`> Queries: ${classified.length} (${nonScope.length} scored, ${outOfScope.length} out-of-scope)`);
  lines.push(`> First-result accuracy: ${run.first_result_accuracy.toFixed(1)}%`);
  lines.push('');

  // --- Executive summary ---
  lines.push('## Executive Summary');
  lines.push('');
  const failCount = nonScope.length - correct.length;
  lines.push(`${failCount} of ${nonScope.length} queries (${((failCount / nonScope.length) * 100).toFixed(1)}%) do not have the best result at position 1. `
    + `The dominant failure mode is **${getDominantCategory(nearMiss.length, buried.length, absent.length, unjudged.length)}**. `
    + `${unjudged.length > 0 ? `${unjudged.length} queries have unjudged documents at position 1 and need manual review before the classification is trustworthy.` : 'All top-1 documents have been judged.'}`);
  lines.push('');

  // --- Failure taxonomy ---
  lines.push('## Failure Taxonomy');
  lines.push('');
  lines.push('| Category        | Count | %     | Description                             |');
  lines.push('|-----------------|-------|-------|-----------------------------------------|');
  lines.push(`| Top-1 correct   | ${pad(correct.length)}  | ${pad(pct(correct.length, nonScope.length))} | Position 1 has grade >= 2               |`);
  lines.push(`| Near miss       | ${pad(nearMiss.length)}  | ${pad(pct(nearMiss.length, nonScope.length))} | First correct at position 2-3           |`);
  lines.push(`| Buried          | ${pad(buried.length)}  | ${pad(pct(buried.length, nonScope.length))} | First correct at position 4-10          |`);
  lines.push(`| Unjudged winner | ${pad(unjudged.length)}  | ${pad(pct(unjudged.length, nonScope.length))} | Top doc never graded (judgment gap)     |`);
  lines.push(`| Absent          | ${pad(absent.length)}  | ${pad(pct(absent.length, nonScope.length))} | No grade >= 2 doc in top 10             |`);
  lines.push(`| Out-of-scope    | ${pad(outOfScope.length)}  | n/a   | Excluded from metric                    |`);
  lines.push('');

  // --- Tag heatmap ---
  lines.push('## Tag Breakdown');
  lines.push('');
  lines.push('Sorted by first-result accuracy (worst first).');
  lines.push('');
  lines.push('| Tag                | Total | Correct | Near Miss | Buried | Absent | Unjudged | 1st-Result% | Avg Gap  |');
  lines.push('|--------------------|-------|---------|-----------|--------|--------|----------|-------------|----------|');
  for (const t of tagBreakdowns) {
    lines.push(`| ${padR(t.tag, 18)} | ${pad(t.total)}   | ${pad(t.correct)}     | ${pad(t.nearMiss)}       | ${pad(t.buried)}    | ${pad(t.absent)}    | ${pad(t.unjudged)}      | ${padR(t.firstResultAccuracy.toFixed(1) + '%', 11)} | ${t.avgScoreGap.toFixed(4)} |`);
  }
  lines.push('');

  // --- Score analysis ---
  lines.push('## Score Distribution by Failure Category');
  lines.push('');
  for (const stat of scoreStats) {
    lines.push(`### ${stat.category} (${stat.count} queries, avg NDCG: ${stat.avgNdcg.toFixed(3)})`);
    lines.push('');
    lines.push('| Metric                  | Min    | Median | Max    | Mean   |');
    lines.push('|-------------------------|--------|--------|--------|--------|');
    lines.push(`| Score at position 1     | ${fmtRow(stat.scoreAtPos1)} |`);
    lines.push(`| Gap (pos 1 vs pos 2)    | ${fmtRow(stat.scoreGapPos1Pos2)} |`);
    if (stat.scoreOfFirstCorrect) {
      lines.push(`| Score of first correct  | ${fmtRow(stat.scoreOfFirstCorrect)} |`);
    }
    if (stat.scoreGapToCorrect) {
      lines.push(`| Gap to correct          | ${fmtRow(stat.scoreGapToCorrect)} |`);
    }
    lines.push('');
  }

  // --- Unjudged audit ---
  if (unjudged.length > 0) {
    lines.push('## Unjudged Audit');
    lines.push('');
    lines.push('These queries have a document at position 1 with no judgment. Grade them');
    lines.push('via `ledger eval:judge` before trusting the failure classification.');
    lines.push('');
    lines.push('| Query | Top Doc ID | Tags |');
    lines.push('|-------|------------|------|');
    for (const q of unjudged) {
      lines.push(`| ${q.query} | ${q.topDocId} | ${q.tags.join(', ')} |`);
    }
    lines.push('');
  }

  // --- Worst offenders ---
  lines.push('## Worst Offenders');
  lines.push('');
  lines.push('Queries with the largest gap between expected and actual ranking (excluding absent and out-of-scope).');
  lines.push('');

  const offenders = classified
    .filter(q => q.category === 'near-miss' || q.category === 'buried')
    .sort((a, b) => {
      const gapA = a.position !== null && a.returnedScores.length > 0
        ? a.returnedScores[0] - a.returnedScores[a.position]
        : 0;
      const gapB = b.position !== null && b.returnedScores.length > 0
        ? b.returnedScores[0] - b.returnedScores[b.position]
        : 0;
      return gapB - gapA;
    })
    .slice(0, 10);

  lines.push('| Query | Category | Position | Top Doc (grade) | Score Gap |');
  lines.push('|-------|----------|----------|-----------------|-----------|');
  for (const q of offenders) {
    const gradeLabel = q.topDocGrade !== null ? `g${q.topDocGrade}` : 'unjudged';
    const gap = q.position !== null ? (q.returnedScores[0] - q.returnedScores[q.position]).toFixed(4) : 'n/a';
    lines.push(`| ${q.query} | ${q.category} | ${q.position !== null ? q.position + 1 : 'n/a'} | ${q.topDocId} (${gradeLabel}) | ${gap} |`);
  }
  lines.push('');

  // --- Hypotheses ---
  lines.push('## Hypotheses');
  lines.push('');
  lines.push('Ranked by estimated impact (number of queries affected). These are generated');
  lines.push('from the data patterns above and need human review before acting on them.');
  lines.push('');
  lines.push('*Hypotheses will be written manually after reviewing the data above.*');
  lines.push('*The script produces the data; Adrian and Charlie interpret it together.*');

  return lines.join('\n');
}

// --- Formatting helpers ---

function pad(value: number | string, width = 5): string {
  return String(value).padStart(width);
}

function padR(value: string, width: number): string {
  return value.padEnd(width);
}

function pct(count: number, total: number): string {
  if (total === 0) return '0.0%';
  return ((count / total) * 100).toFixed(1) + '%';
}

function fmtRow(s: { min: number; median: number; max: number; mean: number }): string {
  return `${s.min.toFixed(4)} | ${s.median.toFixed(4)} | ${s.max.toFixed(4)} | ${s.mean.toFixed(4)}`;
}

function getDominantCategory(nearMiss: number, buried: number, absent: number, unjudged: number): string {
  const max = Math.max(nearMiss, buried, absent, unjudged);
  if (max === nearMiss) return 'near miss (position 2-3)';
  if (max === buried) return 'buried (position 4-10)';
  if (max === unjudged) return 'unjudged winner (judgment gap)';
  return 'absent (retrieval failure)';
}

// =============================================================================
// Write report to disk
// =============================================================================

function writeReport(report: string): void {
  const scriptDir = new URL('.', import.meta.url).pathname;
  const dir = resolve(scriptDir, '../../docs/analysis');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `first-result-accuracy-run${RUN_ID}.md`);
  writeFileSync(path, report, 'utf-8');
  console.error(`Report written to ${path}`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.error(`Loading eval run ${RUN_ID}...`);
  const run = await loadEvalRun(supabase, RUN_ID);
  if (!run) {
    console.error(`Run ${RUN_ID} not found.`);
    process.exit(1);
  }

  const results = run.per_query_results as unknown as IPerQueryResult[];
  if (!results || results.length === 0) {
    console.error(`Run ${RUN_ID} has no per_query_results.`);
    process.exit(1);
  }

  console.error(`Loaded ${results.length} queries from run ${RUN_ID}.`);

  const classified = classifyAll(results);
  const report = generateReport(classified, run);
  writeReport(report);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
