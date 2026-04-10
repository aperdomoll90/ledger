// document-fetching.ts
// Read documents from the database. No writes, no search — just SELECT queries.
// Every query filters deleted_at IS NULL so soft-deleted documents are invisible.

import type { IDocumentProps, IListDocumentsProps, ISupabaseClientProps } from './classification.js';

/**
 * Get a single document by its database ID.
 * Returns null if the document doesn't exist or is soft-deleted.
 */
export async function getDocumentById(
  supabase: ISupabaseClientProps,
  id: number,
): Promise<IDocumentProps | null> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .single();

  if (error) {
    if (error.code !== 'PGRST116') {
      process.stderr.write(`[ledger] getDocumentById(${id}) failed: ${error.message}\n`);
    }
    return null;
  }
  return (data as IDocumentProps) ?? null;
}

/**
 * Get a single document by its unique name.
 * Returns null if no document has this name or it's soft-deleted.
 */
export async function getDocumentByName(
  supabase: ISupabaseClientProps,
  name: string,
): Promise<IDocumentProps | null> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('name', name)
    .is('deleted_at', null)
    .single();

  if (error) {
    if (error.code !== 'PGRST116') {
      process.stderr.write(`[ledger] getDocumentByName("${name}") failed: ${error.message}\n`);
    }
    return null;
  }
  return (data as IDocumentProps) ?? null;
}

/**
 * List documents with optional filters. Returns newest first.
 * All filters are optional — no filters = list all active documents.
 *
 * Uses indexed columns: domain, document_type, project, created_at DESC.
 * The deleted_at IS NULL filter uses the index_documents_active partial index.
 */
export async function listDocuments(
  supabase: ISupabaseClientProps,
  filters: IListDocumentsProps = {},
): Promise<IDocumentProps[]> {
  let query = supabase
    .from('documents')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 20);

  if (filters.domain) query = query.eq('domain', filters.domain);
  if (filters.document_type) query = query.eq('document_type', filters.document_type);
  if (filters.project) query = query.eq('project', filters.project);

  const { data, error } = await query;
  if (error) {
    process.stderr.write(`[ledger] listDocuments failed: ${error.message}\n`);
    return [];
  }
  return (data as IDocumentProps[]) ?? [];
}

/**
 * Fetch all documents that should sync to every machine.
 * Sync is driven by is_auto_load, not domain — a document syncs locally because
 * it needs to be in the AI's context every session (CLAUDE.md, MEMORY.md,
 * personality, behavioral rules). Everything else stays in the database and is
 * accessed via search on demand, regardless of domain.
 *
 * Uses the index_documents_is_auto_load partial index.
 */
export async function fetchSyncableDocuments(
  supabase: ISupabaseClientProps,
): Promise<IDocumentProps[]> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('is_auto_load', true)
    .is('deleted_at', null);

  if (error) {
    process.stderr.write(`[ledger] fetchSyncableDocuments failed: ${error.message}\n`);
    return [];
  }
  return (data as IDocumentProps[]) ?? [];
}
