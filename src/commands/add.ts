import type { LedgerConfig } from '../lib/config.js';
import { loadConfigFile } from '../lib/config.js';
import { opAddNote, NOTE_TYPES, NOTE_STATUSES, type NoteStatus } from '../lib/notes.js';
import { ask, confirm, choose } from '../lib/prompt.js';

export async function add(
  config: LedgerConfig,
  content: string,
  options: { type?: string; agent?: string; project?: string; upsertKey?: string; description?: string; status?: string; force?: boolean },
): Promise<void> {
  const configFile = loadConfigFile();
  const interactive = configFile.naming?.interactive !== false;

  let type = options.type || '';
  const metadata: Record<string, unknown> = {};
  if (options.project) metadata.project = options.project;
  if (options.upsertKey) metadata.upsert_key = options.upsertKey;
  if (options.description) metadata.description = options.description;
  if (options.status) metadata.status = options.status;

  // Interactive prompting for missing fields (CLI only)
  if (interactive && !options.force) {
    // Type
    if (!type) {
      const typeChoice = await choose('What type of note is this?', [
        ...NOTE_TYPES,
        'skip — use default (general)',
      ]);
      type = typeChoice.startsWith('skip') ? 'general' : typeChoice;
    }

    // Description
    if (!metadata.description) {
      const desc = await ask('One-line description (what is this note for?): ');
      if (desc) metadata.description = desc;
    }

    // upsert_key
    if (!metadata.upsert_key) {
      const key = await ask('Unique key for this note (lowercase-hyphenated, or Enter to auto-generate): ');
      if (key) metadata.upsert_key = key;
    }

    // Project
    if (!metadata.project) {
      const proj = await ask('Project name (or Enter to skip): ');
      if (proj) metadata.project = proj;
    }

    // Status (only for project-scoped types)
    const projectTypes = ['architecture-decision', 'project-status', 'event', 'error'];
    if (projectTypes.includes(type) && !metadata.status) {
      const statusChoice = await choose('What stage is this?', [
        ...NOTE_STATUSES,
        'skip — no status',
      ]);
      if (!statusChoice.startsWith('skip')) {
        metadata.status = statusChoice as NoteStatus;
      }
    }
  }

  // Default type if still empty
  if (!type) type = 'general';

  // Mark as having gone through interactive (or skipped it)
  // so opAddNote doesn't re-prompt via MCP confirm flow
  metadata.interactive_skip = true;

  const result = await opAddNote(
    { supabase: config.supabase, openai: config.openai },
    content,
    type,
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
        type,
        options.agent || 'cli',
        { ...metadata, interactive_skip: true },
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
