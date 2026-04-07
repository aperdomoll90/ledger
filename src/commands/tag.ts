import type { LedgerConfig } from '../lib/config.js';
import { getDocumentById } from '../lib/documents/fetching.js';
import { updateDocumentFields } from '../lib/documents/operations.js';

export async function tag(
  config: LedgerConfig,
  id: number,
  options: { description?: string; project?: string; domain?: string; status?: string },
): Promise<void> {
  if (!options.description && !options.project && !options.domain && !options.status) {
    console.error('No fields provided. Use --description, --project, --domain, or --status.');
    process.exit(1);
  }

  const document = await getDocumentById(config.supabase, id);

  if (!document) {
    console.error(`Document ${id} not found.`);
    process.exit(1);
  }

  if (document.protection === 'immutable') {
    console.error(`Document "${document.name}" (id: ${id}) is immutable and cannot be updated.`);
    process.exit(1);
  }

  await updateDocumentFields({ supabase: config.supabase, openai: config.openai }, {
    id,
    description: options.description,
    project: options.project,
    domain: options.domain as any,
    status: options.status as any,
    agent: 'cli',
  });

  console.error(`Document ${id} fields updated.`);
}
