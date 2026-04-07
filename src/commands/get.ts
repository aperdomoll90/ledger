import type { LedgerConfig } from '../lib/config.js';
import { getDocumentByName } from '../lib/documents/fetching.js';
import { fatal, ExitCode } from '../lib/errors.js';

export async function get(config: LedgerConfig, name: string): Promise<void> {
  const document = await getDocumentByName(config.supabase, name);

  if (!document) {
    fatal(`Document "${name}" not found.`, ExitCode.DOCUMENT_NOT_FOUND);
  }

  console.log(document.content);
}
