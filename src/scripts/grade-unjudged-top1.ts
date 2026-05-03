// grade-unjudged-top1.ts
// Targeted grading for queries where the top-1 document has no judgment.
// Shows the query, document name, and a content preview. You type 0-3.
//
// Run: npx tsx src/scripts/grade-unjudged-top1.ts
// Dry run: npx tsx src/scripts/grade-unjudged-top1.ts --dry-run

import 'dotenv/config';
import { resolve } from 'path';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { createInterface } from 'node:readline';

config({ path: resolve(process.env.HOME ?? '', '.ledger', '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const dryRun = process.argv.includes('--dry-run');

// The 11 unjudged pairs from run 17 diagnostic (query text + top doc ID)
const UNJUDGED_PAIRS = [
  { query: 'how does Ledger process a search query end to end',             docId: 152 },
  { query: 'how does chunking work for embeddings',                         docId: 160 },
  { query: 'how does Ledger\'s audit log track document changes',           docId: 152 },
  { query: 'what is Ledger\'s query cache and how does it work',            docId: 152 },
  { query: 'how does Ledger protect sensitive documents with access control', docId: 144 },
  { query: 'document_create RPC',                                           docId: 152 },
  { query: 'Ledger text-embedding-3-small embedding model',                 docId: 152 },
  { query: 'Ledger keyword search websearch_to_tsquery GIN index',          docId: 152 },
  { query: 'soft delete deleted_at document_purge',                         docId: 162 },
  { query: 'ledger architecture all sections',                              docId: 144 },
  { query: 'what is the right way to write a custom skill',                 docId: 163 },
];

const RUBRIC = `
  0 = NOT RELEVANT    Wrong topic, no useful info
  1 = RELATED         Touches the topic but doesn't answer
  2 = RELEVANT        Answers the query (user would be happy with this result)
  3 = HIGHLY RELEVANT The canonical, best-possible answer
`;

async function main(): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(resolve => readline.question(q, resolve));

  console.log('='.repeat(60));
  console.log('Targeted grading: 12 unjudged top-1 documents');
  console.log(dryRun ? '(DRY RUN: no writes)' : '(LIVE: writes to eval_golden_judgments)');
  console.log('='.repeat(60));
  console.log(RUBRIC);

  let graded = 0;
  let skipped = 0;

  for (let i = 0; i < UNJUDGED_PAIRS.length; i++) {
    const pair = UNJUDGED_PAIRS[i];

    // Look up golden dataset ID for this query
    const { data: goldenRows } = await supabase
      .from('eval_golden_dataset')
      .select('id')
      .eq('query', pair.query)
      .limit(1);

    const goldenId = goldenRows?.[0]?.id;
    if (!goldenId) {
      console.log(`\n[${i + 1}/12] SKIP: query not found in golden dataset: "${pair.query}"`);
      skipped++;
      continue;
    }

    // Fetch document name and content preview
    const { data: docRow } = await supabase
      .from('documents')
      .select('name, content')
      .eq('id', pair.docId)
      .single();

    const docName = docRow?.name ?? '(unknown)';
    const preview = docRow?.content
      ? docRow.content.slice(0, 300).replace(/\n/g, ' ')
      : '(no content)';

    console.log('\n' + '-'.repeat(60));
    console.log(`[${i + 1}/12]  Query: "${pair.query}"`);
    console.log(`  Doc #${pair.docId}: ${docName}`);
    console.log(`  Preview: ${preview}...`);
    console.log('-'.repeat(60));

    let grade: number | null = null;
    while (grade === null) {
      const input = await ask('Grade (0/1/2/3) or s=skip, q=quit: ');
      const trimmed = input.trim();
      if (trimmed === 'q') {
        console.log(`\nQuit. Graded ${graded}, skipped ${skipped + (UNJUDGED_PAIRS.length - i)}.`);
        readline.close();
        return;
      }
      if (trimmed === 's') {
        skipped++;
        break;
      }
      if (['0', '1', '2', '3'].includes(trimmed)) {
        grade = parseInt(trimmed, 10);
      } else {
        console.log('  Invalid. Type 0, 1, 2, 3, s, or q.');
      }
    }

    if (grade === null) continue; // skipped

    if (dryRun) {
      console.log(`  [DRY RUN] Would save: golden_id=${goldenId}, doc_id=${pair.docId}, grade=${grade}`);
    } else {
      const { error } = await supabase.rpc('judgment_create', {
        p_golden_id:   goldenId,
        p_document_id: pair.docId,
        p_grade:       grade,
        p_judged_by:   'adrian',
        p_notes:       'unjudged top-1 from run-16 diagnostic',
      });

      if (error) {
        // Might already exist (race condition), try update
        const { error: updateError } = await supabase.rpc('judgment_update', {
          p_golden_id:   goldenId,
          p_document_id: pair.docId,
          p_grade:       grade,
          p_notes:       'unjudged top-1 from run-16 diagnostic',
        });
        if (updateError) {
          console.log(`  [ERR] Failed to save: ${updateError.message}`);
          continue;
        }
      }
      console.log(`  Saved: grade ${grade}`);
    }
    graded++;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Done. Graded: ${graded}, Skipped: ${skipped}`);
  console.log('='.repeat(60));
  readline.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
