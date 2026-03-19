import type { LedgerConfig } from '../lib/config.js';
import { opDeleteNote } from '../lib/notes.js';
import { confirm } from '../lib/prompt.js';

export async function deleteNote(
  config: LedgerConfig,
  id: number,
): Promise<void> {
  const clients = { supabase: config.supabase, openai: config.openai };

  // First call: show confirmation
  const preview = await opDeleteNote(clients, id, false);

  if (preview.status === 'error') {
    console.error(preview.message);
    process.exit(1);
  }

  console.error(preview.message);
  const proceed = await confirm('\nProceed with deletion?');

  if (!proceed) {
    console.error('Cancelled.');
    return;
  }

  // Second call: execute
  const result = await opDeleteNote(clients, id, true);
  console.error(result.message);
  if (result.status === 'error') process.exit(1);
}
