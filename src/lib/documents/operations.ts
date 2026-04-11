// document-operations.ts
// Write operations — create, update, delete, restore documents.
// Each function prepares data (chunk, embed, hash) then calls a Postgres RPC function.
// The database handles transactions (document + chunks + audit = atomic).

import type { IClientsProps, ICreateDocumentProps, IUpdateDocumentProps, IUpdateFieldsProps, IChunkConfigProps } from './classification.js';
import { contentHash, chunkText, generateEmbeddingsBatch, toVectorString } from '../search/embeddings.js';
import { generateContextSummaries } from '../search/chunk-context-enrichment.js';

const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

const DEFAULT_CHUNK_CONFIG: IChunkConfigProps = {
  maxChunkSize: 1000,
  overlapChars: 200,
  strategy: 'recursive',
};

/**
 * Create a new document.
 *
 * Pipeline:
 * 1. Hash the content (change detection)
 * 2. Chunk with recursive splitter
 * 3. Generate context summaries per chunk (LLM call — chunk context enrichment)
 * 4. Embed summary + chunk content (OpenAI embedding call per chunk)
 * 5. Call document_create RPC (atomic: document + chunks + audit)
 */
export async function createDocument(
  clients: IClientsProps,
  props: ICreateDocumentProps,
  chunkConfig?: Partial<IChunkConfigProps>,
): Promise<number> {
  const config = { ...DEFAULT_CHUNK_CONFIG, ...chunkConfig };
  const hash = contentHash(props.content);

  // Chunk
  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);

  // Enrich — generate context summaries per chunk
  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);

  // Embed — summary + "\n\n" + chunk content (batch: one API call per 100 chunks)
  const embeddingInputs = chunks.map((chunk, index) => chunkSummaries[index] + '\n\n' + chunk.content);
  const embeddings = await generateEmbeddingsBatch(clients.openai, embeddingInputs);
  const chunkEmbeddings = embeddings.map(toVectorString);

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
    p_chunk_strategy: chunks[0]?.strategy ?? config.strategy,
    p_chunk_summaries: chunkSummaries,
    p_chunk_token_counts: chunkTokenCounts,
    p_chunk_overlap: config.overlapChars,
  });

  if (error) throw new Error(`Failed to create document "${props.name}" (${props.domain}/${props.document_type}): ${error.message}`);
  return data as number;
}

/**
 * Update a document's content. Triggers re-chunking, re-enrichment, and re-embedding.
 *
 * Same pipeline as createDocument — hash, chunk, enrich, embed — then calls
 * document_update RPC which versions old content before overwriting.
 */
export async function updateDocument(
  clients: IClientsProps,
  props: IUpdateDocumentProps,
  chunkConfig?: Partial<IChunkConfigProps>,
): Promise<void> {
  const config = { ...DEFAULT_CHUNK_CONFIG, ...chunkConfig };
  const hash = contentHash(props.content);

  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);

  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);

  const embeddingInputs = chunks.map((chunk, index) => chunkSummaries[index] + '\n\n' + chunk.content);
  const embeddings = await generateEmbeddingsBatch(clients.openai, embeddingInputs);
  const chunkEmbeddings = embeddings.map(toVectorString);

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
    p_chunk_strategy: chunks[0]?.strategy ?? config.strategy,
    p_chunk_summaries: chunkSummaries,
    p_chunk_token_counts: chunkTokenCounts,
    p_chunk_overlap: config.overlapChars,
  });

  if (error) throw new Error(`Failed to update document #${props.id}: ${error.message}`);
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

  if (error) throw new Error(`Failed to update fields on document #${props.id}: ${error.message}`);
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

  if (error) throw new Error(`Failed to delete document #${id}: ${error.message}`);
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

  if (error) throw new Error(`Failed to restore document #${id}: ${error.message}`);
}
