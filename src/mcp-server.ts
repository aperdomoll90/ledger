// mcp-server.ts
// MCP server — the API surface that AI agents call.
// Each tool is a thin wrapper: validate input (Zod) → check protection → call library → format response.
// Zero business logic here — that all lives in the library files.

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { z } from 'zod';

import type { IClientsProps } from './lib/documents/classification.js';
import { createDocument, updateDocument, updateDocumentFields, deleteDocument, restoreDocument } from './lib/documents/operations.js';
import { getDocumentById, listDocuments } from './lib/documents/fetching.js';
import { searchHybrid, searchByVector, searchByKeyword, retrieveContext } from './lib/search/ai-search.js';

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
  openai: new OpenAI({ apiKey: openaiKey }),
  cohereApiKey: process.env.COHERE_API_KEY || undefined,
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
  'add_document',
  'Create a new document in the knowledge base. Content is automatically chunked and embedded for search.',
  {
    name: z.string().describe('Document name (unique identifier)'),
    domain: domainEnum.describe('Document domain'),
    document_type: z.string().describe('Document type (e.g. knowledge-guide, project-status, reference)'),
    content: z.string().describe('Document content'),
    description: z.string().optional().describe('Short description of the document'),
    project: z.string().optional().describe('Project name'),
    protection: protectionEnum.optional().describe('Protection level (default: open)'),
    owner_type: ownerTypeEnum.optional().describe('Owner type (default: user)'),
    owner_id: z.string().optional().describe('Owner identifier'),
    is_auto_load: z.boolean().optional().describe('Auto-load into agent context on session start'),
    source_type: sourceTypeEnum.optional().describe('Source content type (default: text)'),
    source_url: z.string().optional().describe('URL of original source'),
    file_path: z.string().optional().describe('Local file path for sync'),
    file_permissions: z.string().optional().describe('File permissions string'),
    agent: z.string().optional().describe('Agent creating this document'),
    status: statusEnum.optional().describe('Document status'),
    skill_ref: z.string().optional().describe('Reference to associated skill'),
  },
  async (params) => {
    try {
      const documentId = await createDocument(clients, params);
      return textResponse(`Document created successfully (id: ${documentId})`);
    } catch (error) {
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
  'update_document',
  'Update a document\'s content. Triggers re-chunking and re-embedding. Respects protection levels.',
  {
    id: z.coerce.number().describe('Document ID to update'),
    content: z.string().describe('New content'),
    agent: z.string().optional().describe('Agent performing the update'),
    description: z.string().optional().describe('Updated description'),
    status: statusEnum.optional().describe('Updated status'),
    confirmed: z.boolean().default(false).describe('Required for protected/guarded documents'),
  },
  async (params) => {
    try {
      const blocked = await checkProtection(params.id, params.confirmed, 'update');
      if (blocked) return blocked;

      await updateDocument(clients, {
        id: params.id,
        content: params.content,
        agent: params.agent,
        description: params.description,
        status: params.status,
      });

      return textResponse(`Document ${params.id} updated successfully.`);
    } catch (error) {
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
      const results = await searchByKeyword(clients.supabase, {
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
