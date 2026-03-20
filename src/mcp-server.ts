import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { z } from 'zod';
import {
  opSearchNotes,
  opListNotes,
  opAddNote,
  opUpdateNote,
  opUpdateMetadata,
  opDeleteNote,
  getTypeRegistry,
  type Clients,
} from './lib/notes.js';

// --- Clients ---

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

const clients: Clients = {
  supabase: createClient(supabaseUrl, supabaseKey),
  openai: new OpenAI({ apiKey: openaiKey }),
};

// Build dynamic type description from registry
const typeRegistry = getTypeRegistry();
const typeList = Object.entries(typeRegistry)
  .map(([t, d]) => `${t} (${d})`)
  .join(', ');

// --- MCP Server ---

const server = new McpServer({
  name: 'ledger',
  version: '1.0.0',
});

// Tool: Search notes by semantic similarity
server.tool(
  'search_notes',
  'Search memories by meaning using semantic similarity. If a result is chunked, all sibling chunks are returned reassembled.',
  {
    query: z.string().describe('What to search for'),
    threshold: z.coerce.number().min(0).max(1).default(0.5).describe('Minimum similarity score (0-1)'),
    limit: z.coerce.number().min(1).max(50).default(10).describe('Max results to return'),
    type: z.string().optional().describe('Filter by note type (e.g. feedback, reference, event)'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async ({ query, threshold, limit, type, project }) => {
    const result = await opSearchNotes(clients, query, threshold, limit, type, project);
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// Tool: Add a new note
server.tool(
  'add_note',
  'Save a new memory/note to the knowledge base. Large notes are automatically chunked for embedding. Use upsert_key in metadata to update an existing note instead of creating a duplicate.',
  {
    content: z.string().describe('The note content to save'),
    type: z.string().describe(`Note type. Registered: ${typeList}. Unknown types will prompt for registration.`),
    agent: z.string().describe('Which agent is saving this note (e.g. claude-code, zhuli)'),
    metadata: z.record(z.string(), z.unknown()).default({}).describe('Optional metadata (project, local_file, upsert_key, etc.)'),
    force: z.boolean().default(false).describe('Skip duplicate check and force creation of a new note'),
    register_type: z.boolean().default(false).describe('Set to true to register an unknown type before saving. Pass delivery in metadata if not using default (knowledge).'),
  },
  async ({ content, type, agent, metadata, force, register_type }) => {
    const result = await opAddNote(clients, content, type, agent, metadata, force, register_type);
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// Tool: Update an existing note by ID
server.tool(
  'update_note',
  'Update an existing note by ID. Replaces content and re-generates embedding. If the note was chunked, all chunks are replaced. First call without confirmed shows current content for verification. Call with confirmed: true to execute.',
  {
    id: z.coerce.number().describe('The note ID to update'),
    content: z.string().describe('The new content'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional: replace metadata (keeps existing if omitted)'),
    confirmed: z.boolean().default(false).describe('Set to true to execute the update. Without this, shows the current note for confirmation.'),
  },
  async ({ id, content, metadata, confirmed }) => {
    const result = await opUpdateNote(clients, id, content, metadata, confirmed);
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// Tool: List recent notes
server.tool(
  'list_notes',
  'List recent notes from the knowledge base',
  {
    limit: z.coerce.number().min(1).max(100).default(20).describe('Number of notes to return'),
    type: z.string().optional().describe('Filter by note type (e.g. feedback, reference, event)'),
    project: z.string().optional().describe('Filter by project name'),
  },
  async ({ limit, type, project }) => {
    const result = await opListNotes(clients, limit, type, project);
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// Tool: Delete a note
server.tool(
  'delete_note',
  'Delete a note from the knowledge base by ID. If the note is chunked, all chunks in the group are deleted. First call without confirmed shows the note for verification. Call with confirmed: true to execute.',
  {
    id: z.coerce.number().describe('The note ID to delete'),
    confirmed: z.boolean().default(false).describe('Set to true to execute the deletion. Without this, shows the note for confirmation.'),
  },
  async ({ id, confirmed }) => {
    const result = await opDeleteNote(clients, id, confirmed);
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// Tool: Update metadata only (no content change, no confirmation needed)
server.tool(
  'update_metadata',
  'Update metadata fields on an existing note without changing content. Useful for adding descriptions, tags, project, or scope.',
  {
    id: z.coerce.number().describe('The note ID to update'),
    metadata: z.record(z.string(), z.unknown()).describe('Metadata fields to merge (existing fields are preserved unless overwritten)'),
  },
  async ({ id, metadata }) => {
    const result = await opUpdateMetadata(clients, id, metadata);
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
