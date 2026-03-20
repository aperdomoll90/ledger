import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import { randomUUID, createHash } from 'crypto';
import { fatal, ExitCode } from './errors.js';
import { contentHash } from './hash.js';
import { loadConfigFile, saveConfigFile } from './config.js';

// --- Types ---

export type NoteStatus = 'idea' | 'planning' | 'active' | 'done';

export interface NoteMetadata {
  type?: string;
  agent?: string;
  project?: string;
  status?: NoteStatus;
  upsert_key?: string;
  local_file?: string;
  content_hash?: string;
  description?: string;
  delivery?: 'persona' | 'project' | 'knowledge';
  chunk_group?: string;
  chunk_index?: number;
  total_chunks?: number;
  [key: string]: unknown; // allow additional fields from Supabase
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

// --- Delivery ---

export type DeliveryTier = 'persona' | 'project' | 'knowledge';

// --- Built-in Type Registry ---

export const BUILTIN_TYPES: Record<string, DeliveryTier> = {
  'user-preference': 'persona',
  'persona-rule': 'persona',
  'system-rule': 'persona',
  'code-craft': 'persona',
  'architecture-decision': 'project',
  'project-status': 'project',
  'event': 'project',
  'error': 'project',
  'reference': 'knowledge',
  'knowledge-guide': 'knowledge',
  'general': 'knowledge',
};

const TYPE_ALIASES: Record<string, string> = {
  'feedback': 'general',
};

function resolveTypeAlias(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

export function getTypeRegistry(): Record<string, DeliveryTier> {
  const config = loadConfigFile();
  return { ...BUILTIN_TYPES, ...(config.types ?? {}) };
}

export function inferDelivery(noteType: string): DeliveryTier {
  const resolved = resolveTypeAlias(noteType);
  return getTypeRegistry()[resolved] ?? 'knowledge';
}

export function getRegisteredTypes(): string[] {
  return Object.keys(getTypeRegistry());
}

export function isRegisteredType(noteType: string): boolean {
  const resolved = resolveTypeAlias(noteType);
  return resolved in getTypeRegistry();
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
    .eq('metadata->>delivery', 'persona');

  if (error) {
    fatal(`Error querying persona notes: ${error.message}`, ExitCode.SUPABASE_ERROR);
  }

  return (data || []) as NoteRow[];
}

export async function findNoteByFile(
  supabase: SupabaseClient,
  filename: string,
): Promise<{ id: number; metadata: Record<string, unknown> } | null> {
  const { data: byFile } = await supabase
    .from('notes')
    .select('id, metadata')
    .eq('metadata->>local_file', filename)
    .limit(1)
    .single();

  if (byFile) return byFile;

  const upsertKey = filename.replace(/\.md$/, '');
  const { data: byKey } = await supabase
    .from('notes')
    .select('id, metadata')
    .eq('metadata->>upsert_key', upsertKey)
    .limit(1)
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
    .filter(n => n.metadata.local_file)
    .map(n => ({
      id: n.id,
      localFile: n.metadata.local_file as string,
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

/** Derive local_file from upsert_key: feedback-style → feedback_style.md */
export function deriveLocalFile(upsertKey: string): string {
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

/** @deprecated Use getRegisteredTypes() instead */
export const NOTE_TYPES = Object.keys(BUILTIN_TYPES);

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

  // Only ask for status on project-scoped types
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
): Promise<OperationResult> {
  const embedding = await getEmbedding(clients.openai, query);
  const fetchLimit = (type || project) ? limit * 3 : limit;

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
): Promise<OperationResult> {
  let query = clients.supabase
    .from('notes')
    .select('id, content, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (type) query = query.eq('metadata->>type', type);
  if (project) query = query.eq('metadata->>project', project);

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

  // Naming enforcement (opt-in via config)
  if (isNamingEnforced()) {
    const namingError = validateNaming(upsertKey || '', type, description);
    if (namingError) {
      return { status: 'error', message: `Naming violation: ${namingError}` };
    }
  }

  // Auto-derive local_file from upsert_key for persona notes
  if (upsertKey && !metadata.local_file) {
    const delivery = metadata.delivery as string | undefined || inferDelivery(type);
    if (delivery === 'persona') {
      metadata.local_file = deriveLocalFile(upsertKey);
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
    } catch {
      // If similarity check fails, proceed with creation
    }
  }

  // Upsert: if upsert_key provided, update existing note
  if (upsertKey) {
    const { data: existing } = await clients.supabase
      .from('notes')
      .select('id, metadata, created_at')
      .eq('metadata->>upsert_key', upsertKey)
      .limit(1)
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

  // Single-chunk → single-chunk: real SQL UPDATE (preserves ID + created_at)
  if (!oldGroup && newChunks.length === 1) {
    const embedding = await getEmbedding(clients.openai, content);
    const { data, error } = await clients.supabase
      .from('notes')
      .update({ content, metadata: fullMetadata, embedding })
      .eq('id', existing.id)
      .select('id, created_at')
      .single();

    if (error) return { status: 'error', message: `Error: ${error.message}` };
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${upsertKey}" (id: ${data.id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  // Chunk count changed — delete old, preserve ID for first insert
  const preserveId = existing.id;
  if (oldGroup) {
    await clients.supabase.from('notes').delete().eq('metadata->>chunk_group', oldGroup);
  } else {
    await clients.supabase.from('notes').delete().eq('id', existing.id);
  }

  if (newChunks.length === 1) {
    const embedding = await getEmbedding(clients.openai, content);
    const { data, error } = await clients.supabase
      .from('notes')
      .insert({ id: preserveId, content, metadata: fullMetadata, embedding, created_at: oldCreatedAt })
      .select('id, created_at')
      .single();

    if (error) return { status: 'error', message: `Error: ${error.message}` };
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${upsertKey}" (id: ${data.id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  // Multiple new chunks
  const newGroupId = randomUUID();
  const ids: number[] = [];

  for (let i = 0; i < newChunks.length; i++) {
    const chunkMeta = { ...fullMetadata, chunk_group: newGroupId, chunk_index: i, total_chunks: newChunks.length };
    const embedding = await getEmbedding(clients.openai, newChunks[i]);
    const insertData: Record<string, unknown> = { content: newChunks[i], metadata: chunkMeta, embedding, created_at: oldCreatedAt };
    if (i === 0) insertData.id = preserveId;

    const { data, error } = await clients.supabase.from('notes').insert(insertData).select('id').single();
    if (error) return { status: 'error', message: `Error saving chunk ${i + 1}/${newChunks.length}: ${error.message}` };
    ids.push(data.id);
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

  if (chunks.length === 1) {
    const embedding = await getEmbedding(clients.openai, content);
    const { data, error } = await clients.supabase
      .from('notes')
      .insert({ content, metadata: fullMetadata, embedding })
      .select('id, created_at')
      .single();

    if (error) return { status: 'error', message: `Error: ${error.message}` };
    const label = upsertKey || `id ${data.id}`;
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Saved "${label}" (id: ${data.id}, type: ${fullMetadata.type}, ${content.length} chars)\nPreview: ${preview}` };
  }

  const groupId = randomUUID();
  const ids: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkMeta = { ...fullMetadata, chunk_group: groupId, chunk_index: i, total_chunks: chunks.length };
    const embedding = await getEmbedding(clients.openai, chunks[i]);
    const { data, error } = await clients.supabase.from('notes').insert({ content: chunks[i], metadata: chunkMeta, embedding }).select('id').single();
    if (error) return { status: 'error', message: `Error saving chunk ${i + 1}/${chunks.length}: ${error.message}` };
    ids.push(data.id);
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

  // Single-chunk → single-chunk: real SQL UPDATE
  if (!groupId && chunks.length === 1) {
    const embedding = await getEmbedding(clients.openai, content);
    const updatedMeta = { ...baseMeta, content_hash: contentHash(content) };

    const { data, error } = await clients.supabase
      .from('notes')
      .update({ content, metadata: updatedMeta, embedding })
      .eq('id', id)
      .select('id, created_at')
      .single();

    if (error) return { status: 'error', message: `Error: ${error.message}` };
    const uKey = baseMeta.upsert_key as string | undefined;
    const label = uKey || `id ${data.id}`;
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${label}" (id: ${data.id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  // Chunk count changed — delete old, re-insert with preserved ID
  const preserveId = id;
  if (groupId) {
    await clients.supabase.from('notes').delete().eq('metadata->>chunk_group', groupId);
  } else {
    await clients.supabase.from('notes').delete().eq('id', id);
  }

  if (chunks.length === 1) {
    const embedding = await getEmbedding(clients.openai, content);
    const { chunk_group, chunk_index, total_chunks, ...cleanMeta } = baseMeta;
    const updatedMeta = { ...cleanMeta, content_hash: contentHash(content) };

    const { data, error } = await clients.supabase
      .from('notes')
      .insert({ id: preserveId, content, metadata: updatedMeta, embedding, created_at: oldCreatedAt })
      .select('id, created_at')
      .single();

    if (error) return { status: 'error', message: `Error: ${error.message}` };
    const uKey = baseMeta.upsert_key as string | undefined;
    const label = uKey || `id ${data.id}`;
    const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
    return { status: 'ok', message: `Updated "${label}" (id: ${data.id}, ${content.length} chars)\nPreview: ${preview}` };
  }

  const newGroupId = randomUUID();
  const ids: number[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const { chunk_group, chunk_index, total_chunks, ...cleanMeta } = baseMeta;
    const chunkMeta = { ...cleanMeta, content_hash: contentHash(content), chunk_group: newGroupId, chunk_index: i, total_chunks: chunks.length };
    const embedding = await getEmbedding(clients.openai, chunks[i]);
    const insertData: Record<string, unknown> = { content: chunks[i], metadata: chunkMeta, embedding, created_at: oldCreatedAt };
    if (i === 0) insertData.id = preserveId;

    const { data, error } = await clients.supabase.from('notes').insert(insertData).select('id').single();
    if (error) return { status: 'error', message: `Error updating chunk ${i + 1}/${chunks.length}: ${error.message}` };
    ids.push(data.id);
  }

  return { status: 'ok', message: `Note updated as ${chunks.length} chunks (ids: ${ids.join(', ')}, group: ${newGroupId})` };
}

export async function opUpdateMetadata(
  clients: Clients,
  id: number,
  metadata: Record<string, unknown>,
): Promise<OperationResult> {
  const { data: existing, error: fetchError } = await clients.supabase
    .from('notes')
    .select('id, metadata')
    .eq('id', id)
    .single();

  if (fetchError || !existing) {
    return { status: 'error', message: `Error: note ${id} not found.` };
  }

  const merged = { ...existing.metadata as Record<string, unknown>, ...metadata };
  const { error } = await clients.supabase
    .from('notes')
    .update({ metadata: merged })
    .eq('id', id);

  if (error) return { status: 'error', message: `Error: ${error.message}` };

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

  // Confirmation gate
  if (!confirmed) {
    const chunkInfo = groupId ? ` (chunked, all chunks will be deleted)` : '';
    const preview = formatNotePreview(existing.id, meta, existing.content);
    return {
      status: 'confirm',
      message: `CONFIRM DELETE — This note will be permanently removed${chunkInfo}:\n\n${preview}\n\nTo proceed, call delete_note again with confirmed: true.`,
    };
  }

  if (groupId) {
    const { error } = await clients.supabase.from('notes').delete().eq('metadata->>chunk_group', groupId);
    if (error) return { status: 'error', message: `Error: ${error.message}` };
    return { status: 'ok', message: `Deleted all chunks in group ${groupId}.` };
  }

  const { error } = await clients.supabase.from('notes').delete().eq('id', id);
  if (error) return { status: 'error', message: `Error: ${error.message}` };
  return { status: 'ok', message: `Note ${id} deleted.` };
}
