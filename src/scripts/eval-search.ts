// eval-search.ts
// Run the golden dataset through search, compute metrics, print report.
//
// Run: npx tsx src/scripts/eval-search.ts
// This gives us a measurable score for search quality.
// Every future change gets compared against this baseline.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import type { IClientsProps } from '../lib/document-classification.js';
import { searchHybrid } from '../lib/ai-search.js';

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

// =============================================================================
// Types
// =============================================================================

interface GoldenTestCase {
  id: number;
  query: string;
  expected_doc_ids: number[];
  tags: string[];
}

interface TestResult {
  testCase: GoldenTestCase;
  returnedIds: number[];
  returnedScores: number[];
  hit: boolean;           // Was ANY expected doc found in results?
  firstResultHit: boolean; // Was the FIRST result one of the expected docs?
  expectedFound: number;  // How many expected docs were found
  expectedTotal: number;  // How many expected docs there are
  position: number | null; // Position of first expected doc in results (0-indexed), null if not found
  responseTimeMs: number;
}

// =============================================================================
// Run eval
// =============================================================================

async function runEval(): Promise<void> {
  console.log('\n' + '='.repeat(60));
  console.log('Ledger Search Evaluation');
  console.log('='.repeat(60) + '\n');

  // Load golden dataset
  const { data: testCases, error } = await clients.supabase
    .from('eval_golden_dataset')
    .select('id, query, expected_doc_ids, tags')
    .order('id');

  if (error || !testCases) {
    console.error('Failed to load golden dataset:', error?.message);
    process.exit(1);
  }

  console.log(`Loaded ${testCases.length} test cases.\n`);

  const results: TestResult[] = [];

  for (const testCase of testCases as GoldenTestCase[]) {
    const startTime = Date.now();

    const searchResults = await searchHybrid(clients, {
      query: testCase.query,
      limit: 10,
    });

    const responseTimeMs = Date.now() - startTime;
    const returnedIds = searchResults.map(result => result.id);
    const returnedScores = searchResults.map(result => result.score ?? result.similarity ?? 0);

    // For out-of-scope queries, success = no results or irrelevant results
    const isOutOfScope = testCase.expected_doc_ids.length === 0;

    if (isOutOfScope) {
      results.push({
        testCase,
        returnedIds,
        returnedScores,
        hit: searchResults.length === 0, // For out-of-scope, "hit" means correctly returning nothing
        firstResultHit: searchResults.length === 0,
        expectedFound: 0,
        expectedTotal: 0,
        position: null,
        responseTimeMs,
      });

      const status = searchResults.length === 0 ? 'PASS' : `NOISE (${searchResults.length} results)`;
      console.log(`  [${status}] "${testCase.query}" (out-of-scope)`);
      continue;
    }

    // For normal queries, check which expected docs were found
    const foundExpected = testCase.expected_doc_ids.filter(expectedId =>
      returnedIds.includes(expectedId)
    );

    // Position of the first expected doc in results
    const firstExpectedPosition = testCase.expected_doc_ids
      .map(expectedId => returnedIds.indexOf(expectedId))
      .filter(position => position >= 0)
      .sort((a, b) => a - b)[0] ?? null;

    const hit = foundExpected.length > 0;
    const firstResultHit = testCase.expected_doc_ids.includes(returnedIds[0]);

    results.push({
      testCase,
      returnedIds,
      returnedScores,
      hit,
      firstResultHit,
      expectedFound: foundExpected.length,
      expectedTotal: testCase.expected_doc_ids.length,
      position: firstExpectedPosition,
      responseTimeMs,
    });

    const status = firstResultHit ? 'TOP' : hit ? 'HIT' : 'MISS';
    const positionInfo = firstExpectedPosition !== null ? `@${firstExpectedPosition + 1}` : '';
    console.log(`  [${status}${positionInfo}] "${testCase.query}" → found ${foundExpected.length}/${testCase.expected_doc_ids.length}`);
  }

  // =============================================================================
  // Compute metrics
  // =============================================================================

  // Filter out out-of-scope for most metrics
  const normalResults = results.filter(result => result.testCase.expected_doc_ids.length > 0);
  const outOfScopeResults = results.filter(result => result.testCase.expected_doc_ids.length === 0);

  const totalNormal = normalResults.length;
  const hits = normalResults.filter(result => result.hit).length;
  const firstResultHits = normalResults.filter(result => result.firstResultHit).length;
  const totalExpected = normalResults.reduce((sum, result) => sum + result.expectedTotal, 0);
  const totalFound = normalResults.reduce((sum, result) => sum + result.expectedFound, 0);
  const zeroResults = normalResults.filter(result => result.returnedIds.length === 0).length;
  const outOfScopeCorrect = outOfScopeResults.filter(result => result.hit).length;

  const avgResponseTime = results.reduce((sum, result) => sum + result.responseTimeMs, 0) / results.length;

  // Metrics
  const hitRate = totalNormal > 0 ? (hits / totalNormal) * 100 : 0;
  const firstResultAccuracy = totalNormal > 0 ? (firstResultHits / totalNormal) * 100 : 0;
  const recall = totalExpected > 0 ? (totalFound / totalExpected) * 100 : 0;
  const zeroResultRate = totalNormal > 0 ? (zeroResults / totalNormal) * 100 : 0;
  const outOfScopeAccuracy = outOfScopeResults.length > 0 ? (outOfScopeCorrect / outOfScopeResults.length) * 100 : 0;

  // =============================================================================
  // Report
  // =============================================================================

  console.log('\n' + '='.repeat(60));
  console.log('Results');
  console.log('='.repeat(60));

  console.log(`
Test cases:          ${results.length} total (${totalNormal} normal, ${outOfScopeResults.length} out-of-scope)

METRICS:
  Hit rate:              ${hitRate.toFixed(1)}% (${hits}/${totalNormal} queries found at least one expected doc)
  First-result accuracy: ${firstResultAccuracy.toFixed(1)}% (${firstResultHits}/${totalNormal} queries had correct #1 result)
  Recall:                ${recall.toFixed(1)}% (${totalFound}/${totalExpected} expected docs found across all queries)
  Zero-result rate:      ${zeroResultRate.toFixed(1)}% (${zeroResults}/${totalNormal} queries returned nothing)
  Out-of-scope accuracy: ${outOfScopeAccuracy.toFixed(1)}% (${outOfScopeCorrect}/${outOfScopeResults.length} correctly returned nothing)
  Avg response time:     ${avgResponseTime.toFixed(0)}ms
`);

  // Missed queries
  const missed = normalResults.filter(result => !result.hit);
  if (missed.length > 0) {
    console.log('MISSED QUERIES (expected doc not found in results):');
    for (const miss of missed) {
      console.log(`  "${miss.testCase.query}" — expected [${miss.testCase.expected_doc_ids.join(', ')}], got [${miss.returnedIds.slice(0, 5).join(', ')}]`);
    }
    console.log();
  }

  // By tag
  console.log('BY TAG:');
  const tagStats: Record<string, { total: number; hits: number; firstHits: number }> = {};
  for (const result of normalResults) {
    for (const tag of result.testCase.tags) {
      if (!tagStats[tag]) tagStats[tag] = { total: 0, hits: 0, firstHits: 0 };
      tagStats[tag].total++;
      if (result.hit) tagStats[tag].hits++;
      if (result.firstResultHit) tagStats[tag].firstHits++;
    }
  }
  for (const [tag, stats] of Object.entries(tagStats).sort((a, b) => b[1].total - a[1].total)) {
    const hitPct = ((stats.hits / stats.total) * 100).toFixed(0);
    const firstPct = ((stats.firstHits / stats.total) * 100).toFixed(0);
    console.log(`  ${tag}: ${hitPct}% hit rate, ${firstPct}% first-result (${stats.total} queries)`);
  }

  console.log('\n' + '='.repeat(60));
}

runEval().catch((error) => {
  console.error('Eval crashed:', error);
  process.exit(1);
});
