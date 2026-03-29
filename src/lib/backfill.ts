import { homedir } from 'os';
import { resolve } from 'path';
import {
  type Domain,
  TYPE_MIGRATION,
  inferDomain,
  getProtectionDefault,
  getAutoLoadDefault,
  isV2Type,
} from './domains.js';

const HOME_PROJECT_DIR = homedir().replace(/\//g, '-');
const MEMORY_DIR = resolve(homedir(), `.claude/projects/${HOME_PROJECT_DIR}/memory`);

/**
 * Backfill v1 note metadata to v2 format.
 * Pure function — no DB calls. Idempotent: skips notes that already have `domain`.
 */
export function backfillMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  // Idempotent: if already has domain + schema_version, skip
  if (metadata.domain && metadata.schema_version) {
    return metadata;
  }

  const result = { ...metadata };
  const oldType = metadata.type as string | undefined;

  // --- Step 1: Migrate type + infer domain ---
  let newType = oldType ?? 'knowledge';
  let domain: Domain;

  const migration = oldType ? TYPE_MIGRATION[oldType] : undefined;
  if (migration) {
    newType = migration.type;
    domain = migration.domain;
  } else if (oldType === 'general') {
    newType = 'knowledge';
    domain = 'project';
  } else if (oldType && isV2Type(oldType)) {
    domain = inferDomain(oldType);
  } else {
    newType = 'knowledge';
    domain = 'project';
  }

  result.type = newType;
  result.domain = domain;

  // --- Step 2: Set protection and auto_load from defaults ---
  result.protection = getProtectionDefault(newType);
  result.auto_load = getAutoLoadDefault(domain, newType);

  // --- Step 3: Ownership (single user for now) ---
  result.owner_type = 'user';
  result.owner_id = null;

  // --- Step 4: Schema + embedding tracking ---
  result.schema_version = 1;
  result.embedding_model = 'openai/text-embedding-3-small';
  result.embedding_dimensions = 1536;

  // --- Step 5: Derive file_path from local_file for persona notes ---
  const localFile = metadata.local_file as string | undefined;
  if (localFile && domain === 'persona' && !result.file_path) {
    result.file_path = resolve(MEMORY_DIR, localFile);
    result.file_permissions = '644';
  }

  return result;
}
