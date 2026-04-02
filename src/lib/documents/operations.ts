// document-operations.ts
// Write operations — create, update, delete, restore documents.
// Each function prepares data (chunk, embed, hash) then calls a Postgres RPC function.
// The database handles transactions (document + chunks + audit = atomic).

import type { IClientsProps, ICreateDocumentProps, IUpdateDocumentProps, IUpdateFieldsProps } from './classification.js';
import { contentHash, chunkText, generateEmbedding, toVectorString } from '../search/embeddings.js';

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

/**
 * Create a new document.
 *
 * What happens:
 * 1. Hash the content (for change detection)
 * 2. Split content into chunks (for better search)
 * 3. Generate an embedding for each chunk (calls OpenAI — costs money)
 * 4. Format embeddings as Postgres vector strings
 * 5. Call document_create RPC (Postgres inserts document + chunks + audit in one transaction)
 * 6. Return the new document's ID
 */
export async function createDocument(
  clients: IClientsProps,
  props: ICreateDocumentProps,
): Promise<number> {
  // Always compute hash from actual content — never accept a pre-computed hash
  const hash = contentHash(props.content);

  // Chunk and embed
  const chunks = chunkText(props.content);
  const chunkContents = chunks.map(chunk => chunk.content);
  const chunkEmbeddings: string[] = [];

  for (const chunk of chunks) {
    const embedding = await generateEmbedding(clients.openai, chunk.content);
    chunkEmbeddings.push(toVectorString(embedding));
  }

  const { data, error } = await clients.supabase.rpc('document_create', {
    p_name: props.name,
    p_domain: props.domain,
    p_document_type: props.document_type,
    p_project: props.project ?? null,
    p_protection: props.protection ?? 'open',
    p_owner_type: props.owner_type ?? 'user',
    p_owner_id: props.owner_id ?? null,
    p_is_auto_load: props.is_auto_load ?? false,
    p_content: props.content,
    p_description: props.description ?? null,
    p_content_hash: hash,
    p_source_type: props.source_type ?? 'text',
    p_source_url: props.source_url ?? null,
    p_file_path: props.file_path ?? null,
    p_file_permissions: props.file_permissions ?? null,
    p_agent: props.agent ?? null,
    p_status: props.status ?? null,
    p_skill_ref: props.skill_ref ?? null,
    p_embedding_model_id: props.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
    p_chunk_contents: chunkContents,
    p_chunk_embeddings: chunkEmbeddings,
    p_chunk_strategy: chunks[0]?.strategy ?? 'paragraph',
  });

  if (error) throw new Error(`Failed to create document: ${error.message}`);
  return data as number;
}

/**
 * Update a document's content. Triggers re-chunking and re-embedding.
 *
 * What happens:
 * 1. Hash the new content
 * 2. Split new content into chunks
 * 3. Generate new embeddings for each chunk (calls OpenAI)
 * 4. Call document_update RPC — Postgres handles:
 *    - Save old content to document_versions (version snapshot)
 *    - Update the document row
 *    - Delete old chunks, insert new chunks
 *    - Write audit entry
 */
export async function updateDocument(
  clients: IClientsProps,
  props: IUpdateDocumentProps,
): Promise<void> {
  const hash = contentHash(props.content);

  const chunks = chunkText(props.content);
  const chunkContents = chunks.map(chunk => chunk.content);
  const chunkEmbeddings: string[] = [];

  for (const chunk of chunks) {
    const embedding = await generateEmbedding(clients.openai, chunk.content);
    chunkEmbeddings.push(toVectorString(embedding));
  }

  const { error } = await clients.supabase.rpc('document_update', {
    p_id: props.id,
    p_content: props.content,
    p_content_hash: hash,
    p_agent: props.agent ?? null,
    p_description: props.description ?? null,
    p_status: props.status ?? null,
    p_embedding_model_id: props.embedding_model_id ?? DEFAULT_EMBEDDING_MODEL,
    p_chunk_contents: chunkContents,
    p_chunk_embeddings: chunkEmbeddings,
    p_chunk_strategy: chunks[0]?.strategy ?? 'paragraph',
  });

  if (error) throw new Error(`Failed to update document: ${error.message}`);
}

/**
 * Update document fields without changing content. No re-embedding needed.
 *
 * This is cheap (no OpenAI calls) — just passes the fields to Postgres.
 * Postgres handles: update columns, sync domain to chunks if changed, write audit.
 */
export async function updateDocumentFields(
  clients: IClientsProps,
  props: IUpdateFieldsProps,
): Promise<void> {
  const { error } = await clients.supabase.rpc('document_update_fields', {
    p_id: props.id,
    p_agent: props.agent ?? null,
    p_name: props.name ?? null,
    p_domain: props.domain ?? null,
    p_document_type: props.document_type ?? null,
    p_project: props.project ?? null,
    p_protection: props.protection ?? null,
    p_owner_type: props.owner_type ?? null,
    p_owner_id: props.owner_id ?? null,
    p_is_auto_load: props.is_auto_load ?? null,
    p_description: props.description ?? null,
    p_source_type: props.source_type ?? null,
    p_source_url: props.source_url ?? null,
    p_file_path: props.file_path ?? null,
    p_file_permissions: props.file_permissions ?? null,
    p_status: props.status ?? null,
    p_skill_ref: props.skill_ref ?? null,
    p_embedding_model_id: props.embedding_model_id ?? null,
  });

  if (error) throw new Error(`Failed to update document fields: ${error.message}`);
}

/**
 * Soft delete a document. The document stays in the database with deleted_at set.
 * Chunks are removed (search shouldn't find deleted documents).
 * Can be restored within 30 days via restoreDocument().
 * After 30 days, document_purge() permanently removes it.
 */
export async function deleteDocument(
  clients: IClientsProps,
  id: number,
  agent: string,
): Promise<void> {
  const { error } = await clients.supabase.rpc('document_delete', {
    p_id: id,
    p_agent: agent,
  });

  if (error) throw new Error(`Failed to delete document: ${error.message}`);
}

/**
 * Undo a soft delete. The document becomes active again.
 * Note: chunks were removed during delete — they need to be regenerated
 * by calling updateDocument() with the same content (which re-chunks and re-embeds).
 */
export async function restoreDocument(
  clients: IClientsProps,
  id: number,
  agent: string,
): Promise<void> {
  const { error } = await clients.supabase.rpc('document_restore', {
    p_id: id,
    p_agent: agent,
  });

  if (error) throw new Error(`Failed to restore document: ${error.message}`);
}
