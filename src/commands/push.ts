import { readFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { findNoteByFile, updateNoteContent, updateNoteHash } from '../lib/notes.js';
import { contentHash } from '../lib/hash.js';
import { fatal, ExitCode } from '../lib/errors.js';

export async function push(config: LedgerConfig, filePath: string): Promise<void> {
  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    fatal(`File not found: ${absPath}`, ExitCode.FILE_NOT_FOUND);
  }

  const filename = basename(absPath);
  const content = readFileSync(absPath, 'utf-8').trim();

  const existing = await findNoteByFile(config.supabase, filename);

  if (!existing) {
    fatal(
      `No Ledger note matching "${filename}" found. Add it via MCP first.`,
      ExitCode.NOTE_NOT_FOUND,
    );
  }

  await updateNoteContent(config.supabase, config.openai, existing.id, content);

  const hash = contentHash(content);
  await updateNoteHash(config.supabase, existing.id, hash);

  console.log(`Pushed ${filename} → Ledger (note ${existing.id})`);
}
