import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { fetchSyncableDocuments } from '../lib/documents/fetching.js';
import { contentHash } from '../lib/hash.js';

export type FileState = 'clean' | 'modified' | 'upstream' | 'conflict' | 'unknown' | 'deleted';

export interface FileStatus {
  file: string;
  state: FileState;
  documentId?: number;
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

  // Fetch all auto-load documents — these are the ones that sync locally
  const syncableDocuments = await fetchSyncableDocuments(config.supabase);

  // Build a map of local filename → document for comparison
  const documentsByFile = new Map(
    syncableDocuments
      .filter(document => document.file_path)
      .map(document => [basename(document.file_path!), document])
  );

  const localFiles = readdirSync(config.memoryDir)
    .filter(file => file.endsWith('.md') && file !== 'MEMORY.md');

  for (const file of localFiles) {
    const filePath = resolve(config.memoryDir, file);
    const localContent = readFileSync(filePath, 'utf-8').trim();
    const localHash = contentHash(localContent);

    const document = documentsByFile.get(file);

    if (!document) {
      console.error(`  ${file} — unknown (not in Ledger)`);
      result.files.push({ file, state: 'unknown' });
      result.unknown++;
      documentsByFile.delete(file);
      continue;
    }

    const ledgerHash = contentHash(document.content);
    const storedHash = document.content_hash;

    const localChanged = localHash !== storedHash;
    const ledgerChanged = ledgerHash !== storedHash;

    if (!localChanged && !ledgerChanged) {
      console.error(`  ${file} — in sync`);
      result.files.push({ file, state: 'clean', documentId: document.id });
      result.clean++;
    } else if (localChanged && !ledgerChanged) {
      console.error(`  ${file} — modified locally`);
      result.files.push({ file, state: 'modified', documentId: document.id });
      result.modified++;
    } else if (!localChanged && ledgerChanged) {
      console.error(`  ${file} — updated in Ledger`);
      result.files.push({ file, state: 'upstream', documentId: document.id });
      result.upstream++;
    } else {
      console.error(`  ${file} — CONFLICT (both changed)`);
      result.files.push({ file, state: 'conflict', documentId: document.id });
      result.conflicts++;
    }

    documentsByFile.delete(file);
  }

  for (const [file, document] of documentsByFile) {
    console.error(`  ${file} — missing locally (exists in Ledger)`);
    result.files.push({ file, state: 'deleted', documentId: document.id });
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
