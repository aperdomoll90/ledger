import type { LedgerConfig } from '../lib/config.js';
import { getDocumentById } from '../lib/document-fetching.js';
import { updateDocument } from '../lib/document-operations.js';
import { confirm } from '../lib/prompt.js';

export async function update(
  config: LedgerConfig,
  id: number,
  content: string,
): Promise<void> {
  const document = await getDocumentById(config.supabase, id);

  if (!document) {
    console.error(`Document ${id} not found.`);
    process.exit(1);
  }

  if (document.protection === 'immutable') {
    console.error(`Document "${document.name}" (id: ${id}) is immutable and cannot be updated.`);
    process.exit(1);
  }

  console.error(`Document: "${document.name}" (id: ${id})`);
  console.error(`Current content preview: ${document.content.slice(0, 200)}${document.content.length > 200 ? '...' : ''}`);
  console.error(`\nNew content preview: ${content.slice(0, 200)}${content.length > 200 ? '...' : ''}`);

  const proceed = await confirm('\nProceed with update?');

  if (!proceed) {
    console.error('Cancelled.');
    return;
  }

  await updateDocument({ supabase: config.supabase, openai: config.openai }, { id, content, agent: 'cli' });
  console.error(`Document ${id} updated successfully.`);
}
