import type { LedgerConfig } from '../lib/config.js';
import { opUpdateNote } from '../lib/notes.js';
import { confirm } from '../lib/prompt.js';

export async function update(
  config: LedgerConfig,
  id: number,
  content: string,
  options: { metadata?: Record<string, unknown> },
): Promise<void> {
  const clients = { supabase: config.supabase, openai: config.openai };

  // First call: show confirmation
  const preview = await opUpdateNote(clients, id, content, options.metadata, false);

  if (preview.status === 'error') {
    console.error(preview.message);
    process.exit(1);
  }

  console.error(preview.message);
  const proceed = await confirm('\nProceed with update?');

  if (!proceed) {
    console.error('Cancelled.');
    return;
  }

  // Second call: execute
  const result = await opUpdateNote(clients, id, content, options.metadata, true);
  console.error(result.message);
  if (result.status === 'error') process.exit(1);
}
