// migrate-v2.ts
// One-time migration: read from old `notes` table, write to new `documents` table.
// Each note becomes a document via createDocument() RPC (chunk + embed + audit).
//
// Run: npx tsx src/scripts/migrate-v2.ts
// Dry run: npx tsx src/scripts/migrate-v2.ts --dry-run

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import type { IClientsProps, ICreateDocumentProps, Domain, Protection, OwnerType, DocumentStatus, SourceType } from '../lib/document-classification.js';
import { createDocument } from '../lib/document-operations.js';

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

const DRY_RUN = process.argv.includes('--dry-run');

// =============================================================================
// Old note shape
// =============================================================================

interface OldNote {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

// Valid values for constrained fields — reject anything outside these
const VALID_DOMAINS: Set<string> = new Set(['system', 'persona', 'workspace', 'project', 'general']);
const VALID_PROTECTIONS: Set<string> = new Set(['open', 'guarded', 'protected', 'immutable']);
const VALID_OWNER_TYPES: Set<string> = new Set(['system', 'user', 'team']);
const VALID_STATUSES: Set<string> = new Set(['idea', 'planning', 'active', 'done']);
const VALID_SOURCE_TYPES: Set<string> = new Set(['text', 'pdf', 'docx', 'spreadsheet', 'code', 'image', 'audio', 'video', 'web', 'email', 'slides', 'handwriting']);

// =============================================================================
// Field mapping
// =============================================================================

function mapNoteToDocument(note: OldNote): ICreateDocumentProps {
  const meta = note.metadata;

  const domain = typeof meta.domain === 'string' && VALID_DOMAINS.has(meta.domain) ? meta.domain as Domain : 'general';
  const protection = typeof meta.protection === 'string' && VALID_PROTECTIONS.has(meta.protection) ? meta.protection as Protection : 'open';
  const ownerType = typeof meta.owner_type === 'string' && VALID_OWNER_TYPES.has(meta.owner_type) ? meta.owner_type as OwnerType : 'user';
  const status = typeof meta.status === 'string' && VALID_STATUSES.has(meta.status) ? meta.status as DocumentStatus : undefined;
  const sourceType = typeof meta.source_type === 'string' && VALID_SOURCE_TYPES.has(meta.source_type) ? meta.source_type as SourceType : 'text';

  return {
    name: (meta.upsert_key as string) ?? `note-${note.id}`,
    domain,
    document_type: (meta.type as string) ?? 'reference',
    content: note.content,
    description: meta.description as string | undefined,
    project: meta.project as string | undefined,
    protection,
    owner_type: ownerType,
    owner_id: meta.owner_id as string | undefined,
    is_auto_load: meta.auto_load === true,
    source_type: sourceType,
    file_path: meta.file_path as string | undefined,
    file_permissions: meta.file_permissions as string | undefined,
    agent: 'migrate-v2',
    status,
    skill_ref: meta.skill_ref as string | undefined,
    embedding_model_id: 'openai/text-embedding-3-small',
  };
}

// =============================================================================
// Migration
// =============================================================================

async function migrate() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Ledger v2 Migration${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  // Read all notes
  const { data: notes, error } = await clients.supabase
    .from('notes')
    .select('id, content, metadata, created_at')
    .order('id', { ascending: true });

  if (error) {
    console.error('Failed to read notes:', error.message);
    process.exit(1);
  }

  if (!notes || notes.length === 0) {
    console.log('No notes found. Nothing to migrate.');
    return;
  }

  console.log(`Found ${notes.length} notes to migrate.\n`);

  const results: { oldId: number; name: string; newId?: number; error?: string }[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const note of notes as OldNote[]) {
    const props = mapNoteToDocument(note);

    const index = notes.indexOf(note);
    const total = notes.length;
    const pct = Math.round(((index + 1) / total) * 100);
    const filled = Math.round(pct / 2.5);
    const bar = '█'.repeat(filled) + '░'.repeat(40 - filled);

    if (DRY_RUN) {
      process.stdout.write(`\r[${bar}] ${pct}% (${index + 1}/${total}) ${props.name.slice(0, 40).padEnd(40)}`);
      results.push({ oldId: note.id, name: props.name });
      skipped++;
      continue;
    }

    try {
      const newId = await createDocument(clients, props);
      process.stdout.write(`\r[${bar}] ${pct}% (${index + 1}/${total}) ${props.name.slice(0, 40).padEnd(40)}`);
      results.push({ oldId: note.id, name: props.name, newId });
      succeeded++;
    } catch (err) {
      const message = (err as Error).message;
      process.stdout.write(`\r[${bar}] ${pct}% (${index + 1}/${total}) FAIL: ${props.name.slice(0, 30)}\n`);
      results.push({ oldId: note.id, name: props.name, error: message });
      failed++;
    }
  }

  // Clear progress bar line
  process.stdout.write('\n');

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('Migration Summary');
  console.log(`${'='.repeat(60)}`);
  console.log(`Total notes:  ${notes.length}`);
  if (DRY_RUN) {
    console.log(`Dry run:      ${skipped} would be migrated`);
  } else {
    console.log(`Succeeded:    ${succeeded}`);
    console.log(`Failed:       ${failed}`);
  }
  console.log();

  if (failed > 0) {
    console.log('Failed notes:');
    for (const result of results) {
      if (result.error) {
        console.log(`  note ${result.oldId} "${result.name}": ${result.error}`);
      }
    }
  }
}

migrate().catch((err) => {
  console.error('Migration crashed:', err);
  process.exit(1);
});
