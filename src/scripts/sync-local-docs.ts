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
import { createDocument, updateDocument } from '../lib/documents/operations.js';

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
  'docs/reference-rag-system-architecture.md':     'reference-rag-system-architecture',
  'docs/reference-rag-core-ingestion.md':         'reference-rag-core-ingestion',
  'docs/reference-rag-core-query-pipeline.md':    'reference-rag-core-query-pipeline',
  'docs/reference-rag-core-database-schemas.md':  'reference-rag-core-database-schemas',
  'docs/reference-rag-quality-evaluation.md':     'reference-rag-quality-evaluation',
  'docs/reference-rag-quality-improvement.md':    'reference-rag-quality-improvement',
  'docs/reference-rag-security-access-control.md':'reference-rag-security-access-control',
  'docs/reference-rag-security-defenses.md':      'reference-rag-security-defenses',
  'docs/reference-rag-operations-observability.md':'reference-rag-operations-observability',
  'docs/reference-rag-operations-scaling.md':     'reference-rag-operations-scaling',
  'docs/reference-rag-operations-deployment.md':  'reference-rag-operations-deployment',
  'docs/reference-rag-interface-api.md':          'reference-rag-interface-api',
};

// Metadata for new docs that don't exist in Ledger yet.
// Only used when creating; updates skip this.
const NEW_DOC_META: Record<string, { domain: 'general' | 'project'; documentType: string; description: string; project?: string }> = {
  'reference-rag-core-ingestion':          { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: ingestion pipeline (extraction, chunking, enrichment, embedding, storage)' },
  'reference-rag-core-query-pipeline':     { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: query pipeline (embedding, retrieval, reranking, generation)' },
  'reference-rag-core-database-schemas':   { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: production database schemas (SQL for all tables, indexes, functions, triggers, RLS)' },
  'reference-rag-quality-evaluation':      { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: evaluation framework (metrics, golden datasets, graded relevance, eval runners)' },
  'reference-rag-quality-improvement':     { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: quality optimization levers (reranker, enrichment, chunking, thresholds)' },
  'reference-rag-security-access-control': { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: access control (RLS, RBAC, JWT auth, document permissions)' },
  'reference-rag-security-defenses':       { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: security defenses (prompt injection, PII, content sanitization)' },
  'reference-rag-operations-observability':{ domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: observability (latency tracking, cost monitoring, cache analytics)' },
  'reference-rag-operations-scaling':      { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: scaling (connection pooling, index tuning, sharding, rate limiting)' },
  'reference-rag-operations-deployment':   { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: deployment (CI/CD, migrations, rollback, monitoring)' },
  'reference-rag-interface-api':           { domain: 'general', documentType: 'knowledge-guide', description: 'RAG reference: API layer (MCP tools, REST endpoints, SDK design)' },
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

    const localContent = readFileSync(filePath, 'utf8');

    if (lookupError || !doc) {
      // Document doesn't exist in Ledger yet. Create it if we have metadata.
      const meta = NEW_DOC_META[docName];
      if (!meta) {
        console.error(`  [SKIP] ${filePath} — no Ledger document named "${docName}" and no creation metadata`);
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  [DRY-CREATE] ${filePath} → NEW "${docName}" (${localContent.length} chars)`);
        synced++;
        continue;
      }

      console.log(`  [CREATE] ${filePath} → "${docName}" (${localContent.length} chars)...`);
      try {
        const newId = await createDocument(clients, {
          name:          docName,
          domain:        meta.domain,
          document_type: meta.documentType,
          content:       localContent,
          description:   meta.description,
          project:       meta.project,
          agent:         'sync-local-docs',
        });
        console.log(`           created #${newId}.`);
        synced++;
      } catch (createError) {
        const message = createError instanceof Error ? createError.message : String(createError);
        console.error(`  [ERR] ${filePath}: ${message}`);
        errors++;
      }
      continue;
    }

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
