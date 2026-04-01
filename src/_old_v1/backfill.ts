import type { LedgerConfig } from '../lib/config.js';
import { backfillMetadata } from '../lib/backfill.js';

interface BackfillOptions {
  dryRun: boolean;
}

export async function backfill(config: LedgerConfig, options: BackfillOptions): Promise<void> {
  const { dryRun } = options;

  console.error('Fetching all notes...');
  const { data: notes, error } = await config.supabase
    .from('notes')
    .select('id, metadata')
    .order('id', { ascending: true });

  if (error) {
    console.error(`Error fetching notes: ${error.message}`);
    process.exit(1);
  }

  if (!notes || notes.length === 0) {
    console.error('No notes found.');
    return;
  }

  console.error(`Found ${notes.length} notes. Running v2 backfill...`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const note of notes) {
    const oldMeta = note.metadata as Record<string, unknown>;
    const newMeta = backfillMetadata(oldMeta);

    // Check if anything changed (idempotent skip)
    if (JSON.stringify(oldMeta) === JSON.stringify(newMeta)) {
      skipped++;
      continue;
    }

    if (dryRun) {
      const oldType = oldMeta.type as string ?? '?';
      const newType = newMeta.type as string ?? '?';
      const domain = newMeta.domain as string ?? '?';
      const key = oldMeta.upsert_key as string ?? `id-${note.id}`;
      console.error(`  [${note.id}] ${key}: ${oldType} → ${domain}/${newType}`);
      migrated++;
      continue;
    }

    const { error: updateError } = await config.supabase
      .from('notes')
      .update({ metadata: newMeta })
      .eq('id', note.id);

    if (updateError) {
      console.error(`  [${note.id}] ERROR: ${updateError.message}`);
      errors++;
    } else {
      migrated++;
    }
  }

  console.error(`\nBackfill ${dryRun ? '(dry run) ' : ''}complete:`);
  console.error(`  ${migrated} migrated, ${skipped} already up-to-date, ${errors} errors`);

  if (dryRun && migrated > 0) {
    console.error('\nRun without --dry-run to apply changes.');
  }
}
