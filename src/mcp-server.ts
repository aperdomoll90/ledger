// mcp-server.ts
// MCP server — the API surface that AI agents call.
// Each tool is a thin wrapper: validate input (Zod) → check protection → call library → format response.
// Zero business logic here — that all lives in the library files.

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { observeOpenAI } from '@langfuse/openai';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { IClientsProps } from './lib/documents/classification.js';
import { createDocument, updateDocument, updateDocumentFields, deleteDocument, restoreDocument, updateDocumentFromFile, createDocumentFromFile, VerifyMismatchError } from './lib/documents/operations.js';
import { getDocumentById, listDocuments } from './lib/documents/fetching.js';
import { searchHybrid, searchByVector, searchByKeyword, retrieveContext } from './lib/search/ai-search.js';
import { initObservability, shutdownObservability } from './lib/observability.js';

// =============================================================================
// Observability
// =============================================================================

// Call before constructing the OpenAI client so observeOpenAI() has a tracer
// provider to attach to.
initObservability();

// One session ID per MCP process. MCP stdio transport is one client per
// process, so process-scoped UUID is the natural session boundary.
const MCP_SESSION_ID = `mcp-${randomUUID()}`;
const MCP_ENVIRONMENT = process.env.NODE_ENV ?? 'development';

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdownObservability().finally(() => process.exit(0));
  });
}

// =============================================================================
// Clients
// =============================================================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run `ledger init` to configure.');
  process.exit(1);
}
if (!openaiKey) {
  console.error('Missing OPENAI_API_KEY. Run `ledger init` to configure.');
  process.exit(1);
}

const clients: IClientsProps = {
  supabase: createClient(supabaseUrl, supabaseKey),
  openai: observeOpenAI(new OpenAI({ apiKey: openaiKey })),
  cohereApiKey: process.env.COHERE_API_KEY || undefined,
  sessionId: MCP_SESSION_ID,
  observabilityEnvironment: MCP_ENVIRONMENT,
};

// =============================================================================
// Helpers
// =============================================================================

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }] };
}

// =============================================================================
// File-access allowlist for *_from_file tools
// =============================================================================
// The MCP server runs with the user's full FS permissions. The allowlist is
// defense-in-depth: it stops accidental pushes of arbitrary files (e.g. /etc/passwd)
// when an agent constructs a path it shouldn't. Agents that already have direct
// FS access via Read tool can bypass this — that's expected. The point is to
// keep wrong-path mistakes from silently succeeding through the Ledger pipeline.
//
// Override the defaults via env var `LEDGER_MCP_FILE_ACCESS_ALLOWLIST` (colon-separated
// absolute paths or `~`-prefixed paths). Setting the env var REPLACES defaults
// rather than extending them, so an explicit override is always strictly enforced.

const FILE_ACCESS_ALLOWLIST_DEFAULTS = ['~/.ledger/', '~/repos/', '/tmp/ledger-edit/'];

function expandHome(rawPath: string): string {
  return rawPath.startsWith('~/') ? rawPath.replace(/^~/, homedir()) : rawPath;
}

function getFileAccessAllowlist(): string[] {
  const envOverride = process.env.LEDGER_MCP_FILE_ACCESS_ALLOWLIST;
  const sources = envOverride
    ? envOverride.split(':').filter(entry => entry.length > 0)
    : FILE_ACCESS_ALLOWLIST_DEFAULTS;
  return sources.map(entry => resolve(expandHome(entry)) + '/');
}

function assertPathAllowed(absolutePath: string): void {
  const allowlist = getFileAccessAllowlist();
  if (!allowlist.some(prefix => absolutePath.startsWith(prefix))) {
    throw new Error(
      `Path "${absolutePath}" is outside the MCP file-access allowlist. ` +
      `Allowed prefixes: ${allowlist.join(', ')}. ` +
      `Override via the LEDGER_MCP_FILE_ACCESS_ALLOWLIST env var if intentional.`
    );
  }
}

function verifyMismatchResponse(error: VerifyMismatchError) {
  return errorResponse(
    `Verify mismatch on document ${error.id}: ` +
    `pushed ${error.expectedLength} bytes, pulled ${error.actualLength} bytes. ` +
    `${error.diffPreview}`
  );
}

/**
 * Protection check — called before update and delete operations.
 * Returns null if the operation can proceed, or a response object to return.
 */
async function checkProtection(
  id: number,
  confirmed: boolean,
  operation: string,
): Promise<ReturnType<typeof textResponse> | null> {
  const document = await getDocumentById(clients.supabase, id);
  if (!document) return errorResponse(`Document ${id} not found`);

  if (document.protection === 'immutable') {
    return errorResponse(`Document "${document.name}" (id: ${id}) is immutable and cannot be ${operation}d`);
  }

  if ((document.protection === 'protected' || document.protection === 'guarded') && !confirmed) {
    return textResponse(
      `Document "${document.name}" (id: ${id}) has protection: ${document.protection}.\n` +
      `Current content preview: ${document.content.slice(0, 200)}${document.content.length > 200 ? '...' : ''}\n\n` +
      `Call again with confirmed: true to proceed with ${operation}.`
    );
  }

  return null; // proceed
}

// =============================================================================
// Zod schemas — reusable across new and deprecated tools
// =============================================================================

const domainEnum = z.enum(['system', 'persona', 'workspace', 'project', 'general']);
const protectionEnum = z.enum(['open', 'guarded', 'protected', 'immutable']);
const ownerTypeEnum = z.enum(['system', 'user', 'team']);
const sourceTypeEnum = z.enum(['text', 'pdf', 'docx', 'spreadsheet', 'code', 'image', 'audio', 'video', 'web', 'email', 'slides', 'handwriting']);
const statusEnum = z.enum(['idea', 'planning', 'active', 'done']);

// =============================================================================
// MCP Server
// =============================================================================

const server = new McpServer({
  name: 'ledger',
  version: '2.0.0',
});

// =============================================================================
// New tools — *_documents
// =============================================================================

server.tool(
  'search_documents',
  'Search documents by meaning and keywords (hybrid search). Combines vector similarity with full-text keyword matching. Documents found by both methods rank highest.',
  {
    query: z.string().describe('What to search for'),
    threshold: z.coerce.number().min(0).max(1).default(0.38).describe('Minimum vector similarity score (0-1). Lower = more results, higher = stricter matching'),
    limit: z.coerce.number().min(1).max(50).default(10).describe('Max results to return'),
    domain: domainEnum.optional().describe('Filter by domain'),
    document_type: z.string().optional().describe('Filter by document type'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async (params) => {
    try {
      const results = await searchHybrid(clients, {
        query: params.query,
        threshold: params.threshold,
        limit: params.limit,
        domain: params.domain,
        document_type: params.document_type,
        project: params.project,
      });

      if (results.length === 0) {
        return textResponse('No documents found matching your query.');
      }

      const formatted = results.map((result, index) => {
        const score = result.score?.toFixed(3) ?? result.similarity?.toFixed(3) ?? 'n/a';
        return [
          `--- Result ${index + 1} [id: ${result.id}, score: ${score}] ---`,
          `Name: ${result.name}`,
          `Domain: ${result.domain} | Type: ${result.document_type}${result.project ? ` | Project: ${result.project}` : ''}`,
          result.description ? `Description: ${result.description}` : null,
          `Content:\n${result.content}`,
        ].filter(Boolean).join('\n');
      });

      return textResponse(`Found ${results.length} result(s):\n\n${formatted.join('\n\n')}`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'add_document_from_file',
  'Create a new document by reading content from an absolute file path on the local FS. Bytes flow disk -> Postgres without string composition (drift-safe). Auto-verified after create: the doc is pulled back and byte-compared against the file we sent. Path must be inside the MCP file-access allowlist.',
  {
    path: z.string().describe('Absolute path to the file to ingest. Must be inside the configured allowlist (defaults: ~/.ledger/, ~/repos/, /tmp/ledger-edit/).'),
    name: z.string().describe('Document name (unique identifier)'),
    domain: domainEnum.describe('Document domain'),
    document_type: z.string().describe('Document type (e.g. knowledge-guide, project-status, reference)'),
    description: z.string().optional().describe('Short description of the document'),
    project: z.string().optional().describe('Project name'),
    protection: protectionEnum.optional().describe('Protection level (default: open)'),
    agent: z.string().optional().describe('Agent creating this document'),
    status: statusEnum.optional().describe('Document status'),
  },
  async (params) => {
    try {
      const absolutePath = resolve(expandHome(params.path));
      assertPathAllowed(absolutePath);

      const result = await createDocumentFromFile(clients, {
        filePath:      absolutePath,
        name:          params.name,
        domain:        params.domain,
        document_type: params.document_type,
        description:   params.description,
        project:       params.project,
        protection:    params.protection,
        agent:         params.agent ?? 'mcp',
        status:        params.status,
      });
      return textResponse(`Document created and verified (id: ${result.id}, ${result.bytes} bytes).`);
    } catch (error) {
      if (error instanceof VerifyMismatchError) return verifyMismatchResponse(error);
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'list_documents',
  'List documents from the knowledge base with optional filters. Returns newest first.',
  {
    domain: domainEnum.optional().describe('Filter by domain'),
    document_type: z.string().optional().describe('Filter by document type'),
    project: z.string().optional().describe('Filter by project name'),
    limit: z.coerce.number().min(1).max(100).default(20).describe('Max results to return'),
  },
  async (params) => {
    try {
      const documents = await listDocuments(clients.supabase, {
        domain: params.domain,
        document_type: params.document_type,
        project: params.project,
        limit: params.limit,
      });

      if (documents.length === 0) {
        return textResponse('No documents found.');
      }

      const formatted = documents.map((document) => {
        return [
          `[${document.id}] ${document.name}`,
          `  Domain: ${document.domain} | Type: ${document.document_type}${document.project ? ` | Project: ${document.project}` : ''}`,
          `  Protection: ${document.protection} | Auto-load: ${document.is_auto_load}`,
          document.description ? `  Description: ${document.description}` : null,
          `  Content: ${document.content.slice(0, 150)}${document.content.length > 150 ? '...' : ''}`,
          `  Updated: ${document.updated_at}`,
        ].filter(Boolean).join('\n');
      });

      return textResponse(`${documents.length} document(s):\n\n${formatted.join('\n\n')}`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'update_document_from_file',
  'Update a document by reading new content from an absolute file path on the local FS. Bytes flow disk -> Postgres without string composition (drift-safe). Auto-verified after push: the doc is pulled back and byte-compared against the file we sent. Path must be inside the MCP file-access allowlist. Respects protection levels.',
  {
    id: z.coerce.number().describe('Document ID to update'),
    path: z.string().describe('Absolute path to the file containing the new content. Must be inside the configured allowlist (defaults: ~/.ledger/, ~/repos/, /tmp/ledger-edit/).'),
    agent: z.string().optional().describe('Agent performing the update'),
    confirmed: z.boolean().default(false).describe('Required for protected/guarded documents'),
  },
  async (params) => {
    try {
      const blocked = await checkProtection(params.id, params.confirmed, 'update');
      if (blocked) return blocked;

      const absolutePath = resolve(expandHome(params.path));
      assertPathAllowed(absolutePath);

      const result = await updateDocumentFromFile(clients, {
        id:       params.id,
        filePath: absolutePath,
        agent:    params.agent ?? 'mcp',
      });
      return textResponse(`Document ${result.id} updated and verified (${result.bytes} bytes).`);
    } catch (error) {
      if (error instanceof VerifyMismatchError) return verifyMismatchResponse(error);
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'update_document_fields',
  'Update document fields without changing content. No re-embedding needed. Respects protection levels.',
  {
    id: z.coerce.number().describe('Document ID to update'),
    agent: z.string().optional().describe('Agent performing the update'),
    name: z.string().optional().describe('New document name'),
    domain: domainEnum.optional().describe('New domain'),
    document_type: z.string().optional().describe('New document type'),
    project: z.string().optional().describe('New project name'),
    protection: protectionEnum.optional().describe('New protection level'),
    owner_type: ownerTypeEnum.optional().describe('New owner type'),
    owner_id: z.string().optional().describe('New owner ID'),
    is_auto_load: z.boolean().optional().describe('New auto-load setting'),
    description: z.string().optional().describe('New description'),
    source_type: sourceTypeEnum.optional().describe('New source type'),
    source_url: z.string().optional().describe('New source URL'),
    file_path: z.string().optional().describe('New file path'),
    file_permissions: z.string().optional().describe('New file permissions'),
    status: statusEnum.optional().describe('New status'),
    skill_ref: z.string().optional().describe('New skill reference'),
    confirmed: z.boolean().default(false).describe('Required for protected/guarded documents'),
  },
  async (params) => {
    try {
      const blocked = await checkProtection(params.id, params.confirmed, 'update');
      if (blocked) return blocked;

      const { confirmed, ...fields } = params;
      await updateDocumentFields(clients, fields);

      return textResponse(`Document ${params.id} fields updated successfully.`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'delete_document',
  'Soft-delete a document. Can be restored within 30 days. Respects protection levels.',
  {
    id: z.coerce.number().describe('Document ID to delete'),
    agent: z.string().describe('Agent performing the deletion'),
    confirmed: z.boolean().default(false).describe('Required for protected/guarded documents. Also shows preview before deletion if false.'),
  },
  async (params) => {
    try {
      const blocked = await checkProtection(params.id, params.confirmed, 'delete');
      if (blocked) return blocked;

      await deleteDocument(clients, params.id, params.agent);
      return textResponse(`Document ${params.id} soft-deleted. Can be restored within 30 days.`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'restore_document',
  'Undo a soft-delete. Use when a document was accidentally deleted. Only works within 30 days of deletion.',
  {
    id: z.coerce.number().describe('Document ID to restore'),
    agent: z.string().describe('Agent performing the restore'),
  },
  async (params) => {
    try {
      await restoreDocument(clients, params.id, params.agent);
      return textResponse(`Document ${params.id} restored. Note: chunks were removed during delete — update the document content to regenerate search index.`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'search_by_meaning',
  'Search by meaning only (vector similarity). Use when you want conceptual matches — "how does auth work" finds OAuth docs even without those exact words. Prefer search_documents for general use.',
  {
    query: z.string().describe('What to search for'),
    threshold: z.coerce.number().min(0).max(1).default(0.38).describe('Minimum cosine similarity (0-1)'),
    limit: z.coerce.number().min(1).max(50).default(10).describe('Max results'),
    domain: domainEnum.optional().describe('Filter by domain'),
    document_type: z.string().optional().describe('Filter by document type'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async (params) => {
    try {
      const results = await searchByVector(clients, {
        query: params.query,
        threshold: params.threshold,
        limit: params.limit,
        domain: params.domain,
        document_type: params.document_type,
        project: params.project,
      });

      if (results.length === 0) {
        return textResponse('No documents found matching your query.');
      }

      const formatted = results.map((result, index) => {
        const score = result.similarity?.toFixed(3) ?? 'n/a';
        return [
          `--- Result ${index + 1} [id: ${result.id}, similarity: ${score}] ---`,
          `Name: ${result.name}`,
          `Domain: ${result.domain} | Type: ${result.document_type}${result.project ? ` | Project: ${result.project}` : ''}`,
          result.description ? `Description: ${result.description}` : null,
          `Content:\n${result.content}`,
        ].filter(Boolean).join('\n');
      });

      return textResponse(`Found ${results.length} result(s):\n\n${formatted.join('\n\n')}`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'search_by_keyword',
  'Search by exact words only (full-text). Use for code identifiers, error messages, proper nouns, or exact phrases that must appear in the document.',
  {
    query: z.string().describe('Exact words to search for'),
    limit: z.coerce.number().min(1).max(50).default(10).describe('Max results'),
    domain: domainEnum.optional().describe('Filter by domain'),
    document_type: z.string().optional().describe('Filter by document type'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async (params) => {
    try {
      const results = await searchByKeyword(clients, {
        query: params.query,
        limit: params.limit,
        domain: params.domain,
        document_type: params.document_type,
        project: params.project,
      });

      if (results.length === 0) {
        return textResponse('No documents found matching your keywords.');
      }

      const formatted = results.map((result, index) => {
        const score = result.rank?.toFixed(3) ?? 'n/a';
        return [
          `--- Result ${index + 1} [id: ${result.id}, rank: ${score}] ---`,
          `Name: ${result.name}`,
          `Domain: ${result.domain} | Type: ${result.document_type}${result.project ? ` | Project: ${result.project}` : ''}`,
          result.description ? `Description: ${result.description}` : null,
          `Content:\n${result.content}`,
        ].filter(Boolean).join('\n');
      });

      return textResponse(`Found ${results.length} result(s):\n\n${formatted.join('\n\n')}`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'get_document_context',
  'Get the relevant section of a large document. Use after search returns a match — this extracts just the part you need instead of the full content, saving tokens. For small documents, returns the full content.',
  {
    document_id: z.coerce.number().describe('Document ID (from a search result)'),
    matched_chunk_index: z.coerce.number().describe('Chunk index that matched (from search)'),
    context_window: z.coerce.number().default(4000).describe('Max characters to return'),
    neighbor_count: z.coerce.number().default(1).describe('Number of neighboring chunks to include for context'),
  },
  async (params) => {
    try {
      const result = await retrieveContext(clients.supabase, {
        document_id: params.document_id,
        matched_chunk_index: params.matched_chunk_index,
        context_window: params.context_window,
        neighbor_count: params.neighbor_count,
      });

      if (!result) {
        return textResponse(`No context found for document ${params.document_id}, chunk ${params.matched_chunk_index}.`);
      }

      return textResponse([
        `Document: ${result.document_name} (id: ${result.document_id})`,
        `Retrieval mode: ${result.retrieval_mode}`,
        `---`,
        result.content,
      ].join('\n'));
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

// =============================================================================
// Deprecated tools — *_notes (redirect to new implementations)
// These will be removed in a future version.
// =============================================================================

server.tool(
  'search_notes',
  '[DEPRECATED — use search_documents] Search memories by meaning using semantic similarity.',
  {
    query: z.string().describe('What to search for'),
    threshold: z.coerce.number().min(0).max(1).default(0.38).describe('Minimum vector similarity score'),
    limit: z.coerce.number().min(1).max(50).default(10).describe('Max results'),
    type: z.string().optional().describe('Filter by type (maps to document_type)'),
    project: z.string().optional().describe('Filter by project'),
    domain: z.string().optional().describe('Filter by domain'),
  },
  async (params) => {
    try {
      const results = await searchHybrid(clients, {
        query: params.query,
        threshold: params.threshold,
        limit: params.limit,
        domain: params.domain as any,
        document_type: params.type,
        project: params.project,
      });

      if (results.length === 0) {
        return textResponse('No results found.');
      }

      const formatted = results.map((result) => {
        const score = result.score?.toFixed(3) ?? result.similarity?.toFixed(3) ?? 'n/a';
        return `[${result.id}] ${result.name} (score: ${score})\n${result.content}`;
      });

      return textResponse(formatted.join('\n\n---\n\n'));
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'add_note',
  '[DEPRECATED — use add_document] Save a new memory/note to the knowledge base.',
  {
    content: z.string().describe('The note content'),
    type: z.string().describe('Note type (maps to document_type)'),
    agent: z.string().describe('Agent saving this note'),
    metadata: z.record(z.string(), z.unknown()).default({}).describe('Metadata fields: domain, protection, auto_load, project, upsert_key, description, file_path, file_permissions, skill_ref'),
  },
  async (params) => {
    try {
      const meta = params.metadata;
      const documentId = await createDocument(clients, {
        name: (meta.upsert_key as string) ?? `note-${Date.now()}`,
        domain: (meta.domain as any) ?? 'general',
        document_type: params.type,
        content: params.content,
        description: meta.description as string | undefined,
        project: meta.project as string | undefined,
        protection: meta.protection as any,
        owner_type: meta.owner_type as any,
        owner_id: meta.owner_id as string | undefined,
        is_auto_load: meta.auto_load as boolean | undefined,
        source_type: meta.source_type as any,
        file_path: meta.file_path as string | undefined,
        file_permissions: meta.file_permissions as string | undefined,
        agent: params.agent,
        status: meta.status as any,
        skill_ref: meta.skill_ref as string | undefined,
      });

      return textResponse(`Note saved (id: ${documentId}). Tip: use add_document instead of add_note.`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'list_notes',
  '[DEPRECATED — use list_documents] List recent notes from the knowledge base.',
  {
    limit: z.coerce.number().min(1).max(100).default(20).describe('Number of notes to return'),
    type: z.string().optional().describe('Filter by note type'),
    project: z.string().optional().describe('Filter by project'),
    domain: z.string().optional().describe('Filter by domain'),
  },
  async (params) => {
    try {
      const documents = await listDocuments(clients.supabase, {
        domain: params.domain as any,
        document_type: params.type,
        project: params.project,
        limit: params.limit,
      });

      if (documents.length === 0) {
        return textResponse('No notes found.');
      }

      const formatted = documents.map((document) => {
        return `[${document.id}] ${document.created_at}\n${document.content}`;
      });

      return textResponse(formatted.join('\n\n---\n\n'));
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'update_note',
  '[DEPRECATED — use update_document] Update an existing note by ID.',
  {
    id: z.coerce.number().describe('Note ID to update'),
    content: z.string().describe('New content'),
    confirmed: z.boolean().default(false).describe('Required for protected notes'),
  },
  async (params) => {
    try {
      const blocked = await checkProtection(params.id, params.confirmed, 'update');
      if (blocked) return blocked;

      await updateDocument(clients, {
        id: params.id,
        content: params.content,
      });

      return textResponse(`Note ${params.id} updated. Tip: use update_document instead of update_note.`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'update_metadata',
  '[DEPRECATED — use update_document_fields] Update metadata fields on an existing note.',
  {
    id: z.coerce.number().describe('Note ID to update'),
    metadata: z.record(z.string(), z.unknown()).describe('Metadata fields to update'),
    confirmed: z.boolean().default(false).describe('Required for protected notes'),
  },
  async (params) => {
    try {
      const blocked = await checkProtection(params.id, params.confirmed, 'update');
      if (blocked) return blocked;

      const meta = params.metadata;
      await updateDocumentFields(clients, {
        id: params.id,
        name: meta.name as string | undefined,
        domain: meta.domain as any,
        document_type: meta.document_type as string | undefined,
        project: meta.project as string | undefined,
        protection: meta.protection as any,
        owner_type: meta.owner_type as any,
        owner_id: meta.owner_id as string | undefined,
        is_auto_load: meta.auto_load as boolean | undefined,
        description: meta.description as string | undefined,
        source_type: meta.source_type as any,
        source_url: meta.source_url as string | undefined,
        file_path: meta.file_path as string | undefined,
        file_permissions: meta.file_permissions as string | undefined,
        status: meta.status as any,
        skill_ref: meta.skill_ref as string | undefined,
      });

      return textResponse(`Note ${params.id} metadata updated. Tip: use update_document_fields instead of update_metadata.`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

server.tool(
  'delete_note',
  '[DEPRECATED — use delete_document] Delete a note by ID.',
  {
    id: z.coerce.number().describe('Note ID to delete'),
    confirmed: z.boolean().default(false).describe('Required for protected notes and deletion confirmation'),
  },
  async (params) => {
    try {
      const blocked = await checkProtection(params.id, params.confirmed, 'delete');
      if (blocked) return blocked;

      await deleteDocument(clients, params.id, 'unknown');
      return textResponse(`Note ${params.id} deleted. Tip: use delete_document instead of delete_note.`);
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }
);

// =============================================================================
// Start
// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);
