import { readFileSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { listDocuments } from '../lib/documents/fetching.js';
import { updateDocument } from '../lib/documents/operations.js';
import { fatal, ExitCode } from '../lib/errors.js';

export async function push(config: LedgerConfig, filePath: string): Promise<void> {
  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    fatal(`File not found: ${absPath}`, ExitCode.FILE_NOT_FOUND);
  }

  const filename = basename(absPath);
  const content = readFileSync(absPath, 'utf-8').trim();

  // Find document by file_path matching the filename
  const documents = await listDocuments(config.supabase, { limit: 100 });
  const existing = documents.find(
    document => document.file_path && basename(document.file_path) === filename
  );

  if (!existing) {
    fatal(
      `No Ledger document matching "${filename}" found. Add it via MCP first.`,
      ExitCode.DOCUMENT_NOT_FOUND,
    );
  }

  await updateDocument(
    { supabase: config.supabase, openai: config.openai },
    { id: existing.id, content, agent: 'cli' },
  );

  console.log(`Pushed ${filename} → Ledger (document ${existing.id}, "${existing.name}")`);
}
