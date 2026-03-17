import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { fetchNoteHashes } from '../lib/notes.js';
import { contentHash } from '../lib/hash.js';

export type FileState = 'clean' | 'modified' | 'upstream' | 'conflict' | 'unknown' | 'deleted';

export interface FileStatus {
  file: string;
  state: FileState;
  noteId?: number;
}

export interface CheckResult {
  files: FileStatus[];
  clean: number;
  modified: number;
  upstream: number;
  conflicts: number;
  unknown: number;
  deleted: number;
}

export async function check(config: LedgerConfig): Promise<CheckResult> {
  const result: CheckResult = {
    files: [],
    clean: 0,
    modified: 0,
    upstream: 0,
    conflicts: 0,
    unknown: 0,
    deleted: 0,
  };

  if (!existsSync(config.memoryDir)) {
    console.error('Memory directory not found. Run `ledger pull` first.');
    return result;
  }

  const noteHashes = await fetchNoteHashes(config.supabase);
  const notesByFile = new Map(noteHashes.map(n => [n.localFile, n]));

  const localFiles = readdirSync(config.memoryDir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

  for (const file of localFiles) {
    const filePath = resolve(config.memoryDir, file);
    const localContent = readFileSync(filePath, 'utf-8').trim();
    const localHash = contentHash(localContent);

    const note = notesByFile.get(file);

    if (!note) {
      console.error(`  ${file} — unknown (not in Ledger)`);
      result.files.push({ file, state: 'unknown' });
      result.unknown++;
      notesByFile.delete(file);
      continue;
    }

    const ledgerHash = contentHash(note.content);
    const storedHash = note.contentHash;

    const localChanged = localHash !== storedHash;
    const ledgerChanged = ledgerHash !== storedHash;

    if (!localChanged && !ledgerChanged) {
      console.error(`  ${file} — in sync`);
      result.files.push({ file, state: 'clean', noteId: note.id });
      result.clean++;
    } else if (localChanged && !ledgerChanged) {
      console.error(`  ${file} — modified locally`);
      result.files.push({ file, state: 'modified', noteId: note.id });
      result.modified++;
    } else if (!localChanged && ledgerChanged) {
      console.error(`  ${file} — updated in Ledger`);
      result.files.push({ file, state: 'upstream', noteId: note.id });
      result.upstream++;
    } else {
      console.error(`  ${file} — CONFLICT (both changed)`);
      result.files.push({ file, state: 'conflict', noteId: note.id });
      result.conflicts++;
    }

    notesByFile.delete(file);
  }

  for (const [file, note] of notesByFile) {
    console.error(`  ${file} — missing locally (exists in Ledger)`);
    result.files.push({ file, state: 'deleted', noteId: note.id });
    result.deleted++;
  }

  const summary = [
    `${result.clean} clean`,
    result.modified > 0 ? `${result.modified} modified` : null,
    result.upstream > 0 ? `${result.upstream} upstream` : null,
    result.conflicts > 0 ? `${result.conflicts} conflicts` : null,
    result.unknown > 0 ? `${result.unknown} unknown` : null,
    result.deleted > 0 ? `${result.deleted} deleted` : null,
  ].filter(Boolean).join(', ');

  console.log(`Check: ${summary}`);

  if (result.modified === 0 && result.conflicts === 0 && result.unknown === 0 && result.upstream === 0 && result.deleted === 0) {
    console.log('All synced.');
  }

  return result;
}
