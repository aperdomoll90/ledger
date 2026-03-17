import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { confirm } from '../lib/prompt.js';

interface BackupNote {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function restore(config: LedgerConfig, filePath: string): Promise<void> {
  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  let notes: BackupNote[];
  try {
    notes = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch {
    console.error('Invalid JSON file.');
    process.exit(1);
  }

  console.error(`Found ${notes.length} notes in backup.`);

  // Check current database
  const { count } = await config.supabase
    .from('notes')
    .select('*', { count: 'exact', head: true });

  if (count && count > 0) {
    console.error(`Database already has ${count} notes.`);
    const proceed = await confirm('Restore will add notes (not replace). Continue?');
    if (!proceed) {
      console.error('Cancelled.');
      return;
    }
  }

  console.error('Restoring...\n');

  let restored = 0;
  let skipped = 0;

  for (const note of notes) {
    // Check for existing note with same upsert_key
    const upsertKey = note.metadata.upsert_key as string | undefined;
    if (upsertKey) {
      const { data: existing } = await config.supabase
        .from('notes')
        .select('id')
        .eq('metadata->>upsert_key', upsertKey)
        .limit(1)
        .single();

      if (existing) {
        console.error(`  skip "${upsertKey}" (already exists)`);
        skipped++;
        continue;
      }
    }

    // Generate embedding
    const embeddingResponse = await config.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: note.content,
    });
    const embedding = embeddingResponse.data[0].embedding;

    const { error } = await config.supabase
      .from('notes')
      .insert({
        content: note.content,
        metadata: note.metadata,
        embedding,
      });

    if (error) {
      console.error(`  error restoring note ${note.id}: ${error.message}`);
      continue;
    }

    const label = upsertKey || `note-${note.id}`;
    console.error(`  restored "${label}"`);
    restored++;
  }

  console.error(`\nRestore complete: ${restored} restored, ${skipped} skipped (already exist)`);
}
