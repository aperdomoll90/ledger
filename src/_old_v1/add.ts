import type { LedgerConfig } from '../lib/config.js';
import { loadConfigFile } from '../lib/config.js';
import {
  opAddNote,
  getRegisteredTypes,
  isRegisteredType,
  registerType,
  validateTypeName,
  inferDomain,
  NOTE_STATUSES,
  type NoteStatus,
  type DeliveryTier,
} from '../lib/notes.js';
// DeliveryTier still needed for registerType compatibility
import { DOMAIN_TYPES, getProtectionDefault, getAutoLoadDefault, type Domain } from '../lib/domains.js';
import { ask, confirm, choose } from '../lib/prompt.js';

export async function add(
  config: LedgerConfig,
  content: string,
  options: { type?: string; agent?: string; project?: string; upsertKey?: string; description?: string; status?: string; force?: boolean; domain?: string },
): Promise<void> {
  const configFile = loadConfigFile();
  const interactive = configFile.naming?.interactive !== false;

  let type = options.type || '';
  const metadata: Record<string, unknown> = {};
  if (options.project) metadata.project = options.project;
  if (options.upsertKey) metadata.upsert_key = options.upsertKey;
  if (options.description) metadata.description = options.description;
  if (options.status) metadata.status = options.status;
  if (options.domain) metadata.domain = options.domain;

  if (interactive && !options.force) {
    // Type — show grouped by domain
    if (!type) {
      const domainChoices = Object.entries(DOMAIN_TYPES).flatMap(([domain, types]) =>
        (types as readonly string[]).map(t => `${t} (${domain})`)
      );
      const typeChoice = await choose('What type of note is this?', [
        ...domainChoices,
        'skip — use default (knowledge)',
      ]);
      if (typeChoice.startsWith('skip')) {
        type = 'knowledge';
      } else {
        type = typeChoice.split(' (')[0];
      }
    }

    // Handle unknown type from --type flag
    if (type && !isRegisteredType(type)) {
      console.error(`\nType "${type}" is not registered.`);
      const action = await choose('What would you like to do?', [
        'register — register it now',
        'existing — use an existing type instead',
        'proceed — save anyway (defaults to project/knowledge)',
      ]);

      if (action.startsWith('register')) {
        const nameError = validateTypeName(type);
        if (nameError) {
          console.error(nameError);
          process.exit(1);
        }
        const domainChoice = await choose('Domain?', ['persona', 'project', 'knowledge', 'protected']);
        registerType(type, domainChoice as DeliveryTier);
        console.error(`Registered type "${type}" with domain "${domainChoice}".`);
      } else if (action.startsWith('existing')) {
        const registeredTypes = getRegisteredTypes();
        type = await choose('Choose a type:', registeredTypes);
      }
    }

    // Auto-set domain, protection, auto_load from type
    if (!metadata.domain && type) {
      metadata.domain = inferDomain(type);
    }
    if (!metadata.protection && type) {
      metadata.protection = getProtectionDefault(type);
    }
    if (metadata.auto_load === undefined && metadata.domain) {
      metadata.auto_load = getAutoLoadDefault(metadata.domain as Domain, type);
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

    // Status (only for project domain)
    if (metadata.domain === 'project' && !metadata.status) {
      const statusChoice = await choose('What stage is this?', [
        ...NOTE_STATUSES,
        'skip — no status',
      ]);
      if (!statusChoice.startsWith('skip')) {
        metadata.status = statusChoice as NoteStatus;
      }
    }
  }

  if (!type) type = 'knowledge';

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
