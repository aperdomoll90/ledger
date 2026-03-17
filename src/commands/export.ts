import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { searchNotes } from '../lib/notes.js';
import { fatal, ExitCode } from '../lib/errors.js';

export async function exportNote(
  config: LedgerConfig,
  query: string,
  outputPath?: string,
): Promise<void> {
  const results = await searchNotes(config.supabase, config.openai, query);

  if (results.length === 0) {
    fatal('No matching notes found.', ExitCode.NOTE_NOT_FOUND);
  }

  const note = results[0];
  const upsertKey = (note.metadata.upsert_key as string) || `note-${note.id}`;
  const filename = `${upsertKey}.md`;

  const targetPath = outputPath
    ? resolve(outputPath, filename)
    : resolve(process.cwd(), filename);

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, note.content + '\n', 'utf-8');

  // No hash stored — export is untracked
  console.log(`Exported "${upsertKey}" → ${targetPath}`);
  console.log(targetPath);
}
