import type { LedgerConfig } from '../lib/config.js';
import { opUpdateMetadata } from '../lib/notes.js';

export async function tag(
  config: LedgerConfig,
  id: number,
  options: { description?: string; project?: string; scope?: string },
): Promise<void> {
  const metadata: Record<string, unknown> = {};
  if (options.description) metadata.description = options.description;
  if (options.project) metadata.project = options.project;
  if (options.scope) metadata.scope = options.scope;

  if (Object.keys(metadata).length === 0) {
    console.error('No metadata fields provided. Use --description, --project, or --scope.');
    process.exit(1);
  }

  const result = await opUpdateMetadata(
    { supabase: config.supabase, openai: config.openai },
    id,
    metadata,
  );

  if (result.status === 'error') {
    console.error(result.message);
    process.exit(1);
  }

  console.error(result.message);
}
