import type { LedgerConfig } from '../lib/config.js';
import { listDocuments } from '../lib/document-fetching.js';

export async function list(
  config: LedgerConfig,
  options: { limit: number; type?: string; project?: string; domain?: string },
): Promise<void> {
  const documents = await listDocuments(config.supabase, {
    limit: options.limit,
    document_type: options.type,
    project: options.project,
    domain: options.domain as any,
  });

  if (documents.length === 0) {
    console.error('No documents found.');
    process.exit(0);
  }

  const formatted = documents.map(document => {
    return [
      `[${document.id}] ${document.name}`,
      `  Domain: ${document.domain} | Type: ${document.document_type}${document.project ? ` | Project: ${document.project}` : ''}`,
      `  Protection: ${document.protection} | Auto-load: ${document.is_auto_load}`,
      document.description ? `  Description: ${document.description}` : null,
      `  Content: ${document.content.slice(0, 150)}${document.content.length > 150 ? '...' : ''}`,
      `  Updated: ${document.updated_at}`,
    ].filter(Boolean).join('\n');
  });

  console.log(formatted.join('\n\n'));
}
