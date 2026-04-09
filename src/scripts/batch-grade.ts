// batch-grade.ts
// Phase 4.6.2 — Batch grading of top-10 search results for all golden queries.
// Uses Charlie's corpus knowledge to assign TREC 0-3 grades.
//
// Run: npx tsx src/scripts/batch-grade.ts
// Dry run (print only): npx tsx src/scripts/batch-grade.ts --dry-run

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import type { IClientsProps } from '../lib/documents/classification.js';
import { searchHybrid } from '../lib/search/ai-search.js';
import { CURRENT_SEARCH_CONFIG } from '../lib/eval/eval-store.js';

// =============================================================================
// Setup
// =============================================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey   = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey || !openaiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const openai   = new OpenAI({ apiKey: openaiKey });
const dryRun   = process.argv.includes('--dry-run');

const clients: IClientsProps = {
  supabase,
  openai,
  cohereApiKey: undefined,
};

// =============================================================================
// Types
// =============================================================================

interface IGoldenRowProps {
  id:    number;
  query: string;
  tags:  string[];
  judgments: Array<{ document_id: number; grade: number }>;
}

type TGrade = 0 | 1 | 2 | 3;

// =============================================================================
// Grading logic — maps (query topic, doc identity) to a grade
// =============================================================================

// Topic extraction from query text
function extractQueryTopic(query: string): {
  project: string | null;
  subject: string;
  queryType: 'simple' | 'conceptual' | 'exact-term' | 'multi-doc' | 'other';
} {
  const lowerQuery = query.toLowerCase();

  // Detect project scope
  let project: string | null = null;
  if (lowerQuery.includes('ledger'))    project = 'ledger';
  if (lowerQuery.includes('atelier'))   project = 'atelier';
  if (lowerQuery.includes('starbrite')) project = 'starbrite';
  if (lowerQuery.includes('css-forge') || lowerQuery.includes('css forge')) project = 'css-forge';
  if (lowerQuery.includes('adrian'))    project = 'persona';

  // Detect query type by pattern
  let queryType: 'simple' | 'conceptual' | 'exact-term' | 'multi-doc' | 'other' = 'other';
  if (lowerQuery.startsWith('how') || lowerQuery.startsWith('what') || lowerQuery.startsWith('why') || lowerQuery.startsWith('when')) {
    queryType = 'conceptual';
  } else if (lowerQuery.includes(' and ') || lowerQuery.includes('all ')) {
    queryType = 'multi-doc';
  } else {
    queryType = 'simple';
  }

  return { project, subject: lowerQuery, queryType };
}

// Core grading function
function gradeResult(
  query: string,
  queryTopic: ReturnType<typeof extractQueryTopic>,
  docId: number,
  docName: string,
  docDomain: string,
  docProject: string | null,
): TGrade {
  const lowerQuery = queryTopic.subject;
  const lowerName  = docName.toLowerCase();

  // ==========================================================================
  // Rule 1: Canonical match — doc name closely matches the query subject
  // ==========================================================================

  // "ledger architecture overview" -> "ledger-architecture" is canonical
  // "user profile" -> "user-profile" is canonical
  // "atelier overview" -> "atelier-overview" is canonical
  const queryWords = lowerQuery
    .replace(/['']/g, '')
    .split(/\s+/)
    .filter(word => !['the', 'a', 'an', 'in', 'of', 'for', 'how', 'does', 'do', 'is', 'what', 'are', 'to', 'my', 'i', 'should', 'can', 'when', 'where', 'which', 'about'].includes(word));

  const nameWords = lowerName.split('-');

  // Count how many meaningful query words appear in the doc name
  const nameMatchCount = queryWords.filter(queryWord =>
    nameWords.some(nameWord => nameWord.includes(queryWord) || queryWord.includes(nameWord)),
  ).length;

  const nameMatchRatio = queryWords.length > 0 ? nameMatchCount / queryWords.length : 0;

  // ==========================================================================
  // Rule 2: Project scope matching
  // ==========================================================================

  const projectMatches = (
    queryTopic.project === null ||
    queryTopic.project === 'persona' ||
    docProject === queryTopic.project ||
    (queryTopic.project === 'persona' && docDomain === 'persona')
  );

  // ==========================================================================
  // Rule 3: Known doc-type patterns
  // ==========================================================================

  const isDevlog        = lowerName.includes('devlog');
  const isErrorlog      = lowerName.includes('errorlog') || lowerName.includes('error-log');
  const isPhaseSpec     = lowerName.includes('-phase-') || lowerName.includes('-v2-phase');
  const isSessionEvent  = lowerName.includes('session-');
  const isClaudeMd      = lowerName.includes('claude-md');
  const isMemoryMd      = lowerName.includes('memory-md');
  const isFeedback      = lowerName.includes('feedback-');
  const isLintConfig    = lowerName.includes('lint-');
  const isSkillDoc      = lowerName.includes('custom-skills-');
  const isAgentSpec     = lowerName.includes('atelier-agent-');
  const isCodeCraft     = lowerName.includes('code-craft-');
  const isReference     = docDomain === 'general' && lowerName.includes('reference-');
  const isExploration   = lowerName.includes('exploration-complete');
  const isStatusDashboard = lowerName.includes('status-dashboard') || lowerName.includes('project-status');

  // ==========================================================================
  // Grading decision tree
  // ==========================================================================

  // Strong canonical match: >70% of query words match the doc name
  if (nameMatchRatio >= 0.7 && projectMatches) {
    return 3;
  }

  // Moderate match: >50% of query words match
  if (nameMatchRatio >= 0.5 && projectMatches) {
    // Check if this is a high-quality doc for the topic
    if (isDevlog || isSessionEvent || isErrorlog) return 1;
    if (isClaudeMd || isMemoryMd) return 0;
    return 2;
  }

  // Devlogs are almost never relevant unless the query is specifically about the devlog
  if (isDevlog && !lowerQuery.includes('devlog') && !lowerQuery.includes('development log') && !lowerQuery.includes('session history')) {
    return 0;
  }

  // Claude.md and memory.md are internal config, almost never the answer
  if (isClaudeMd && !lowerQuery.includes('claude.md') && !lowerQuery.includes('claude md') && !lowerQuery.includes('identity') && !lowerQuery.includes('orchestrator')) {
    return 0;
  }
  if (isMemoryMd && !lowerQuery.includes('memory')) {
    return 0;
  }

  // Feedback rules are only relevant to behavioral/feedback queries
  if (isFeedback && !lowerQuery.includes('feedback') && !lowerQuery.includes('behavioral') && !lowerQuery.includes('rule')) {
    return 0;
  }

  // Lint configs are only relevant to linting queries
  if (isLintConfig && !lowerQuery.includes('lint') && !lowerQuery.includes('eslint') && !lowerQuery.includes('stylelint')) {
    return 0;
  }

  // Phase specs: relevant only when asking about that specific phase or topic
  if (isPhaseSpec) {
    // Check if the query topic matches the phase subject
    if (lowerQuery.includes('sync') && lowerName.includes('sync')) return 2;
    if (lowerQuery.includes('access') && lowerName.includes('access')) return 2;
    if (lowerQuery.includes('observability') && lowerName.includes('observability')) return 2;
    if (lowerQuery.includes('security') && lowerName.includes('access')) return 1;
    if (lowerQuery.includes('roadmap') || lowerQuery.includes('phase') || lowerQuery.includes('plan')) return 1;
    return 0;
  }

  // Session events: rarely relevant
  if (isSessionEvent && !lowerQuery.includes('session')) {
    return 0;
  }

  // Skill docs: relevant only to skill/eval queries
  if (isSkillDoc) {
    if (lowerQuery.includes('skill') || lowerQuery.includes('eval') || lowerQuery.includes('review')) return 1;
    return 0;
  }

  // Agent specs: relevant to agent/atelier queries
  if (isAgentSpec) {
    if (queryTopic.project === 'atelier' || lowerQuery.includes('agent')) return 2;
    if (lowerQuery.includes('developer') || lowerQuery.includes('design') || lowerQuery.includes('qa') || lowerQuery.includes('security')) {
      // Specific agent might match
      if (lowerQuery.includes('developer') && lowerName.includes('cody')) return 2;
      if (lowerQuery.includes('design') && lowerName.includes('ross')) return 2;
      if (lowerQuery.includes('qa') && lowerName.includes('stan')) return 2;
      if (lowerQuery.includes('accessibility') && lowerName.includes('ada')) return 2;
      if (lowerQuery.includes('security') && (lowerName.includes('marshall') || lowerName.includes('chase'))) return 2;
      return 1;
    }
    return 0;
  }

  // Code-craft docs: relevant to coding convention/style queries
  if (isCodeCraft) {
    if (lowerQuery.includes('convention') || lowerQuery.includes('coding') || lowerQuery.includes('style') || lowerQuery.includes('pattern')) {
      // Check subject match
      if (lowerQuery.includes('css') && lowerName.includes('css')) return 3;
      if (lowerQuery.includes('react') && lowerName.includes('react')) return 3;
      if (lowerQuery.includes('clean code') && lowerName.includes('clean-code')) return 3;
      if (lowerQuery.includes('naming') && lowerName.includes('naming')) return 3;
      if (lowerQuery.includes('design system') && lowerName.includes('ds-')) return 2;
      if (lowerQuery.includes('design') && lowerName.includes('ds-')) return 2;
      return 1;
    }
    if (lowerQuery.includes('design system') && lowerName.includes('ds-')) return 2;
    if (lowerQuery.includes('design') && lowerName.includes('design')) return 1;
    return 0;
  }

  // Reference docs: potentially valuable for conceptual queries
  if (isReference) {
    if (lowerQuery.includes('rag') && lowerName.includes('rag')) return 2;
    if (lowerQuery.includes('database') && lowerName.includes('database')) return 2;
    if (lowerQuery.includes('eval') && lowerName.includes('eval')) return 2;
    if (lowerQuery.includes('color') && lowerName.includes('color')) return 3;
    if (lowerQuery.includes('portfolio') && lowerName.includes('portfolio')) return 3;
    return 0;
  }

  // System exploration: useful for broad Ledger queries
  if (isExploration && queryTopic.project === 'ledger') {
    return 2;
  }

  // Status dashboards: relevant to project status queries
  if (isStatusDashboard) {
    if (lowerQuery.includes('status') || lowerQuery.includes('progress') || lowerQuery.includes('dashboard')) return 2;
    return 0;
  }

  // ==========================================================================
  // Weak match: some query words match, same project
  // ==========================================================================

  if (nameMatchRatio >= 0.3 && projectMatches) {
    return 1;
  }

  // Same project but no name match: might be tangentially related
  if (projectMatches && queryTopic.project !== null && nameMatchRatio > 0) {
    return 1;
  }

  // ==========================================================================
  // Default: not relevant
  // ==========================================================================

  return 0;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log(dryRun ? '\n[DRY RUN] Grading without writing to database.\n' : '\nBatch grading starting.\n');

  // Load all golden queries with existing judgments
  const { data: goldenRows, error: loadError } = await supabase
    .from('eval_golden_dataset')
    .select('id, query, tags, judgments:eval_golden_judgments(document_id, grade)')
    .order('id');

  if (loadError || !goldenRows) {
    console.error('Failed to load golden dataset:', loadError?.message ?? 'no data');
    process.exit(1);
  }

  const queries = goldenRows as IGoldenRowProps[];
  let totalGraded  = 0;
  let totalSkipped = 0;
  let totalErrors  = 0;
  const gradeCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

  for (const golden of queries) {
    const existingGrades = new Map<number, number>();
    for (const judgment of golden.judgments ?? []) {
      existingGrades.set(judgment.document_id, judgment.grade);
    }

    // Skip out-of-scope queries (no grade-2+ judgments expected)
    const hasRelevant = (golden.judgments ?? []).some(judgment => judgment.grade >= 2);
    const isOutOfScope = !hasRelevant && existingGrades.size === 0;

    // Run search
    const searchResults = await searchHybrid(clients, {
      query: golden.query,
      limit: CURRENT_SEARCH_CONFIG.limit as number,
      reranker: CURRENT_SEARCH_CONFIG.reranker as 'none' | 'cohere',
    });

    const queryTopic = extractQueryTopic(golden.query);
    const ungradedResults = searchResults
      .slice(0, 10)
      .filter(result => !existingGrades.has(result.id));

    if (ungradedResults.length === 0) {
      continue;
    }

    if (dryRun) {
      console.log(`\nQuery #${golden.id}: "${golden.query}"`);
    }

    for (const result of ungradedResults) {
      const grade = gradeResult(
        golden.query,
        queryTopic,
        result.id,
        result.name ?? '<unknown>',
        result.domain ?? 'general',
        result.project ?? null,
      );

      gradeCounts[grade]++;

      if (dryRun) {
        console.log(`  #${result.id} ${result.name ?? '<unknown>'} → grade ${grade}`);
        totalGraded++;
        continue;
      }

      // Write to database
      const { error: rpcError } = await supabase.rpc('judgment_create', {
        p_golden_id:   golden.id,
        p_document_id: result.id,
        p_grade:       grade,
        p_judged_by:   'charlie-batch-4.6.2',
        p_notes:       null,
      });

      if (rpcError) {
        const message = rpcError.message ?? '';
        if (message.includes('duplicate') || message.includes('unique')) {
          totalSkipped++;
        } else {
          totalErrors++;
          console.error(`  [ERR] golden_id=${golden.id} doc_id=${result.id}: ${message}`);
        }
      } else {
        totalGraded++;
      }
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Batch grading summary');
  console.log('='.repeat(60));
  console.log(`  Queries processed:    ${queries.length}`);
  console.log(`  Judgments created:    ${totalGraded}`);
  console.log(`  Skipped (duplicate):  ${totalSkipped}`);
  console.log(`  Errors:               ${totalErrors}`);
  console.log('');
  console.log('  Grade distribution:');
  console.log(`    0 (not relevant):    ${gradeCounts[0]}`);
  console.log(`    1 (related):         ${gradeCounts[1]}`);
  console.log(`    2 (relevant):        ${gradeCounts[2]}`);
  console.log(`    3 (highly relevant): ${gradeCounts[3]}`);
  console.log('');

  if (totalErrors > 0) {
    console.error('Completed with errors.');
    process.exit(1);
  }

  console.log(dryRun ? '[DRY RUN] No writes performed.' : 'Batch grading complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
