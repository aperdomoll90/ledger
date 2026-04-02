import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { LedgerConfig } from '../lib/config.js';
import { confirm } from '../lib/prompt.js';
import { createDocument } from '../lib/documents/operations.js';
import type { IClientsProps } from '../lib/documents/classification.js';

interface IBackupDocumentProps {
  id: number;
  name: string;
  domain: string;
  document_type: string;
  project: string | null;
  protection: string;
  content: string;
  description: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

export async function restore(config: LedgerConfig, filePath: string): Promise<void> {
  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  let documents: IBackupDocumentProps[];
  try {
    documents = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch {
    console.error('Invalid JSON file.');
    process.exit(1);
  }

  console.error(`Found ${documents.length} documents in backup.`);

  // Check current database
  const { count } = await config.supabase
    .from('documents')
    .select('*', { count: 'exact', head: true });

  if (count && count > 0) {
    console.error(`Database already has ${count} documents.`);
    const proceed = await confirm('Restore will add documents (not replace). Continue?');
    if (!proceed) {
      console.error('Cancelled.');
      return;
    }
  }

  console.error('Restoring...\n');

  const clients: IClientsProps = {
    supabase: config.supabase,
    openai: config.openai,
  };

  let restored = 0;
  let skipped = 0;

  for (const document of documents) {
    // Check for existing document with same name (UNIQUE in v2)
    const { data: existing } = await config.supabase
      .from('documents')
      .select('id')
      .eq('name', document.name)
      .limit(1)
      .single();

    if (existing) {
      console.error(`  skip "${document.name}" (already exists)`);
      skipped++;
      continue;
    }

    try {
      await createDocument(clients, {
        name: document.name,
        domain: document.domain as Parameters<typeof createDocument>[1]['domain'],
        document_type: document.document_type,
        project: document.project ?? undefined,
        protection: document.protection as Parameters<typeof createDocument>[1]['protection'],
        content: document.content,
        description: document.description ?? undefined,
        status: document.status as Parameters<typeof createDocument>[1]['status'] ?? undefined,
      });
    } catch (error) {
      console.error(`  error restoring "${document.name}": ${(error as Error).message}`);
      continue;
    }

    console.error(`  restored "${document.name}"`);
    restored++;
  }

  console.error(`\nRestore complete: ${restored} restored, ${skipped} skipped (already exist)`);
}
