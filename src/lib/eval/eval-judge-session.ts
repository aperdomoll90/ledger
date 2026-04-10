// eval-judge-session.ts
// Session state, input parsing, progress rendering, and durable writes for
// the `ledger eval:judge` rejudging walkthrough.

import { createInterface, type Interface as IReadlineInterface } from 'node:readline';
import type { IClientsProps } from '../documents/classification.js';
import { searchHybrid } from '../search/ai-search.js';
import { CURRENT_SEARCH_CONFIG } from './eval-store.js';

// =============================================================================
// Types
// =============================================================================

export interface IUngradedCandidateProps {
  document_id: number;
  graded:      boolean;
}

export interface IProgressProps {
  queriesComplete:  number;
  queriesTotal:     number;
  judgmentsTotal:   number;
}

export type TJudgeInput =
  | { kind: 'grade';   value: 0 | 1 | 2 | 3 }
  | { kind: 'skip' }
  | { kind: 'back' }
  | { kind: 'note' }
  | { kind: 'rubric' }
  | { kind: 'quit' }
  | { kind: 'invalid'; raw: string };

interface IJudgmentRowProps {
  document_id: number;
  grade:       number;
}

interface IGoldenProgressProps {
  id:               number;
  query:            string;
  tags:             string[];
  existing_grades:  Map<number, number>;
}

// =============================================================================
// Pure helpers (unit-tested)
// =============================================================================

export function parseGradeInput(rawInput: string): TJudgeInput {
  const input = rawInput.trim();
  if (input === '0' || input === '1' || input === '2' || input === '3') {
    return { kind: 'grade', value: parseInt(input, 10) as 0 | 1 | 2 | 3 };
  }
  if (input === 's') return { kind: 'skip' };
  if (input === 'b') return { kind: 'back' };
  if (input === 'n') return { kind: 'note' };
  if (input === '?') return { kind: 'rubric' };
  if (input === 'q') return { kind: 'quit' };
  return { kind: 'invalid', raw: input };
}

export function pickNextUngraded(
  candidates: IUngradedCandidateProps[],
): IUngradedCandidateProps | null {
  for (const candidate of candidates) {
    if (!candidate.graded) return candidate;
  }
  return null;
}

export function formatProgressLine(progress: IProgressProps): string {
  const percentage = progress.queriesTotal > 0
    ? Math.round((progress.queriesComplete / progress.queriesTotal) * 100)
    : 0;
  return `Progress: ${progress.queriesComplete} / ${progress.queriesTotal} queries complete (${percentage}%). Judgments: ${progress.judgmentsTotal}.`;
}

// =============================================================================
// Rubric
// =============================================================================

const RUBRIC_TEXT = `
TREC 4-level grading rubric:

  0  NOT RELEVANT    No useful info for this query. Wrong topic.
  1  RELATED         Touches the topic but doesn't answer.
  2  RELEVANT        Answers the query, but not the ideal/canonical source.
  3  HIGHLY RELEVANT The canonical, complete answer.

Boundary heuristics:
  1 vs 2: "Would a user be happy if this was the top result?" Yes = 2, No = 1.
  2 vs 3: "Is there a better doc for this query that I know exists?" Yes = 2, No = 3.
`;

// =============================================================================
// Database I/O
// =============================================================================

async function loadNextGolden(
  supabase: IClientsProps['supabase'],
  startId: number = 0,
): Promise<IGoldenProgressProps | null> {
  const { data, error } = await supabase
    .from('eval_golden_dataset')
    .select('id, query, tags, judgments:eval_golden_judgments(document_id, grade)')
    .gte('id', startId)
    .order('id', { ascending: true });

  if (error) {
    process.stderr.write(`[ledger] loadNextGolden failed: ${error.message}\n`);
    return null;
  }
  if (!data) return null;

  for (const row of data as Array<{ id: number; query: string; tags: string[] | null; judgments: IJudgmentRowProps[] | null }>) {
    const gradedMap = new Map<number, number>();
    for (const judgment of row.judgments ?? []) {
      gradedMap.set(judgment.document_id, judgment.grade);
    }
    return {
      id:              row.id,
      query:           row.query,
      tags:            row.tags ?? [],
      existing_grades: gradedMap,
    };
  }
  return null;
}

async function fetchProgress(supabase: IClientsProps['supabase']): Promise<IProgressProps> {
  const { count: queriesTotal } = await supabase
    .from('eval_golden_dataset')
    .select('*', { count: 'exact', head: true });

  const { count: judgmentsTotal } = await supabase
    .from('eval_golden_judgments')
    .select('*', { count: 'exact', head: true });

  const { data: rpcData } = await supabase
    .rpc('count_golden_with_min_judgments', { p_min: 10 });

  const queriesComplete = typeof rpcData === 'number' ? rpcData : 0;

  return {
    queriesTotal:    queriesTotal ?? 0,
    queriesComplete,
    judgmentsTotal:  judgmentsTotal ?? 0,
  };
}

// =============================================================================
// Prompt helper
// =============================================================================

function promptUser(readline: IReadlineInterface, question: string): Promise<string> {
  return new Promise(resolve => {
    readline.question(question, (answer) => resolve(answer));
  });
}

function snippet(content: string | null, maxChars: number = 200): string {
  if (!content) return '';
  return content.replace(/\s+/g, ' ').slice(0, maxChars);
}

// =============================================================================
// Interactive session
// =============================================================================

export async function runJudgeSession(
  clients: IClientsProps,
  startGoldenId?: number,
): Promise<void> {
  const supabase = clients.supabase;
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    let currentId = startGoldenId ?? 0;

    while (true) {
      const progress = await fetchProgress(supabase);
      console.log('');
      console.log(formatProgressLine(progress));
      console.log('');

      const golden = await loadNextGolden(supabase, currentId);
      if (!golden) {
        console.log('No more queries to judge. Done.');
        return;
      }

      // Run search for this query
      const searchResults = await searchHybrid(clients, {
        query: golden.query,
        limit: CURRENT_SEARCH_CONFIG.limit as number,
        reranker: CURRENT_SEARCH_CONFIG.reranker as 'none' | 'cohere',
      });

      // Build candidate list from top 10
      const candidates: Array<{
        id:      number;
        name:    string;
        score:   number;
        content: string;
        graded:  boolean;
      }> = [];

      for (const result of searchResults.slice(0, 10)) {
        candidates.push({
          id:      result.id,
          name:    result.name ?? '<unknown>',
          score:   result.score ?? result.similarity ?? 0,
          content: snippet(result.content),
          graded:  golden.existing_grades.has(result.id),
        });
      }

      const ungradedList = candidates.filter(candidate => !candidate.graded);
      if (ungradedList.length === 0) {
        // This query is fully graded. Advance.
        currentId = golden.id + 1;
        continue;
      }

      // Print header
      console.log('='.repeat(60));
      console.log(`Query #${golden.id}: "${golden.query}"`);
      if (golden.tags.length > 0) console.log(`Tags: ${golden.tags.join(', ')}`);
      if (golden.existing_grades.size > 0) {
        console.log('Already graded:');
        for (const [documentId, grade] of golden.existing_grades.entries()) {
          console.log(`  #${documentId} -> ${grade}`);
        }
      }
      console.log('='.repeat(60));

      let pendingNote: string | null = null;
      let candidateIndex = 0;

      while (candidateIndex < ungradedList.length) {
        const candidate = ungradedList[candidateIndex];
        console.log('');
        console.log(`[${candidateIndex + 1}/${ungradedList.length}]  #${candidate.id} ${candidate.name}  (score ${candidate.score.toFixed(3)})`);
        console.log(`"${candidate.content}..."`);

        const answer = await promptUser(readline, 'Grade [0/1/2/3]  s=skip  b=back  n=notes  ?=rubric  q=save & quit: ');
        const parsed = parseGradeInput(answer);

        if (parsed.kind === 'invalid') {
          console.log(`(unrecognized input "${parsed.raw}". Press ? for rubric.)`);
          continue;
        }

        if (parsed.kind === 'rubric') {
          console.log(RUBRIC_TEXT);
          continue;
        }

        if (parsed.kind === 'note') {
          pendingNote = await promptUser(readline, 'Note: ');
          continue;
        }

        if (parsed.kind === 'quit') {
          console.log('Saving and exiting.');
          return;
        }

        if (parsed.kind === 'skip') {
          candidateIndex++;
          pendingNote = null;
          continue;
        }

        if (parsed.kind === 'back') {
          if (candidateIndex > 0) candidateIndex--;
          pendingNote = null;
          continue;
        }

        // Grade: durable write via RPC
        const { error: rpcError } = await supabase.rpc('judgment_create', {
          p_golden_id:   golden.id,
          p_document_id: candidate.id,
          p_grade:       parsed.value,
          p_judged_by:   'adrian',
          p_notes:       pendingNote,
        });

        if (rpcError) {
          // Duplicate? Try update instead.
          const { error: updateError } = await supabase.rpc('judgment_update', {
            p_golden_id:   golden.id,
            p_document_id: candidate.id,
            p_grade:       parsed.value,
            p_notes:       pendingNote,
          });
          if (updateError) {
            console.error(`  [ERR] Could not save grade: ${updateError.message}`);
            continue;
          }
        }

        pendingNote = null;
        candidateIndex++;
      }

      console.log(`Query #${golden.id} complete.`);
      currentId = golden.id + 1;
    }
  } finally {
    readline.close();
  }
}
