// document-operations.ts
// Write operations — create, update, delete, restore documents.
// Each function prepares data (chunk, embed, hash) then calls a Postgres RPC function.
// The database handles transactions (document + chunks + audit = atomic).

import { readFileSync } from 'fs';
import type { IClientsProps, ICreateDocumentProps, IUpdateDocumentProps, IUpdateFieldsProps, IChunkConfigProps, Domain, DocumentStatus, Protection } from './classification.js';
import { contentHash, chunkText, generateEmbeddingsBatch, toVectorString } from '../search/embeddings.js';
import { generateContextSummaries } from '../search/chunk-context-enrichment.js';
import { getDocumentById } from './fetching.js';
import { startTrace, startSpan } from '../observability.js';

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

  const trace = startTrace('document-ingestion', {
    tags: ['ingestion', 'create'],
    metadata: { documentName: props.name, domain: props.domain, documentType: props.document_type },
    input: { contentLength: props.content.length },
  });

  // Chunk
  const chunkSpan = startSpan('chunking', { input: { contentLength: props.content.length } });
  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);
  chunkSpan.update({ output: { chunkCount: chunks.length, avgChunkSize: Math.round(props.content.length / chunks.length) } });
  chunkSpan.end();

  // Enrich — generate context summaries per chunk (LLM calls auto-traced by wrapped client)
  const enrichSpan = startSpan('context-enrichment', { metadata: { chunkCount: chunks.length, model: 'gpt-4o-mini' } });
  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);
  enrichSpan.end();

  // Embed — summary + "\n\n" + chunk content (batch: one API call per 100 chunks, auto-traced)
  const embedSpan = startSpan('batch-embedding', { metadata: { chunkCount: chunks.length, model: 'text-embedding-3-small' } });
  const embeddingInputs = chunks.map((chunk, index) => chunkSummaries[index] + '\n\n' + chunk.content);
  const embeddings = await generateEmbeddingsBatch(clients.openai, embeddingInputs);
  const chunkEmbeddings = embeddings.map(toVectorString);
  embedSpan.end();

  // DB write
  const dbSpan = startSpan('db-write', { input: { chunkCount: chunks.length } });
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
  dbSpan.update({ output: { documentId: data } });
  dbSpan.end();

  trace.end();

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

  const trace = startTrace('document-ingestion', {
    tags: ['ingestion', 'update'],
    metadata: { documentId: props.id },
    input: { contentLength: props.content.length },
  });

  // Chunk
  const chunkSpan = startSpan('chunking', { input: { contentLength: props.content.length } });
  const chunks = chunkText(props.content, config);
  const chunkContents = chunks.map(chunk => chunk.content);
  chunkSpan.update({ output: { chunkCount: chunks.length, avgChunkSize: Math.round(props.content.length / chunks.length) } });
  chunkSpan.end();

  // Enrich (LLM calls auto-traced)
  const enrichSpan = startSpan('context-enrichment', { metadata: { chunkCount: chunks.length, model: 'gpt-4o-mini' } });
  const enrichmentResults = await generateContextSummaries(clients.openai, chunks, props.content);
  const chunkSummaries = enrichmentResults.map(result => result.summary);
  const chunkTokenCounts = enrichmentResults.map(result => result.tokenCount);
  enrichSpan.end();

  // Embed (auto-traced)
  const embedSpan = startSpan('batch-embedding', { metadata: { chunkCount: chunks.length, model: 'text-embedding-3-small' } });
  const embeddingInputs = chunks.map((chunk, index) => chunkSummaries[index] + '\n\n' + chunk.content);
  const embeddings = await generateEmbeddingsBatch(clients.openai, embeddingInputs);
  const chunkEmbeddings = embeddings.map(toVectorString);
  embedSpan.end();

  // DB write
  const dbSpan = startSpan('db-write', { input: { chunkCount: chunks.length } });
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
  dbSpan.end();
  trace.end();

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

// =============================================================================
// File-based write helpers
// =============================================================================
// Wrap createDocument / updateDocument with read-from-disk + post-push auto-verify.
// The file path is the source of truth: bytes go from disk to DB without ever
// being retyped or composed as a string parameter (closes the drift class of bug
// where MCP / CLI callers reproduce content as JSON / argv text and silently mutate it).
//
// After every write, we pull the doc back via getDocumentById and byte-compare against
// the file we sent. Mismatch throws VerifyMismatchError with a diff preview locating
// the first divergence. We never rollback (audit_log is the manual undo path).

export interface IFromFileResultProps {
  id:       number;
  verified: true;
  bytes:    number;
}

export interface IUpdateFromFileProps {
  id:       number;
  filePath: string;
  agent:    string;
}

export interface ICreateFromFileProps {
  filePath:      string;
  name:          string;
  domain:        Domain;
  document_type: string;
  description?:  string;
  project?:      string;
  agent:         string;
  status?:       DocumentStatus;
  protection?:   Protection;
}

/**
 * Thrown when the post-push verify pull-back does not byte-match the file we sent.
 * Carries the document id, both byte counts, and a single-line diff preview that
 * locates the first divergence (line / col / expected snippet / actual snippet).
 *
 * Caller decides how to surface this. CLI prints to stderr and exits non-zero;
 * MCP returns it as an error result. Neither path attempts to rollback.
 */
export class VerifyMismatchError extends Error {
  constructor(
    public readonly id:             number,
    public readonly expectedLength: number,
    public readonly actualLength:   number,
    public readonly diffPreview:    string,
  ) {
    super(`Verify mismatch on document ${id}: pushed ${expectedLength} bytes, pulled ${actualLength} bytes. ${diffPreview}`);
    this.name = 'VerifyMismatchError';
  }
}

// Locate the first byte at which two strings differ and produce a one-line preview
// in the form: `line L, col C: expected '<snippet>' but got '<snippet>'`.
// Returns null when the strings are byte-identical.
function buildDiffPreview(expected: string, actual: string): string | null {
  if (expected === actual) return null;

  const minLength = Math.min(expected.length, actual.length);
  let diffIndex = minLength;
  for (let cursor = 0; cursor < minLength; cursor++) {
    if (expected[cursor] !== actual[cursor]) {
      diffIndex = cursor;
      break;
    }
  }

  let line = 1;
  let col = 1;
  for (let cursor = 0; cursor < diffIndex; cursor++) {
    if (expected[cursor] === '\n') { line++; col = 1; }
    else { col++; }
  }

  const SNIPPET_LENGTH = 40;
  const escape = (snippet: string) => snippet.replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  const expectedSnippet = escape(expected.slice(diffIndex, diffIndex + SNIPPET_LENGTH));
  const actualSnippet   = escape(actual.slice(diffIndex, diffIndex + SNIPPET_LENGTH));

  return `line ${line}, col ${col}: expected '${expectedSnippet}' but got '${actualSnippet}'`;
}

// Pull the document back and byte-compare against the bytes we just wrote.
// Throws VerifyMismatchError if the DB returned different bytes than we sent
// (drift / pipeline transformation / concurrent write all manifest the same way).
async function verifyAfterWrite(
  clients:      IClientsProps,
  id:           number,
  expectedBody: string,
): Promise<void> {
  const pulled = await getDocumentById(clients.supabase, id);

  if (!pulled) {
    throw new VerifyMismatchError(id, expectedBody.length, 0,
      'document not found during verify (deleted between write and verify, or wrong id)');
  }

  const diffPreview = buildDiffPreview(expectedBody, pulled.content);
  if (diffPreview !== null) {
    throw new VerifyMismatchError(id, expectedBody.length, pulled.content.length, diffPreview);
  }
}

/**
 * Update a document by reading its new content from a file on disk, then verify the write.
 *
 * Pipeline:
 * 1. Read file from `filePath` (utf8). Surfaces fs errors (ENOENT, EACCES) as-is.
 * 2. Call updateDocument() with the file bytes as content.
 * 3. Pull the document back and byte-compare against what we wrote.
 * 4. On match: return { id, verified, bytes }. On mismatch: throw VerifyMismatchError.
 *
 * The file is never trimmed, normalized, or transformed — bytes-in equals bytes-out.
 */
export async function updateDocumentFromFile(
  clients: IClientsProps,
  props:   IUpdateFromFileProps,
): Promise<IFromFileResultProps> {
  const body = readFileSync(props.filePath, 'utf8');

  await updateDocument(clients, { id: props.id, content: body, agent: props.agent });
  await verifyAfterWrite(clients, props.id, body);

  return { id: props.id, verified: true, bytes: body.length };
}

/**
 * Create a new document by reading its content from a file on disk, then verify the write.
 *
 * Same shape as updateDocumentFromFile: read file, call createDocument(), pull-back, byte-compare.
 * On mismatch the new document still exists; caller decides whether to delete it (audit_log
 * preserves the create event for manual cleanup).
 */
export async function createDocumentFromFile(
  clients: IClientsProps,
  props:   ICreateFromFileProps,
): Promise<IFromFileResultProps> {
  const body = readFileSync(props.filePath, 'utf8');

  const id = await createDocument(clients, {
    name:          props.name,
    domain:        props.domain,
    document_type: props.document_type,
    content:       body,
    description:   props.description,
    project:       props.project,
    agent:         props.agent,
    status:        props.status,
    protection:    props.protection,
  });
  await verifyAfterWrite(clients, id, body);

  return { id, verified: true, bytes: body.length };
}
