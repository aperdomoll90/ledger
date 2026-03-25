import type { LedgerConfig } from '../lib/config.js';
import { loadConfigFile } from '../lib/config.js';
import { opAddNote, getRegisteredTypes, isRegisteredType, registerType, validateTypeName, inferDelivery, NOTE_STATUSES, type NoteStatus, type DeliveryTier } from '../lib/notes.js';
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
      const registeredTypes = getRegisteredTypes();
      const typeChoice = await choose('What type of note is this?', [
        ...registeredTypes,
        'skip — use default (general)',
      ]);
      type = typeChoice.startsWith('skip') ? 'general' : typeChoice;
    }

    // Handle unknown type from --type flag
    if (type && !isRegisteredType(type)) {
      console.error(`\nType "${type}" is not registered.`);
      const action = await choose('What would you like to do?', [
        'register — register it now (pick a delivery tier)',
        'existing — use an existing type instead',
        'proceed — save anyway (defaults to "knowledge" delivery)',
      ]);

      if (action.startsWith('register')) {
        const nameError = validateTypeName(type);
        if (nameError) {
          console.error(nameError);
          process.exit(1);
        }
        const deliveryChoice = await choose('Delivery tier?', ['persona', 'project', 'knowledge', 'protected']);
        registerType(type, deliveryChoice as DeliveryTier);
        console.error(`Registered type "${type}" with delivery "${deliveryChoice}".`);
      } else if (action.startsWith('existing')) {
        const registeredTypes = getRegisteredTypes();
        type = await choose('Choose a type:', registeredTypes);
      }
      // 'proceed' — use the type as-is, will default to knowledge delivery
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
    if (inferDelivery(type) === 'project' && !metadata.status) {
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
