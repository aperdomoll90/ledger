#!/usr/bin/env npx tsx
// reindex.ts
// Bulk re-index all documents through the new chunking + enrichment pipeline.
// Reads all active documents, re-chunks with recursive splitter, generates
// context summaries via gpt-4o-mini, re-embeds with enriched vectors, and
// calls document_update RPC (which versions old content before overwriting).
//
// Usage:
//   npx tsx src/scripts/reindex.ts              # dry-run (default — shows what would change)
//   npx tsx src/scripts/reindex.ts --execute    # actually re-index all documents
//   npx tsx src/scripts/reindex.ts --id 42      # re-index one document (dry-run)
//   npx tsx src/scripts/reindex.ts --id 42 --execute  # re-index one document (write)

import 'dotenv/config';
import { loadConfig } from '../lib/config.js';
import { updateDocument } from '../lib/documents/operations.js';

interface IReindexDocumentProps {
  id: number;
  name: string;
  content: string;
  chunk_count: number;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes('--execute');
  const singleIdFlag = process.argv.indexOf('--id');
  const singleId = singleIdFlag !== -1 ? Number(process.argv[singleIdFlag + 1]) : null;

  const config = loadConfig();
  const clients = {
    supabase: config.supabase,
    openai: config.openai,
  };

  console.error(dryRun ? '=== DRY RUN (pass --execute to write) ===' : '=== EXECUTING RE-INDEX ===');

  // Fetch documents
  let query = config.supabase
    .from('documents')
    .select('id, name, content, chunk_count')
    .is('deleted_at', null)
    .order('id', { ascending: true });

  if (singleId !== null) {
    query = query.eq('id', singleId);
  }

  const { data: documents, error } = await query;
  if (error) throw new Error(`Failed to fetch documents: ${error.message}`);

  const documentList = documents as IReindexDocumentProps[];
  console.error(`Found ${documentList.length} documents to re-index\n`);

  let successCount = 0;
  let failureCount = 0;

  for (const document of documentList) {
    const contentLength = document.content?.length ?? 0;
    const estimatedChunks = Math.max(1, Math.ceil(contentLength / 1000));

    if (dryRun) {
      console.error(`[DRY] #${document.id} ${document.name} — ${contentLength} chars, ${document.chunk_count} chunks → ~${estimatedChunks} chunks`);
      successCount++;
      continue;
    }

    try {
      console.error(`[${successCount + failureCount + 1}/${documentList.length}] #${document.id} ${document.name} — re-indexing...`);

      await updateDocument(clients, {
        id: document.id,
        content: document.content,
        agent: 'reindex-script',
      });

      successCount++;
      console.error(`  done (${contentLength} chars → ~${estimatedChunks} chunks)`);
    } catch (reindexError) {
      failureCount++;
      console.error(`  FAILED: ${reindexError instanceof Error ? reindexError.message : String(reindexError)}`);
    }
  }

  console.error(`\n=== Summary ===`);
  console.error(`Success: ${successCount} | Failed: ${failureCount} | Total: ${documentList.length}`);
  if (dryRun) {
    console.error('This was a dry run. Pass --execute to actually re-index.');
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
