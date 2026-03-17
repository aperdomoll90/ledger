import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';
import type { LedgerConfig } from '../lib/config.js';
import { searchNotes } from '../lib/notes.js';
import { fatal, ExitCode } from '../lib/errors.js';

const VIEW_DIR = '/tmp/ledger-view';

interface ShowOptions {
  type?: string;
  project?: string;
}

export async function show(config: LedgerConfig, query: string, options: ShowOptions = {}): Promise<void> {
  // Fetch more if filtering
  const fetchLimit = (options.type || options.project) ? 10 : 1;
  let results = await searchNotes(config.supabase, config.openai, query, 0.3, fetchLimit);

  if (options.type) {
    results = results.filter(n => (n.metadata as Record<string, unknown>).type === options.type);
  }
  if (options.project) {
    results = results.filter(n => (n.metadata as Record<string, unknown>).project === options.project);
  }

  if (results.length === 0) {
    fatal('No matching notes found.', ExitCode.NOTE_NOT_FOUND);
  }

  const note = results[0];
  const upsertKey = (note.metadata.upsert_key as string) || `note-${note.id}`;
  const filename = `${upsertKey}.md`;

  mkdirSync(VIEW_DIR, { recursive: true });
  const filePath = resolve(VIEW_DIR, filename);
  writeFileSync(filePath, note.content + '\n', 'utf-8');

  console.log(`Match: "${upsertKey}" (similarity: ${note.similarity.toFixed(3)})`);
  console.log(filePath);

  try {
    execFileSync('code', [filePath], { stdio: 'ignore' });
  } catch {
    // VS Code not available — path already printed
  }
}
