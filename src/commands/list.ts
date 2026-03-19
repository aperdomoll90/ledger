import type { LedgerConfig } from '../lib/config.js';
import { opListNotes } from '../lib/notes.js';

export async function list(
  config: LedgerConfig,
  options: { limit: number; type?: string; project?: string },
): Promise<void> {
  const result = await opListNotes(
    { supabase: config.supabase, openai: config.openai },
    options.limit,
    options.type,
    options.project,
  );

  if (result.status === 'error') {
    console.error(result.message);
    process.exit(1);
  }

  // List output goes to stdout (machine-readable)
  console.log(result.message);
}
