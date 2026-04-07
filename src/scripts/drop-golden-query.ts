// drop-golden-query.ts
// One-off: remove the "all system rules and sync rules" enumeration query
// from eval_golden_dataset. It's a listing query, not a retrieval test.
//
// Run: npx tsx src/scripts/drop-golden-query.ts

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const TARGET_QUERY = 'all system rules and sync rules';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main(): Promise<void> {
  const { data: matches, error: findError } = await supabase
    .from('eval_golden_dataset')
    .select('id, query, expected_doc_ids, tags')
    .eq('query', TARGET_QUERY);

  if (findError) {
    console.error('Lookup failed:', findError.message);
    process.exit(1);
  }

  if (!matches || matches.length === 0) {
    console.log(`No row found with query: "${TARGET_QUERY}"`);
    process.exit(0);
  }

  if (matches.length > 1) {
    console.error(`Refusing to delete: found ${matches.length} matching rows. Inspect manually.`);
    console.error(matches);
    process.exit(1);
  }

  const targetRow = matches[0];
  console.log('Found row:');
  console.log(`  id:               ${targetRow.id}`);
  console.log(`  query:            "${targetRow.query}"`);
  console.log(`  expected_doc_ids: ${JSON.stringify(targetRow.expected_doc_ids)}`);
  console.log(`  tags:             ${JSON.stringify(targetRow.tags)}`);

  const { error: deleteError } = await supabase
    .from('eval_golden_dataset')
    .delete()
    .eq('id', targetRow.id);

  if (deleteError) {
    console.error('Delete failed:', deleteError.message);
    process.exit(1);
  }

  console.log(`\nDeleted row id ${targetRow.id}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
