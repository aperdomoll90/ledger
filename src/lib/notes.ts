import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import { fatal, ExitCode } from './errors.js';
import { contentHash } from './hash.js';

// --- Types ---

export interface NoteRow {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
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

// --- Queries ---

export async function fetchCachedNotes(supabase: SupabaseClient): Promise<NoteRow[]> {
  const { data: cachedNotes, error: cacheError } = await supabase
    .from('notes')
    .select('id, content, metadata, created_at, updated_at')
    .eq('metadata->>local_cache', 'true');

  if (cacheError) {
    fatal(`Error querying Ledger: ${cacheError.message}`, ExitCode.SUPABASE_ERROR);
  }

  const { data: ruleNotes, error: ruleError } = await supabase
    .from('notes')
    .select('id, content, metadata, created_at, updated_at')
    .in('metadata->>type', ['feedback', 'user-preference']);

  if (ruleError) {
    fatal(`Error querying rule notes: ${ruleError.message}`, ExitCode.SUPABASE_ERROR);
  }

  const allNotes = new Map<number, NoteRow>();
  for (const note of [...(cachedNotes || []), ...(ruleNotes || [])]) {
    allNotes.set(note.id, note as NoteRow);
  }

  return Array.from(allNotes.values());
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
  const notes = await fetchCachedNotes(supabase);
  return notes
    .filter(n => n.metadata.local_file)
    .map(n => ({
      id: n.id,
      localFile: n.metadata.local_file as string,
      contentHash: (n.metadata.content_hash as string) || contentHash(n.content),
      content: n.content,
    }));
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
