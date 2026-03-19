import type { LedgerConfig } from '../lib/config.js';
import { opAddNote } from '../lib/notes.js';
import { confirm } from '../lib/prompt.js';

export async function add(
  config: LedgerConfig,
  content: string,
  options: { type: string; agent?: string; project?: string; upsertKey?: string; force?: boolean },
): Promise<void> {
  const metadata: Record<string, unknown> = {};
  if (options.project) metadata.project = options.project;
  if (options.upsertKey) metadata.upsert_key = options.upsertKey;

  const result = await opAddNote(
    { supabase: config.supabase, openai: config.openai },
    content,
    options.type,
    options.agent || 'cli',
    metadata,
    options.force ?? false,
  );

  if (result.status === 'confirm') {
    console.error(result.message);
    const proceed = await confirm('\nCreate new note anyway?');
    if (proceed) {
      const forced = await opAddNote(
        { supabase: config.supabase, openai: config.openai },
        content,
        options.type,
        options.agent || 'cli',
        metadata,
        true,
      );
      console.error(forced.message);
    } else {
      console.error('Cancelled.');
    }
    return;
  }

  console.error(result.message);
  if (result.status === 'error') process.exit(1);
}
