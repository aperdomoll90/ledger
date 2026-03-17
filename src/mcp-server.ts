import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { z } from 'zod';
import { randomUUID, createHash } from 'crypto';

// --- Types ---

interface NoteRow {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
  created_at: string;
  updated_at: string;
}

interface MatchResult {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

// --- Constants ---

const MAX_CHARS_PER_CHUNK = 25_000;
const CHUNK_OVERLAP = 2_000;

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

const supabase = createClient(supabaseUrl, supabaseKey);
const openai = new OpenAI({ apiKey: openaiKey });

// --- Helpers ---

function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      // Start next chunk with overlap from end of current
      const overlapText = current.slice(-overlap);
      current = overlapText + '\n\n' + paragraph;
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // Edge case: a single paragraph exceeds maxChars — force split by character
  return chunks.flatMap((chunk) => {
    if (chunk.length <= maxChars) return [chunk];
    const forced: string[] = [];
    for (let i = 0; i < chunk.length; i += maxChars - overlap) {
      forced.push(chunk.slice(i, i + maxChars));
    }
    return forced;
  });
}

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
    const embedding = await getEmbedding(query);

    // Fetch more results than needed so we can filter and still meet limit
    const fetchLimit = (type || project) ? limit * 3 : limit;

    const { data, error } = await supabase.rpc('match_notes', {
      q_emb: JSON.stringify(embedding),
      threshold,
      max_results: fetchLimit,
    });

    if (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] };
    }

    let results = data as MatchResult[];

    // Apply filters
    if (type) {
      results = results.filter(n => (n.metadata as Record<string, unknown>).type === type);
    }
    if (project) {
      results = results.filter(n => (n.metadata as Record<string, unknown>).project === project);
    }
    results = results.slice(0, limit);

    if (!results || results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching notes found.' }] };
    }

    // Reassemble chunked notes: fetch all sibling chunks for any chunked result
    const seenGroups = new Set<string>();
    const output: string[] = [];

    for (const note of results) {
      const meta = note.metadata as Record<string, unknown>;
      const groupId = meta.chunk_group as string | undefined;

      if (groupId) {
        if (seenGroups.has(groupId)) continue;
        seenGroups.add(groupId);

        // Fetch all chunks in this group, ordered by index
        const { data: siblings, error: sibError } = await supabase
          .from('notes')
          .select('id, content, metadata, created_at')
          .eq('metadata->>chunk_group', groupId)
          .order('metadata->>chunk_index', { ascending: true });

        if (sibError || !siblings || siblings.length === 0) {
          output.push(`[${note.id}] (similarity: ${note.similarity.toFixed(3)}) [chunked, sibling fetch failed]\n${note.content}\nMetadata: ${JSON.stringify(note.metadata)}`);
        } else {
          const reassembled = siblings.map((s: { content: string }) => s.content).join('\n\n');
          const firstId = siblings[0].id;
          const chunkCount = siblings.length;
          output.push(`[${firstId}] (similarity: ${note.similarity.toFixed(3)}) [${chunkCount} chunks reassembled]\n${reassembled}\nMetadata: ${JSON.stringify({ ...meta, chunk_group: groupId, chunks: chunkCount })}`);
        }
      } else {
        output.push(`[${note.id}] (similarity: ${note.similarity.toFixed(3)})\n${note.content}\nMetadata: ${JSON.stringify(note.metadata)}`);
      }
    }

    return { content: [{ type: 'text' as const, text: output.join('\n\n---\n\n') }] };
  }
);

// Tool: Add a new note (with automatic chunking for large content)
server.tool(
  'add_note',
  'Save a new memory/note to the knowledge base. Large notes are automatically chunked for embedding. Use upsert_key in metadata to update an existing note instead of creating a duplicate.',
  {
    content: z.string().describe('The note content to save'),
    type: z.enum(['user-preference', 'feedback', 'architecture-decision', 'project-status', 'reference', 'event', 'error', 'general']).describe('Note type for consistent categorization'),
    agent: z.string().describe('Which agent is saving this note (e.g. claude-code, zhuli)'),
    metadata: z.record(z.string(), z.unknown()).default({}).describe('Optional metadata (project, local_file, upsert_key, etc.)'),
  },
  async ({ content, type, agent, metadata }) => {
    // Merge type and agent into metadata, include content hash
    const fullMetadata = { ...metadata, type, agent, content_hash: contentHash(content) };
    const upsertKey = metadata.upsert_key as string | undefined;

    // If upsert_key provided, check for existing note and update it instead
    if (upsertKey) {
      const { data: existing } = await supabase
        .from('notes')
        .select('id, metadata')
        .eq('metadata->>upsert_key', upsertKey)
        .limit(1)
        .single();

      if (existing) {
        // Delete old note (and its chunks if any)
        const oldMeta = existing.metadata as Record<string, unknown>;
        const oldGroup = oldMeta.chunk_group as string | undefined;

        if (oldGroup) {
          await supabase.from('notes').delete().eq('metadata->>chunk_group', oldGroup);
        } else {
          await supabase.from('notes').delete().eq('id', existing.id);
        }
      }
    }

    const chunks = chunkText(content, MAX_CHARS_PER_CHUNK, CHUNK_OVERLAP);

    if (chunks.length === 1) {
      // Single note — no chunking needed
      const embedding = await getEmbedding(content);

      const { data, error } = await supabase
        .from('notes')
        .insert({ content, metadata: fullMetadata, embedding })
        .select('id, created_at')
        .single();

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] };
      }

      const uKey = (fullMetadata as Record<string, unknown>).upsert_key as string | undefined;
      const label = uKey || `id ${data.id}`;
      const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
      return {
        content: [{ type: 'text' as const, text: `Saved "${label}" (id: ${data.id}, type: ${type}, ${content.length} chars)\nPreview: ${preview}` }],
      };
    }

    // Multiple chunks — embed and store each with shared group ID
    const groupId = randomUUID();
    const ids: number[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkMeta = {
        ...fullMetadata,
        chunk_group: groupId,
        chunk_index: i,
        total_chunks: chunks.length,
      };

      const embedding = await getEmbedding(chunks[i]);

      const { data, error } = await supabase
        .from('notes')
        .insert({ content: chunks[i], metadata: chunkMeta, embedding })
        .select('id')
        .single();

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error saving chunk ${i + 1}/${chunks.length}: ${error.message}` }] };
      }

      ids.push(data.id);
    }

    return {
      content: [{ type: 'text' as const, text: `Saved "${(fullMetadata as Record<string, unknown>).upsert_key || 'chunked'}" as ${chunks.length} chunks (ids: ${ids.join(', ')}, ${content.length} chars total)` }],
    };
  }
);

// Tool: Update an existing note by ID
server.tool(
  'update_note',
  'Update an existing note by ID. Replaces content and re-generates embedding. If the note was chunked, all chunks are replaced.',
  {
    id: z.coerce.number().describe('The note ID to update'),
    content: z.string().describe('The new content'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional: replace metadata (keeps existing if omitted)'),
  },
  async ({ id, content, metadata }) => {
    // Check if this note is part of a chunk group
    const { data: existing, error: fetchError } = await supabase
      .from('notes')
      .select('id, metadata')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      return { content: [{ type: 'text' as const, text: `Error: note ${id} not found.` }] };
    }

    const existingMeta = existing.metadata as Record<string, unknown>;
    const groupId = existingMeta.chunk_group as string | undefined;
    const baseMeta = metadata ?? existingMeta;

    // Delete old chunks if this was a chunked note
    if (groupId) {
      await supabase.from('notes').delete().eq('metadata->>chunk_group', groupId);
    } else {
      await supabase.from('notes').delete().eq('id', id);
    }

    // Re-insert with chunking support
    const chunks = chunkText(content, MAX_CHARS_PER_CHUNK, CHUNK_OVERLAP);

    if (chunks.length === 1) {
      const embedding = await getEmbedding(content);
      // Remove old chunk metadata, add content hash
      const { chunk_group, chunk_index, total_chunks, ...cleanMeta } = baseMeta as Record<string, unknown>;
      const updatedMeta = { ...cleanMeta, content_hash: contentHash(content) };

      const { data, error } = await supabase
        .from('notes')
        .insert({ content, metadata: updatedMeta, embedding })
        .select('id, created_at')
        .single();

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] };
      }

      const uKey = (baseMeta as Record<string, unknown>).upsert_key as string | undefined;
      const label = uKey || `id ${data.id}`;
      const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
      return {
        content: [{ type: 'text' as const, text: `Updated "${label}" (id: ${data.id}, ${content.length} chars)\nPreview: ${preview}` }],
      };
    }

    const newGroupId = randomUUID();
    const ids: number[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const { chunk_group, chunk_index, total_chunks, ...cleanMeta } = baseMeta as Record<string, unknown>;
      const chunkMeta = {
        ...cleanMeta,
        chunk_group: newGroupId,
        chunk_index: i,
        total_chunks: chunks.length,
      };

      const embedding = await getEmbedding(chunks[i]);

      const { data, error } = await supabase
        .from('notes')
        .insert({ content: chunks[i], metadata: chunkMeta, embedding })
        .select('id')
        .single();

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error updating chunk ${i + 1}/${chunks.length}: ${error.message}` }] };
      }

      ids.push(data.id);
    }

    return {
      content: [{ type: 'text' as const, text: `Note updated as ${chunks.length} chunks (ids: ${ids.join(', ')}, group: ${newGroupId})` }],
    };
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
    let query = supabase
      .from('notes')
      .select('id, content, metadata, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (type) {
      query = query.eq('metadata->>type', type);
    }
    if (project) {
      query = query.eq('metadata->>project', project);
    }

    const { data, error } = await query;

    if (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] };
    }

    const notes = data as Pick<NoteRow, 'id' | 'content' | 'metadata' | 'created_at'>[];

    if (!notes || notes.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No notes found.' }] };
    }

    const formatted = notes.map((note) => {
      const meta = note.metadata as Record<string, unknown>;
      const chunkInfo = meta.chunk_group ? ` [chunk ${(meta.chunk_index as number) + 1}/${meta.total_chunks}]` : '';
      return `[${note.id}]${chunkInfo} ${note.created_at}\n${note.content.slice(0, 200)}${note.content.length > 200 ? '...' : ''}\nMetadata: ${JSON.stringify(note.metadata)}`;
    }).join('\n\n---\n\n');

    return { content: [{ type: 'text' as const, text: formatted }] };
  }
);

// Tool: Delete a note
server.tool(
  'delete_note',
  'Delete a note from the knowledge base by ID. If the note is chunked, all chunks in the group are deleted.',
  {
    id: z.coerce.number().describe('The note ID to delete'),
  },
  async ({ id }) => {
    // Check if this note is part of a chunk group
    const { data: existing } = await supabase
      .from('notes')
      .select('metadata')
      .eq('id', id)
      .single();

    if (existing) {
      const meta = existing.metadata as Record<string, unknown>;
      const groupId = meta.chunk_group as string | undefined;

      if (groupId) {
        const { error } = await supabase
          .from('notes')
          .delete()
          .eq('metadata->>chunk_group', groupId);

        if (error) {
          return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] };
        }

        return { content: [{ type: 'text' as const, text: `Deleted all chunks in group ${groupId}.` }] };
      }
    }

    const { error } = await supabase
      .from('notes')
      .delete()
      .eq('id', id);

    if (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error.message}` }] };
    }

    return { content: [{ type: 'text' as const, text: `Note ${id} deleted.` }] };
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
