// sync-local-docs.ts
// Push local docs/* files to their matching Ledger documents.
// Handles any file size — chunks, embeds, and updates via the proper
// updateDocument() pipeline (not the MCP tool).
//
// Usage:
//   npx tsx src/scripts/sync-local-docs.ts                    # sync all known docs
//   npx tsx src/scripts/sync-local-docs.ts --file docs/foo.md # sync one file
//   npx tsx src/scripts/sync-local-docs.ts --dry-run          # show what would sync

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { readFileSync, existsSync } from 'fs';
import type { IClientsProps } from '../lib/documents/classification.js';
import { updateDocument } from '../lib/documents/operations.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey   = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey || !openaiKey) {
  console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or OPENAI_API_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const openai   = new OpenAI({ apiKey: openaiKey });
const clients: IClientsProps = { supabase, openai, cohereApiKey: undefined };

const dryRun     = process.argv.includes('--dry-run');
const fileArgIdx = process.argv.indexOf('--file');
const singleFile = fileArgIdx >= 0 ? process.argv[fileArgIdx + 1] : null;

// Map of local file paths to Ledger document names.
// Add entries here as docs are created.
const FILE_TO_DOC: Record<string, string> = {
  'docs/ledger-architecture.md':                  'ledger-architecture',
  'docs/ledger-architecture-database.md':         'ledger-architecture-database',
  'docs/ledger-architecture-database-tables.md':  'ledger-architecture-database-tables',
  'docs/ledger-architecture-database-schemas.md': 'ledger-architecture-database-schemas',
  'docs/ledger-architecture-database-indexes.md': 'ledger-architecture-database-indexes',
  'docs/ledger-architecture-database-functions.md': 'ledger-architecture-database-functions',
  'docs/reference-rag-evaluation.md':             'reference-rag-evaluation',
  'docs/reference-rag-database-schemas.md':       'reference-rag-database-schemas',
  'docs/reference-rag-system-architecture.md':    'reference-rag-system-architecture',
};

async function main(): Promise<void> {
  const filesToSync = singleFile
    ? { [singleFile]: FILE_TO_DOC[singleFile] }
    : FILE_TO_DOC;

  let synced  = 0;
  let skipped = 0;
  let errors  = 0;

  for (const [filePath, docName] of Object.entries(filesToSync)) {
    if (!docName) {
      console.error(`  [SKIP] ${filePath} — not in FILE_TO_DOC mapping`);
      skipped++;
      continue;
    }

    if (!existsSync(filePath)) {
      console.error(`  [SKIP] ${filePath} — file not found`);
      skipped++;
      continue;
    }

    // Look up the document id by name
    const { data: doc, error: lookupError } = await supabase
      .from('documents')
      .select('id, content_hash')
      .eq('name', docName)
      .single();

    if (lookupError) {
      console.error(`  [ERR] ${filePath} — lookup failed for "${docName}": ${lookupError.message}`);
      errors++;
      continue;
    }
    if (!doc) {
      console.error(`  [SKIP] ${filePath} — no Ledger document named "${docName}"`);
      skipped++;
      continue;
    }

    const localContent = readFileSync(filePath, 'utf8');

    if (dryRun) {
      console.log(`  [DRY] ${filePath} → #${doc.id} ${docName} (${localContent.length} chars)`);
      synced++;
      continue;
    }

    console.log(`  [SYNC] ${filePath} → #${doc.id} ${docName} (${localContent.length} chars)...`);

    try {
      await updateDocument(clients, {
        id:      doc.id,
        content: localContent,
        agent:   'sync-local-docs',
      });
      console.log(`         done.`);
      synced++;
    } catch (syncError) {
      const message = syncError instanceof Error ? syncError.message : String(syncError);
      console.error(`  [ERR] ${filePath}: ${message}`);
      errors++;
    }
  }

  console.log('');
  console.log(`Synced: ${synced}, Skipped: ${skipped}, Errors: ${errors}`);
  if (dryRun) console.log('[DRY RUN] No writes performed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
