// convert-judgments-to-graded.ts
// Phase 4.6.2 — convert legacy eval_golden_dataset.expected_doc_ids to
// grade-3 rows in eval_golden_judgments. Idempotent.
//
// Run: npx tsx src/scripts/convert-judgments-to-graded.ts

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

interface IGoldenRowProps {
  id:               number;
  query:            string;
  expected_doc_ids: number[] | null;
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main(): Promise<void> {
  const { data: rows, error: loadError } = await supabase
    .from('eval_golden_dataset')
    .select('id, query, expected_doc_ids')
    .order('id');

  if (loadError || !rows) {
    console.error('Failed to load golden dataset:', loadError?.message ?? 'no data');
    process.exit(1);
  }

  const goldenRows = rows as IGoldenRowProps[];
  let totalExpected = 0;
  let inserted      = 0;
  let skipped       = 0;
  let errorsCount   = 0;

  for (const goldenRow of goldenRows) {
    const expectedIds = goldenRow.expected_doc_ids ?? [];
    totalExpected += expectedIds.length;

    for (const documentId of expectedIds) {
      const { error: rpcError } = await supabase.rpc('judgment_create', {
        p_golden_id:   goldenRow.id,
        p_document_id: documentId,
        p_grade:       3,
        p_judged_by:   'converter-phase-4.6.2',
        p_notes:       'Auto-converted from legacy expected_doc_ids (grade 3 = canonical answer)',
      });

      if (rpcError) {
        const messageText = rpcError.message ?? '';
        if (messageText.includes('duplicate key') || messageText.includes('unique')) {
          skipped++;
        } else {
          errorsCount++;
          console.error(`  [ERR] golden_id=${goldenRow.id} doc_id=${documentId}: ${messageText}`);
        }
      } else {
        inserted++;
      }
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Conversion summary');
  console.log('='.repeat(60));
  console.log(`  Golden queries scanned:     ${goldenRows.length}`);
  console.log(`  Total expected_doc_ids:     ${totalExpected}`);
  console.log(`  Grade-3 judgments inserted: ${inserted}`);
  console.log(`  Skipped (already existed):  ${skipped}`);
  console.log(`  Errors:                     ${errorsCount}`);
  console.log('');

  if (errorsCount > 0) {
    console.error('Conversion completed with errors. Inspect and re-run.');
    process.exit(1);
  }

  const { count, error: countError } = await supabase
    .from('eval_golden_judgments')
    .select('*', { count: 'exact', head: true })
    .eq('grade', 3)
    .eq('judged_by', 'converter-phase-4.6.2');

  if (countError) {
    console.error('Verification count failed:', countError.message);
    process.exit(1);
  }

  console.log(`Verification: ${count} grade-3 judgments with judged_by='converter-phase-4.6.2' in table.`);
  if (count !== inserted + skipped) {
    console.error(`MISMATCH: expected ${inserted + skipped}, got ${count}`);
    process.exit(1);
  }

  console.log('Conversion verified.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
