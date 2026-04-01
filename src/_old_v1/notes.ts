import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import { randomUUID } from 'crypto';
import { fatal, ExitCode } from './errors.js';
import { contentHash } from './hash.js';
import { loadConfigFile, saveConfigFile } from './config.js';
import {
  type Domain,
  type Protection,
  inferDomain as inferDomainFromType,
  getProtectionDefault,
  getAutoLoadDefault,
  resolveV1Type,
  isV2Type,
} from './domains.js';

// --- Types ---

export type NoteStatus = 'idea' | 'planning' | 'active' | 'done';

export interface NoteMetadata {
  // v2 domain model
  domain?: 'system' | 'persona' | 'workspace' | 'project' | 'general';
  type?: string;
  protection?: 'open' | 'guarded' | 'protected' | 'immutable';
  auto_load?: boolean;

  // Ownership
  owner_type?: 'system' | 'user' | 'team';
  owner_id?: string | null;

  // Identity & dedup
  upsert_key?: string;
  description?: string;
  content_hash?: string;
  schema_version?: number;

  // Provenance
  agent?: string;
  project?: string;
  status?: NoteStatus;

  // Embedding tracking
  embedding_model?: string;
  embedding_dimensions?: number;

  // File-based notes
  file_path?: string | null;
  file_permissions?: string | null;

  // Skill linking
  skill_ref?: string | null;

  // Chunking
  chunk_group?: string;
  chunk_index?: number;
  total_chunks?: number;

  [key: string]: unknown;
}

export interface NoteRow {
  id: number;
  content: string;
  metadata: NoteMetadata;
  created_at: string;
  updated_at: string;
}

export interface NoteHashEntry {
  id: number;
  localFile: string;
  contentHash: string;
  content: string;
}

export interface SearchResult extends NoteRow {
  similarity: number;
}

// Re-export for backward compat
export type DeliveryTier = 'persona' | 'project' | 'knowledge' | 'protected';
export type { Domain, Protection };

// --- Built-in Type Registry (v2: domain-based) ---

export const BUILTIN_TYPES: Record<string, DeliveryTier> = {
  // v2 types mapped to legacy delivery tier for backward compat
  'personality':      'persona',
  'behavioral-rule':  'persona',
  'preference':       'persona',
  'skill':            'persona',
  'claude-md':        'persona',
  'hook':             'persona',
  'plugin-config':    'persona',
  'type-registry':    'persona',
  'sync-rule':        'persona',
  'dashboard':        'project',
  'device-registry':  'project',
  'environment':      'project',
  'eval-result':      'project',
  'architecture':     'project',
  'project-status':   'project',
  'event':            'project',
  'error':            'project',
  'reference':        'knowledge',
  'knowledge':        'knowledge',
  'general':          'knowledge',
  // Legacy v1 names still accepted
  'user-preference':       'persona',
  'persona-rule':          'persona',
  'system-rule':           'persona',
  'code-craft':            'persona',
  'architecture-decision': 'project',
  'knowledge-guide':       'knowledge',
  'skill-reference':       'persona',
};

function resolveTypeAlias(type: string): string {
  const migration = resolveV1Type(type);
  if (migration) return migration.type;
  if (type === 'feedback') return 'general';
  return type;
}

export function getTypeRegistry(): Record<string, DeliveryTier> {
  const config = loadConfigFile();
  return { ...BUILTIN_TYPES, ...(config.types ?? {}) };
}

/** Infer domain from a note type. Handles both v1 and v2 type names. */
export function inferDomain(noteType: string): Domain {
  const v1 = resolveV1Type(noteType);
  if (v1) return v1.domain;
  return inferDomainFromType(noteType);
}

/** Legacy: infer delivery tier from note type. Use inferDomain for new code. */
export function inferDelivery(noteType: string): DeliveryTier {
  const registry = getTypeRegistry();
  // Check original name first (user overrides may use v1 names)
  if (noteType in registry) return registry[noteType];
  const resolved = resolveTypeAlias(noteType);
  return registry[resolved] ?? 'knowledge';
}

export function getRegisteredTypes(): string[] {
  return Object.keys(getTypeRegistry());
}

export function isRegisteredType(noteType: string): boolean {
  const resolved = resolveTypeAlias(noteType);
  return isV2Type(resolved) || resolved in getTypeRegistry();
}

export function registerType(name: string, delivery: DeliveryTier): void {
  const config = loadConfigFile();
  if (!config.types) config.types = {};
  config.types[name] = delivery;
  saveConfigFile(config);
}

export function validateTypeName(name: string): string | null {
  if (!name || name.length < 2) {
    return `Type name must be at least 2 characters. Got ${name.length}.`;
  }
  if (name.length > 50) {
    return `Type name must be 50 characters or fewer. Got ${name.length}.`;
  }
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    return `Invalid type name "${name}". Use lowercase alphanumeric + hyphens, starting with a letter (e.g., "wine-log").`;
  }
  return null;
}

// --- Queries ---

export async function fetchPersonaNotes(supabase: SupabaseClient): Promise<NoteRow[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('id, content, metadata, created_at, updated_at')
    .eq('metadata->>domain', 'persona');

  if (error) {
    fatal(`Error querying persona notes: ${error.message}`, ExitCode.SUPABASE_ERROR);
  }

  return (data || []) as NoteRow[];
}

/**
 * Fetch notes that should sync to every machine.
 * v2: domain IN (system, persona, workspace).
 */
export async function fetchSyncableNotes(supabase: SupabaseClient): Promise<NoteRow[]> {
  const { data: domainNotes, error: domainError } = await supabase
    .from('notes')
    .select('id, content, metadata, created_at, updated_at')
    .in('metadata->>domain', ['system', 'persona', 'workspace']);

  if (!domainError && domainNotes && domainNotes.length > 0) {
    return domainNotes as NoteRow[];
  }

  return fetchPersonaNotes(supabase);
}

/** Find the CLAUDE.md note from an array of notes. Returns content or null. */
export function getClaudeMdContent(notes: NoteRow[]): string | null {
  const note = notes.find(n =>
    (n.metadata.type as string) === 'claude-md' ||
    (n.metadata.upsert_key as string) === 'claude-md-backup'
  );
  return note?.content ?? null;
}

/** Find the MEMORY.md note from an array of notes. Returns content or null. */
export function getMemoryMdContent(notes: NoteRow[]): string | null {
  const note = notes.find(n =>
    (n.metadata.type as string) === 'memory-md' ||
    (n.metadata.upsert_key as string) === 'memory-md'
  );
  return note?.content ?? null;
}

export async function findNoteByFile(
  supabase: SupabaseClient,
  filename: string,
): Promise<{ id: number; metadata: Record<string, unknown> } | null> {
  const { data: byFile } = await supabase
    .from('notes')
    .select('id, metadata')
    .eq('metadata->>file_path', filename)
    .single();

  if (byFile) return byFile;

  const upsertKey = filename.replace(/\.md$/, '');
  const { data: byKey } = await supabase
    .from('notes')
    .select('id, metadata')
    .eq('metadata->>upsert_key', upsertKey)
    .single();

  return byKey || null;
}

export async function updateNoteContent(
  supabase: SupabaseClient,
  openai: OpenAI,
  noteId: number,
  content: string,
): Promise<void> {
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: content,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const { error } = await supabase
    .from('notes')
    .update({
      content,
      embedding,
      updated_at: new Date().toISOString(),
    })
    .eq('id', noteId);

  if (error) {
    fatal(`Error updating note: ${error.message}`, ExitCode.SUPABASE_ERROR);
  }
}

export async function searchNotes(
  supabase: SupabaseClient,
  openai: OpenAI,
  query: string,
  threshold = 0.3,
  maxResults = 1,
): Promise<SearchResult[]> {
  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
  });
  const embedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc('match_notes', {
    q_emb: JSON.stringify(embedding),
    threshold,
    max_results: maxResults,
  });

  if (error) {
    fatal(`Error searching Ledger: ${error.message}`, ExitCode.SUPABASE_ERROR);
  }

  return (data || []) as SearchResult[];
}

export async function fetchNoteHashes(supabase: SupabaseClient): Promise<NoteHashEntry[]> {
  const notes = await fetchPersonaNotes(supabase);
  return notes
    .filter(n => n.metadata.file_path)
    .map(n => ({
      id: n.id,
      localFile: n.metadata.file_path as string,
      contentHash: (n.metadata.content_hash as string) || contentHash(n.content),
      content: n.content,
    }));
}

// --- Chunking ---

export function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      const overlapText = current.slice(-overlap);
      current = overlapText + '\n\n' + paragraph;
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxChars) return [chunk];
    const forced: string[] = [];
    for (let i = 0; i < chunk.length; i += maxChars - overlap) {
      forced.push(chunk.slice(i, i + maxChars));
    }
    return forced;
  });
}

export async function updateNoteHash(
  supabase: SupabaseClient,
  noteId: number,
  hash: string,
): Promise<void> {
  const { data: note, error: fetchError } = await supabase
    .from('notes')
    .select('metadata')
    .eq('id', noteId)
    .single();

  if (fetchError) {
    fatal(`Error fetching note metadata: ${fetchError.message}`, ExitCode.SUPABASE_ERROR);
  }

  const metadata = { ...(note.metadata as Record<string, unknown>), content_hash: hash };

  const { error } = await supabase
    .from('notes')
    .update({ metadata })
    .eq('id', noteId);

  if (error) {
    fatal(`Error updating note hash: ${error.message}`, ExitCode.SUPABASE_ERROR);
  }
}

// --- Constants ---

const MAX_CHARS_PER_CHUNK = 25_000;
const CHUNK_OVERLAP = 2_000;

// --- Shared Operation Types ---

export interface Clients {
  supabase: SupabaseClient;
  openai: OpenAI;
}

export interface OperationResult {
  status: 'ok' | 'confirm' | 'error';
  message: string;
}

/** Format an embedding array as a Postgres vector string for RPC calls.
 * supabase.rpc() doesn't auto-serialize number[] to vector(1536) like .insert() does. */
function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

interface MatchResult {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

// --- Shared Helpers ---

export async function getEmbedding(openai: OpenAI, text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

function formatNotePreview(
  id: number,
  meta: Record<string, unknown>,
  content: string,
  maxLen = 300,
): string {
  const uKey = meta.upsert_key as string | undefined;
  const noteType = meta.type as string | undefined;
  const project = meta.project as string | undefined;
  const desc = meta.description as string | undefined;
  const label = uKey || `id-${id}`;
  const preview = content.slice(0, maxLen).replace(/\n/g, '\n  ');
  const truncated = content.length > maxLen ? '...' : '';
  const descLine = desc ? `\nDescription: ${desc}` : '';
  return `"${label}" (id: ${id}) | type: ${noteType || '-'} | project: ${project || '-'}${descLine}\n  ${preview}${truncated}`;
}

/**
 * Check if an operation should be blocked or confirmed based on protection level.
 * Returns null if operation is allowed, or an OperationResult if blocked/needs approval.
 */
function checkProtection(
  noteId: number,
  meta: Record<string, unknown>,
  operation: string,
  confirmed: boolean,
): OperationResult | null {
  const protection = (meta.protection as string) ?? 'open';
  const uKey = meta.upsert_key as string | undefined;
  const label = uKey || `id ${noteId}`;
  const noteType = meta.type as string | undefined;

  if (protection === 'immutable') {
    return {
      status: 'error',
      message: `BLOCKED — "${label}" (type: ${noteType ?? 'unknown'}) is immutable and cannot be ${operation}d. Immutable notes are system-managed only.`,
    };
  }

  if (protection === 'protected' && !confirmed) {
    return {
      status: 'confirm',
      message: `PROTECTED NOTE — "${label}" (type: ${noteType ?? 'unknown'}) requires explicit user approval to ${operation}.\n\nTo proceed, re-call with confirmed: true.`,
    };
  }

  if (protection === 'guarded' && !confirmed) {
    return {
      status: 'confirm',
      message: `GUARDED NOTE — "${label}" (type: ${noteType ?? 'unknown'}) requires confirmation to ${operation}.\n\nTo proceed, re-call with confirmed: true.`,
    };
  }

  return null;
}

// --- Naming Conventions ---

/** Valid type prefixes for upsert_key naming. */
const TYPE_PREFIXES: Record<string, string[]> = {
  'feedback': ['feedback'],
  'user-preference': ['user'],
  'persona-rule': ['persona-rule'],
  'system-rule': ['system-rule'],
  'code-craft': ['code-craft'],
  'architecture-decision': ['spec', 'architecture'],
  'project-status': ['project-status'],
  'reference': ['reference'],
  'event': ['devlog', 'event'],
  'error': ['errorlog', 'error'],
  'general': ['general'],
  'knowledge-guide': ['knowledge-guide'],
};

/**
 * Validate upsert_key format: {prefix}-{topic} or {project}-{prefix}-{topic}
 * Returns null if valid, error message if invalid.
 */
export function validateNaming(
  upsertKey: string,
  type: string,
  description: string | undefined,
): string | null {
  if (!upsertKey) {
    return 'upsert_key is required when naming enforcement is enabled.';
  }

  if (!description) {
    return 'description is required when naming enforcement is enabled. Add a one-line description of what this note IS and what it\'s FOR.';
  }

  // Check format: lowercase, hyphens, no underscores or special chars
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(upsertKey)) {
    return `Invalid upsert_key format "${upsertKey}". Use lowercase-hyphenated (e.g., "feedback-communication-style").`;
  }

  // Check that the key contains a valid prefix for this type
  const validPrefixes = TYPE_PREFIXES[type];
  if (validPrefixes) {
    const parts = upsertKey.split('-');
    // Match prefix at start, or after a project name segment
    const hasValidPrefix = validPrefixes.some(prefix => {
      const prefixParts = prefix.split('-');
      // Direct match: prefix-topic
      if (parts.slice(0, prefixParts.length).join('-') === prefix) return true;
      // Project-scoped: project-prefix or project-prefix-topic
      if (parts.length >= prefixParts.length + 1) {
        const afterProject = parts.slice(1, 1 + prefixParts.length).join('-');
        if (afterProject === prefix) return true;
      }
      return false;
    });

    if (!hasValidPrefix) {
      return `upsert_key "${upsertKey}" doesn't match type "${type}". Expected prefix: ${validPrefixes.join(' or ')}. Examples: "${validPrefixes[0]}-my-topic" or "myproject-${validPrefixes[0]}-my-topic".`;
    }
  }

  return null;
}

/** Derive file_path from upsert_key: feedback-style → feedback_style.md */
export function deriveFilePath(upsertKey: string): string {
  return upsertKey.replace(/-/g, '_') + '.md';
}

/** Check if naming enforcement is enabled in config. */
function isNamingEnforced(): boolean {
  const config = loadConfigFile();
  return config.naming?.enforce === true;
}

/** Check if interactive metadata prompting is enabled (default: true). */
function isInteractive(): boolean {
  const config = loadConfigFile();
  return config.naming?.interactive !== false;
}

/** Valid statuses for notes. */
export const NOTE_STATUSES: NoteStatus[] = ['idea', 'planning', 'active', 'done'];

/**
 * Check if metadata is complete enough to skip interactive prompting.
 * Returns null if complete, or a structured prompt message if fields are missing.
 */
export function checkMetadataCompleteness(
  metadata: Record<string, unknown>,
  type: string,
): string | null {
  const missing: string[] = [];

  if (!metadata.description) {
    missing.push('description');
  }

  if (!metadata.upsert_key) {
    missing.push('upsert_key');
  }

  // Only ask for status on project-tier types (those with delivery=project in the type registry)
  if (inferDelivery(type) === 'project' && !metadata.status) {
    missing.push('status');
  }

  if (missing.length === 0) return null;

  const fields: string[] = [];

  if (missing.includes('description')) {
    fields.push('- **description**: One line explaining what this note IS and what it\'s FOR');
  }

  if (missing.includes('upsert_key')) {
    fields.push('- **upsert_key**: A unique identifier for this note (lowercase-hyphenated, e.g., "feedback-my-rule" or "myproject-spec-feature")');
  }

  if (missing.includes('status')) {
    fields.push('- **status**: What stage is this? Options: idea, planning, active, done');
  }

  return `METADATA NEEDED — ask the user for these fields before saving:\n\n${fields.join('\n')}\n\nIf the user wants to skip, re-call add_note with metadata field \`interactive_skip: true\` to use defaults.`;
}

// --- Shared Operations (called by both MCP and CLI) ---

export async function opSearchNotes(
  clients: Clients,
  query: string,
  threshold: number,
  limit: number,
  type?: string,
  project?: string,
  domain?: string,
): Promise<OperationResult> {
  const embedding = await getEmbedding(clients.openai, query);
  const fetchLimit = (type || project || domain) ? limit * 3 : limit;

  const { data, error } = await clients.supabase.rpc('match_notes', {
    q_emb: JSON.stringify(embedding),
    threshold,
    max_results: fetchLimit,
  });

  if (error) {
    return { status: 'error', message: `Error: ${error.message}` };
  }

  let results = data as MatchResult[];

  if (type) results = results.filter(n => n.metadata.type === type);
  if (project) results = results.filter(n => n.metadata.project === project);
  if (domain) results = results.filter(n => n.metadata.domain === domain);
  results = results.slice(0, limit);

  // Fallback: retry at 0.3 when requested threshold returns empty
  if ((!results || results.length === 0) && threshold > 0.3) {
    const { data: fallbackData, error: fallbackError } = await clients.supabase.rpc('match_notes', {
      q_emb: JSON.stringify(embedding),
      threshold: 0.3,
      max_results: fetchLimit,
    });

    if (!fallbackError && fallbackData && fallbackData.length > 0) {
      let fallbackResults = fallbackData as MatchResult[];
      if (type) fallbackResults = fallbackResults.filter(n => n.metadata.type === type);
      if (project) fallbackResults = fallbackResults.filter(n => n.metadata.project === project);
      if (domain) fallbackResults = fallbackResults.filter(n => n.metadata.domain === domain);
      fallbackResults = fallbackResults.slice(0, limit);

      if (fallbackResults.length > 0) {
        results = fallbackResults;
        const output = await reassembleResults(clients.supabase, results);
        return { status: 'ok', message: '⚠ No strong matches found. Showing low-confidence results (similarity 0.3–0.5):\n\n' + output };
      }
    }
  }

  if (!results || results.length === 0) {
    return { status: 'ok', message: 'No matching notes found.' };
  }

  const output = await reassembleResults(clients.supabase, results);
  return { status: 'ok', message: output };
}

async function reassembleResults(supabase: SupabaseClient, results: MatchResult[]): Promise<string> {
  const seenGroups = new Set<string>();
  const output: string[] = [];

  for (const note of results) {
    const meta = note.metadata;
    const groupId = meta.chunk_group as string | undefined;

    if (groupId) {
      if (seenGroups.has(groupId)) continue;
      seenGroups.add(groupId);

      const { data: siblings, error: sibError } = await supabase
        .from('notes')
        .select('id, content, metadata, created_at')
        .eq('metadata->>chunk_group', groupId)
        .order('metadata->>chunk_index', { ascending: true });

      if (sibError || !siblings || siblings.length === 0) {
        output.push(`[${note.id}] (similarity: ${note.similarity.toFixed(3)}) [chunked, sibling fetch failed]\n${note.content}\nMetadata: ${JSON.stringify(note.metadata)}`);
      } else {
        const reassembled = siblings.map((s: { content: string }) => s.content).join('\n\n');
        output.push(`[${siblings[0].id}] (similarity: ${note.similarity.toFixed(3)}) [${siblings.length} chunks reassembled]\n${reassembled}\nMetadata: ${JSON.stringify({ ...meta, chunks: siblings.length })}`);
      }
    } else {
      output.push(`[${note.id}] (similarity: ${note.similarity.toFixed(3)})\n${note.content}\nMetadata: ${JSON.stringify(note.metadata)}`);
    }
  }

  return output.join('\n\n---\n\n');
}

export async function opListNotes(
  clients: Clients,
  limit: number,
  type?: string,
  project?: string,
  domain?: string,
): Promise<OperationResult> {
  let query = clients.supabase
    .from('notes')
    .select('id, content, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (type) query = query.eq('metadata->>type', type);
  if (project) query = query.eq('metadata->>project', project);
  if (domain) query = query.eq('metadata->>domain', domain);

  const { data, error } = await query;

  if (error) {
    return { status: 'error', message: `Error: ${error.message}` };
  }

  if (!data || data.length === 0) {
    return { status: 'ok', message: 'No notes found.' };
  }

  const formatted = data.map((note: { id: number; content: string; metadata: Record<string, unknown>; created_at: string }) => {
    const meta = note.metadata;
    const chunkInfo = meta.chunk_group ? ` [chunk ${(meta.chunk_index as number) + 1}/${meta.total_chunks}]` : '';
    return `[${note.id}]${chunkInfo} ${note.created_at}\n${note.content.slice(0, 200)}${note.content.length > 200 ? '...' : ''}\nMetadata: ${JSON.stringify(note.metadata)}`;
  }).join('\n\n---\n\n');

  return { status: 'ok', message: formatted };
}

export async function opAddNote(
  clients: Clients,
  content: string,
  type: string,
  agent: string,
  metadata: Record<string, unknown>,
  force: boolean,
  registerTypeFlag?: boolean,
): Promise<OperationResult> {
  const upsertKey = metadata.upsert_key as string | undefined;
  const description = metadata.description as string | undefined;
  const skippedInteractive = metadata.interactive_skip === true;

  // Interactive metadata prompting (default: on, opt-out via config)
  // Skip if user explicitly opted out via interactive_skip flag
  if (!skippedInteractive && isInteractive()) {
    const prompt = checkMetadataCompleteness(metadata, type);
    if (prompt) {
      return { status: 'confirm', message: prompt };
    }
  }

  // Clean up the skip flag before saving
  delete metadata.interactive_skip;

  // --- Type resolution and registration ---
  const resolvedType = resolveTypeAlias(type);

  // If register_type flag is set and type is unknown, register it
  if (registerTypeFlag && !isRegisteredType(resolvedType)) {
    const nameError = validateTypeName(resolvedType);
    if (nameError) return { status: 'error', message: nameError };

    const domainForRegistry = inferDomain(resolvedType);
    // Map domain to legacy delivery tier for registry compatibility
    const deliveryForRegistry: DeliveryTier = domainForRegistry === 'project' ? 'project' : domainForRegistry === 'persona' || domainForRegistry === 'system' ? 'persona' : 'knowledge';
    registerType(resolvedType, deliveryForRegistry);
  }

  // If type is still unknown after potential registration, prompt
  if (!isRegisteredType(resolvedType)) {
    const registry = getTypeRegistry();
    const typeListStr = Object.entries(registry)
      .map(([t, d]) => `${t} (${d})`)
      .join(', ');
    return {
      status: 'confirm',
      message: `Type "${type}" is not registered.\n\nOptions:\n1. Register with domain auto-inferred from type — re-call add_note with register_type: true\n2. Register with specific domain — re-call add_note with register_type: true AND set metadata.domain to "system", "persona", "workspace", or "project"\n3. Use an existing type instead — re-call add_note with one of: ${typeListStr}\n4. Cancel\n\nAsk the user which option they prefer.`,
    };
  }

  // Use resolved type for the rest of the flow
  type = resolvedType;

  // --- Auto-set v2 metadata from type ---
  if (!metadata.domain) {
    metadata.domain = inferDomain(type);
  }
  if (!metadata.protection) {
    metadata.protection = getProtectionDefault(type);
  }
  if (metadata.auto_load === undefined) {
    metadata.auto_load = getAutoLoadDefault(metadata.domain as Domain, type);
  }
  if (!metadata.owner_type) {
    metadata.owner_type = 'user';
    metadata.owner_id = null;
  }
  if (!metadata.schema_version) {
    metadata.schema_version = 1;
  }
  if (!metadata.embedding_model) {
    metadata.embedding_model = 'openai/text-embedding-3-small';
    metadata.embedding_dimensions = 1536;
  }

  // Naming enforcement (opt-in via config)
  if (isNamingEnforced()) {
    const namingError = validateNaming(upsertKey || '', type, description);
    if (namingError) {
      return { status: 'error', message: `Naming violation: ${namingError}` };
    }
  }

  // Auto-derive file_path from upsert_key for persona/system domain notes with auto_load
  if (upsertKey && !metadata.file_path) {
    const noteDomain = metadata.domain as string | undefined || inferDomain(type);
    if (noteDomain === 'persona' || noteDomain === 'system') {
      metadata.file_path = deriveFilePath(upsertKey);
    }
  }

  const fullMetadata = { ...metadata, type, agent, content_hash: contentHash(content) };

  // Duplicate guard: if no upsert_key and not forced, check for similar notes
  if (!upsertKey && !force) {
    try {
      const embedding = await getEmbedding(clients.openai, content.slice(0, 2000));
      const { data: similar } = await clients.supabase.rpc('match_notes', {
        q_emb: JSON.stringify(embedding),
        threshold: 0.6,
        max_results: 5,
      });

      if (similar && similar.length > 0) {
        const suggestions = (similar as MatchResult[]).map((n) => {
          const meta = n.metadata;
          const key = meta.upsert_key as string | undefined;
          const proj = meta.project as string | undefined;
          const nType = meta.type as string | undefined;
          const preview = n.content.slice(0, 200).replace(/\n/g, ' ');
          return `  [${n.id}] similarity: ${n.similarity.toFixed(3)} | key: "${key || 'none'}" | project: ${proj || '-'} | type: ${nType || '-'}\n    ${preview}...`;
        }).join('\n\n');

        return {
          status: 'confirm',
          message: `SIMILAR NOTES FOUND — ask the user before proceeding:\n\n${suggestions}\n\nOptions:\n  1. Update an existing note: re-call add_note with that note's upsert_key\n  2. Create new note anyway: re-call add_note with force: true\n\nAsk the user: "Should I update [note description] or create a new note?"`,
        };
      }
    } catch (err) {
      return { status: 'error', message: `Duplicate check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Upsert: if upsert_key provided, update existing note
  if (upsertKey) {
    const { data: existing } = await clients.supabase
      .from('notes')
      .select('id, metadata, created_at')
      .eq('metadata->>upsert_key', upsertKey)
      .single();

    if (existing) {
      return upsertExistingNote(clients, existing, content, fullMetadata);
    }
  }

  // Create new note
  return createNewNote(clients, content, fullMetadata);
}

async function upsertExistingNote(
  clients: Clients,
  existing: { id: number; metadata: Record<string, unknown>; created_at: string },
  content: string,
  fullMetadata: Record<string, unknown>,
): Promise<OperationResult> {
  const oldGroup = existing.metadata.chunk_group as string | undefined;
  const oldCreatedAt = existing.created_at;
  const newChunks = chunkText(content, MAX_CHARS_PER_CHUNK, CHUNK_OVERLAP);
  const upsertKey = fullMetadata.upsert_key as string;

  // Single-chunk → single-chunk: in-place update via note_update
  if (!oldGroup && newChunks.length === 1) {
    const embedding = await getEmbedding(clients.openai, content);
    const { error } = await clients.supabase.rpc('note_update', {
      p_id: existing.id,
      p_content: content,
      p_metadata: fullMetadata,
      p_embedding: toVectorString(embedding),
    });

    if (error) return { status: 'error', message: `Error: ${error.message}` };
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${upsertKey}" (id: ${existing.id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  // Chunk count changed — atomic delete old + insert new via note_replace
  const contents: string[] = [];
  const metadatas: Record<string, unknown>[] = [];
  const embeddings: number[][] = [];

  if (newChunks.length === 1) {
    contents.push(content);
    metadatas.push(fullMetadata);
    embeddings.push(await getEmbedding(clients.openai, content));
  } else {
    const newGroupId = randomUUID();
    for (let i = 0; i < newChunks.length; i++) {
      const chunkMeta = { ...fullMetadata, chunk_group: newGroupId, chunk_index: i, total_chunks: newChunks.length };
      if (i > 0) delete chunkMeta.upsert_key;
      contents.push(newChunks[i]);
      metadatas.push(chunkMeta);
      embeddings.push(await getEmbedding(clients.openai, newChunks[i]));
    }
  }

  const { data, error } = await clients.supabase.rpc('note_replace', {
    p_old_id: existing.id,
    p_old_chunk_group: oldGroup ?? null,
    p_contents: contents,
    p_metadatas: metadatas,
    p_embeddings: embeddings.map(toVectorString),
    p_created_at: oldCreatedAt,
  });

  if (error) return { status: 'error', message: `Error: ${error.message}` };

  const ids = data as number[];
  if (newChunks.length === 1) {
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${upsertKey}" (id: ${existing.id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  return { status: 'ok', message: `Updated "${upsertKey}" as ${newChunks.length} chunks (ids: ${ids.join(', ')}, ${content.length} chars total)` };
}

async function createNewNote(
  clients: Clients,
  content: string,
  fullMetadata: Record<string, unknown>,
): Promise<OperationResult> {
  const chunks = chunkText(content, MAX_CHARS_PER_CHUNK, CHUNK_OVERLAP);
  const upsertKey = fullMetadata.upsert_key as string | undefined;

  // Prepare all chunks: content, metadata, and embeddings
  const contents: string[] = [];
  const metadatas: Record<string, unknown>[] = [];
  const embeddings: number[][] = [];

  if (chunks.length === 1) {
    contents.push(content);
    metadatas.push(fullMetadata);
    embeddings.push(await getEmbedding(clients.openai, content));
  } else {
    const groupId = randomUUID();
    for (let i = 0; i < chunks.length; i++) {
      const chunkMeta = { ...fullMetadata, chunk_group: groupId, chunk_index: i, total_chunks: chunks.length };
      // Only first chunk keeps upsert_key — unique index would block duplicates
      if (i > 0) delete chunkMeta.upsert_key;
      contents.push(chunks[i]);
      metadatas.push(chunkMeta);
      embeddings.push(await getEmbedding(clients.openai, chunks[i]));
    }
  }

  // One RPC call: inserts all chunks + audit entry in a single transaction
  const { data, error } = await clients.supabase.rpc('note_create', {
    p_contents: contents,
    p_metadatas: metadatas,
    p_embeddings: embeddings.map(toVectorString),
  });

  if (error) return { status: 'error', message: `Error: ${error.message}` };

  const ids = data as number[];
  if (chunks.length === 1) {
    const label = upsertKey || `id ${ids[0]}`;
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Saved "${label}" (id: ${ids[0]}, type: ${fullMetadata.type}, ${content.length} chars)\nPreview: ${preview}` };
  }

  return { status: 'ok', message: `Saved "${upsertKey || 'chunked'}" as ${chunks.length} chunks (ids: ${ids.join(', ')}, ${content.length} chars total)` };
}

export async function opUpdateNote(
  clients: Clients,
  id: number,
  content: string,
  metadata?: Record<string, unknown>,
  confirmed = false,
): Promise<OperationResult> {
  const { data: existing, error: fetchError } = await clients.supabase
    .from('notes')
    .select('id, content, metadata, created_at')
    .eq('id', id)
    .single();

  if (fetchError || !existing) {
    return { status: 'error', message: `Error: note ${id} not found.` };
  }

  const protectionCheck = checkProtection(id, existing.metadata as Record<string, unknown>, 'update', confirmed);
  if (protectionCheck) return protectionCheck;

  // Confirmation gate
  if (!confirmed) {
    const currentPreview = formatNotePreview(existing.id, existing.metadata, existing.content);
    const newPreview = content.slice(0, 300).replace(/\n/g, '\n  ');
    return {
      status: 'confirm',
      message: `CONFIRM UPDATE — Is this the correct note to apply this change to?\n\n${currentPreview}\n\nNew content:\n  ${newPreview}${content.length > 300 ? '...' : ''}\n\nTo proceed, call update_note again with confirmed: true.`,
    };
  }

  const existingMeta = existing.metadata as Record<string, unknown>;
  const groupId = existingMeta.chunk_group as string | undefined;
  const oldCreatedAt = existing.created_at;
  const baseMeta = metadata ?? existingMeta;
  const chunks = chunkText(content, MAX_CHARS_PER_CHUNK, CHUNK_OVERLAP);

  // Single-chunk → single-chunk: in-place update via note_update
  if (!groupId && chunks.length === 1) {
    const embedding = await getEmbedding(clients.openai, content);
    const updatedMeta = { ...baseMeta, content_hash: contentHash(content) };

    const { error } = await clients.supabase.rpc('note_update', {
      p_id: id,
      p_content: content,
      p_metadata: updatedMeta,
      p_embedding: toVectorString(embedding),
    });

    if (error) return { status: 'error', message: `Error: ${error.message}` };
    const uKey = baseMeta.upsert_key as string | undefined;
    const label = uKey || `id ${id}`;
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${label}" (id: ${id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  // Chunk count changed — atomic delete old + insert new via note_replace
  const contents: string[] = [];
  const metadatas: Record<string, unknown>[] = [];
  const embeddings: number[][] = [];

  if (chunks.length === 1) {
    const { chunk_group, chunk_index, total_chunks, ...cleanMeta } = baseMeta;
    contents.push(content);
    metadatas.push({ ...cleanMeta, content_hash: contentHash(content) });
    embeddings.push(await getEmbedding(clients.openai, content));
  } else {
    const newGroupId = randomUUID();
    for (let i = 0; i < chunks.length; i++) {
      const { chunk_group, chunk_index, total_chunks, ...cleanMeta } = baseMeta;
      const chunkMeta = { ...cleanMeta, content_hash: contentHash(content), chunk_group: newGroupId, chunk_index: i, total_chunks: chunks.length };
      if (i > 0) delete chunkMeta.upsert_key;
      contents.push(chunks[i]);
      metadatas.push(chunkMeta);
      embeddings.push(await getEmbedding(clients.openai, chunks[i]));
    }
  }

  const { data, error } = await clients.supabase.rpc('note_replace', {
    p_old_id: id,
    p_old_chunk_group: groupId ?? null,
    p_contents: contents,
    p_metadatas: metadatas,
    p_embeddings: embeddings.map(toVectorString),
    p_created_at: oldCreatedAt,
  });

  if (error) return { status: 'error', message: `Error: ${error.message}` };

  const ids = data as number[];
  const uKey = baseMeta.upsert_key as string | undefined;
  if (chunks.length === 1) {
    const label = uKey || `id ${id}`;
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${label}" (id: ${id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  return { status: 'ok', message: `Note updated as ${chunks.length} chunks (ids: ${ids.join(', ')})` };
}

export async function opUpdateMetadata(
  clients: Clients,
  id: number,
  metadata: Record<string, unknown>,
  confirmed = false,
): Promise<OperationResult> {
  const { data: existing, error: fetchError } = await clients.supabase
    .from('notes')
    .select('id, metadata')
    .eq('id', id)
    .single();

  if (fetchError || !existing) {
    return { status: 'error', message: `Error: note ${id} not found.` };
  }

  const protectionCheck = checkProtection(id, existing.metadata as Record<string, unknown>, 'update', confirmed);
  if (protectionCheck) return protectionCheck;

  // Type change cascading — auto-update domain when type changes
  const oldType = (existing.metadata as Record<string, unknown>).type as string | undefined;
  const newType = metadata.type as string | undefined;
  if (newType && oldType && newType !== oldType) {
    const oldExpectedDomain = inferDomain(oldType);
    const currentDomain = (existing.metadata as Record<string, unknown>).domain as string | undefined;

    // Only auto-update if domain wasn't manually overridden
    if (!currentDomain || currentDomain === oldExpectedDomain) {
      metadata.domain = inferDomain(newType);
    }
  }

  // One RPC call: merges metadata, calculates diff, updates, and audits atomically
  const { error } = await clients.supabase.rpc('note_update_metadata', {
    p_id: id,
    p_metadata: metadata,
  });

  if (error) return { status: 'error', message: `Error: ${error.message}` };

  const merged = { ...existing.metadata as Record<string, unknown>, ...metadata };
  const uKey = merged.upsert_key as string | undefined;
  return { status: 'ok', message: `Updated metadata for "${uKey || `id ${id}`}"` };
}

export async function opDeleteNote(
  clients: Clients,
  id: number,
  confirmed = false,
): Promise<OperationResult> {
  const { data: existing } = await clients.supabase
    .from('notes')
    .select('id, content, metadata')
    .eq('id', id)
    .single();

  if (!existing) {
    return { status: 'error', message: `Error: note ${id} not found.` };
  }

  const meta = existing.metadata as Record<string, unknown>;
  const groupId = meta.chunk_group as string | undefined;

  const protectionCheck = checkProtection(id, meta, 'delete', confirmed);
  if (protectionCheck) return protectionCheck;

  // Confirmation gate
  if (!confirmed) {
    const chunkInfo = groupId ? ` (chunked, all chunks will be deleted)` : '';
    const preview = formatNotePreview(existing.id, meta, existing.content);
    return {
      status: 'confirm',
      message: `CONFIRM DELETE — This note will be permanently removed${chunkInfo}:\n\n${preview}\n\nTo proceed, call delete_note again with confirmed: true.`,
    };
  }

  // One RPC call: reads content for rollback, writes audit, deletes — all atomic
  const { error } = await clients.supabase.rpc('note_delete', {
    p_id: id,
    p_chunk_group: groupId ?? null,
    p_agent: (meta.agent as string) ?? 'user',
  });

  if (error) return { status: 'error', message: `Error: ${error.message}` };

  if (groupId) {
    return { status: 'ok', message: `Deleted all chunks in group ${groupId}.` };
  }
  return { status: 'ok', message: `Note ${id} deleted.` };
}

export async function checkChunkIntegrity(
  supabase: SupabaseClient,
): Promise<{ incompleteGroups: Array<{ groupId: string; expected: number; found: number }> }> {
  const { data: chunkedNotes, error } = await supabase
    .from('notes')
    .select('id, metadata')
    .not('metadata->>chunk_group', 'is', null);

  if (error || !chunkedNotes) return { incompleteGroups: [] };

  const groups = new Map<string, Array<{ id: number; index: number; total: number }>>();
  for (const note of chunkedNotes) {
    const meta = note.metadata as Record<string, unknown>;
    const groupId = meta.chunk_group as string;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId)!.push({
      id: note.id,
      index: meta.chunk_index as number,
      total: meta.total_chunks as number,
    });
  }

  const incompleteGroups: Array<{ groupId: string; expected: number; found: number }> = [];
  for (const [groupId, chunks] of groups) {
    const expected = chunks[0].total;
    if (chunks.length !== expected) {
      incompleteGroups.push({ groupId, expected, found: chunks.length });
    }
  }

  return { incompleteGroups };
}
