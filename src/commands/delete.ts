import type { LedgerConfig } from '../lib/config.js';
import { getDocumentById } from '../lib/documents/fetching.js';
import { deleteDocument } from '../lib/documents/operations.js';
import { confirm } from '../lib/prompt.js';

export async function deleteNote(
  config: LedgerConfig,
  id: number,
): Promise<void> {
  const document = await getDocumentById(config.supabase, id);

  if (!document) {
    console.error(`Document ${id} not found.`);
    process.exit(1);
  }

  if (document.protection === 'immutable') {
    console.error(`Document "${document.name}" (id: ${id}) is immutable and cannot be deleted.`);
    process.exit(1);
  }

  console.error(`Document: "${document.name}" (id: ${id})`);
  console.error(`Domain: ${document.domain} | Type: ${document.document_type}`);
  console.error(`Protection: ${document.protection}`);
  console.error(`Content preview: ${document.content.slice(0, 200)}${document.content.length > 200 ? '...' : ''}`);

  const proceed = await confirm('\nProceed with deletion?');

  if (!proceed) {
    console.error('Cancelled.');
    return;
  }

  await deleteDocument({ supabase: config.supabase, openai: config.openai }, id, 'cli');
  console.error(`Document ${id} soft-deleted. Can be restored within 30 days.`);
}
