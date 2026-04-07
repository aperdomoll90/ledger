# Ledger v2 — TypeScript Architecture

> Date: 2026-03-30 | Status: Design | Project: Ledger

## Goal

Rewrite the TypeScript codebase from scratch to work with the new database schema (9 tables, 15 Postgres functions). The old `notes.ts` (1000+ lines) is replaced by 5 focused modules. New MCP tools alongside deprecated old ones.

## Problem with old code

- `notes.ts` was 1000+ lines doing everything — types, queries, operations, chunking, validation
- All data in JSONB `metadata` — TypeScript had to parse and validate at runtime
- No separation between reads, writes, search, and embedding logic
- Chunking was hacked into the same table as documents

## New architecture

TypeScript's role is simpler now — the database handles transactions, audit, versioning, and constraints. TypeScript:
1. Prepares data (generate embeddings, chunk text, hash content)
2. Calls the right Postgres RPC function
3. Returns the response

---

## File Structure

### 5 library files in `src/lib/`

| File                          | Responsibility                                          | Depends on                                      |
|-------------------------------|--------------------------------------------------------|------------------------------------------------|
| `document-classification.ts`  | Types, domains, protection, inference, validation       | Nothing — pure logic, no I/O                    |
| `embeddings.ts`               | Generate embeddings, chunk text, cache queries, hash    | OpenAI API, Supabase (query_cache table)        |
| `document-operations.ts`      | Create, update, delete, restore documents               | Supabase RPC, embeddings.ts, document-classification.ts |
| `document-fetching.ts`        | Get documents by ID, name, filters                      | Supabase queries                                |
| `ai-search.ts`                | Vector, keyword, hybrid search + smart retrieval        | Supabase RPC, embeddings.ts                     |

### Why this split

| Concern          | Old code                     | New code                    |
|-----------------|-----------------------------|-----------------------------|
| Write documents  | `notes.ts` (mixed with everything) | `document-operations.ts`   |
| Read documents   | `notes.ts`                   | `document-fetching.ts`     |
| Search           | `notes.ts`                   | `ai-search.ts`             |
| Embeddings       | `notes.ts`                   | `embeddings.ts`            |
| Domain model     | `notes.ts` + `domains.ts`   | `document-classification.ts` |

Each file does one thing. No file depends on more than 2 others. Any file can be understood and tested independently.

### Files that get deleted

| File | Why |
|------|-----|
| `src/lib/notes.ts` | Replaced entirely by the 4 new files |
| `src/lib/audit.ts` | Postgres functions handle all audit now |
| `src/lib/backfill.ts` | Replaced by migration script |
| `src/lib/generators.ts` | Already deleted (CLAUDE.md + MEMORY.md stored as documents) |

### Files that stay

| File | Changes |
|------|---------|
| `src/lib/file-writer.ts` | No changes — still needed for writing documents to disk |
| `src/lib/config.ts` | No changes — loads credentials and config |
| `src/lib/hash.ts` | No changes — SHA-256 content hashing |
| `src/lib/errors.ts` | No changes — error types |
| `src/lib/prompt.ts` | No changes — CLI interactive prompts |

---

## Interfaces

All interfaces follow the `INameProps` pattern: `I` prefix + descriptive name + `Props` suffix.
All constrained fields use string unions matching database CHECK constraints.

### Core types (in `document-classification.ts`)

```typescript
// Domain model — matches CHECK constraints
export type Domain = 'system' | 'persona' | 'workspace' | 'project' | 'general';
export type Protection = 'open' | 'guarded' | 'protected' | 'immutable';
export type OwnerType = 'system' | 'user' | 'team';
export type DocumentStatus = 'idea' | 'planning' | 'active' | 'done';
export type SourceType = 'text' | 'pdf' | 'docx' | 'spreadsheet' | 'code' | 'image' | 'audio' | 'video' | 'web' | 'email' | 'slides' | 'handwriting';
export type ChunkStrategy = 'header' | 'paragraph' | 'sentence' | 'semantic' | 'forced';
export type ChunkContentType = 'text' | 'image_description' | 'table_extraction' | 'code_block' | 'transcript' | 'slide_text';

// Shared type categories
export type ExtensionType = 'skill' | 'hook' | 'plugin-config';
export type ResourceType = 'reference' | 'knowledge' | 'eval-result';
export type DocType = 'claude-md' | 'memory-md';
```

### Document interfaces (in `document-classification.ts`)

```typescript
// Full document row — matches documents table 1:1
export interface IDocumentProps {
  id: number;
  name: string;
  domain: Domain;
  document_type: string;
  project: string | null;
  protection: Protection;
  owner_type: OwnerType;
  owner_id: string | null;
  is_auto_load: boolean;
  content: string;
  description: string | null;
  content_hash: string | null;
  source_type: SourceType;
  source_url: string | null;
  file_path: string | null;
  file_permissions: string | null;
  agent: string | null;
  status: DocumentStatus | null;
  skill_ref: string | null;
  embedding_model_id: string | null;
  schema_version: number;
  content_length: number;
  chunk_count: number;
  retrieval_count: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// What you pass to create a new document
export interface ICreateDocumentProps {
  name: string;
  domain: Domain;
  document_type: string;
  content: string;
  description?: string;
  project?: string;
  protection?: Protection;
  owner_type?: OwnerType;
  owner_id?: string;
  is_auto_load?: boolean;
  source_type?: SourceType;
  source_url?: string;
  file_path?: string;
  file_permissions?: string;
  agent?: string;
  status?: DocumentStatus;
  skill_ref?: string;
  embedding_model_id?: string;
  content_hash?: string;
}

// What you pass to update a document's content
export interface IUpdateDocumentProps {
  id: number;
  content: string;
  agent?: string;
  description?: string;
  status?: DocumentStatus;
  embedding_model_id?: string;
  content_hash?: string;
}

// What you pass to update fields (not content)
export interface IUpdateFieldsProps {
  id: number;
  agent?: string;
  name?: string;
  domain?: Domain;
  document_type?: string;
  project?: string;
  protection?: Protection;
  owner_type?: OwnerType;
  owner_id?: string;
  is_auto_load?: boolean;
  description?: string;
  source_type?: SourceType;
  source_url?: string;
  file_path?: string;
  file_permissions?: string;
  status?: DocumentStatus;
  skill_ref?: string;
  embedding_model_id?: string;
}

// Filters for listing documents
export interface IListDocumentsProps {
  domain?: Domain;
  document_type?: string;
  project?: string;
  limit?: number;
}
```

### Search interfaces (in `ai-search.ts`)

```typescript
// Search result — flat columns, no JSONB metadata wrapper.
// All three search functions return the same columns.
export interface ISearchResultProps {
  id: number;
  content: string;
  name: string;
  domain: Domain;
  document_type: string;
  project: string | null;
  protection: Protection;
  description: string | null;
  agent: string | null;
  status: DocumentStatus | null;
  file_path: string | null;
  skill_ref: string | null;
  owner_type: string;
  owner_id: string | null;
  is_auto_load: boolean;
  content_hash: string | null;
  similarity?: number;  // vector search
  rank?: number;        // keyword search
  score?: number;       // hybrid search
}

// Vector search parameters
export interface IVectorSearchProps {
  query: string;
  threshold?: number;
  limit?: number;
  domain?: Domain;
  document_type?: string;
  project?: string;
}

// Keyword search parameters
export interface IKeywordSearchProps {
  query: string;
  limit?: number;
  domain?: Domain;
  document_type?: string;
  project?: string;
}

// Hybrid search parameters
export interface IHybridSearchProps {
  query: string;
  threshold?: number;
  limit?: number;
  domain?: Domain;
  document_type?: string;
  project?: string;
  rrf_k?: number;
}

// Smart retrieval parameters
export interface IRetrieveContextProps {
  document_id: number;
  matched_chunk_index: number;
  context_window?: number;
  neighbor_count?: number;
}

// Smart retrieval result
export interface IContextResultProps {
  document_id: number;
  document_name: string;
  retrieval_mode: 'full' | 'chunked';
  content: string;
  matched_section: string;
}
```

### Embedding interfaces (in `embeddings.ts`)

```typescript
// Chunk data produced by chunking
export interface IChunkProps {
  content: string;
  chunk_index: number;
  content_type: ChunkContentType;
  strategy: ChunkStrategy;
  overlap_chars: number;
}

// Supabase client — structural type covering all methods we use
// Defined once in document-classification.ts so every file agrees on the shape
// Uses PromiseLike (not Promise) because Supabase's rpc() returns PostgrestFilterBuilder
export interface ISupabaseClientProps {
  from: (table: string) => any;
  rpc: (functionName: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

// OpenAI client — structural type covering embedding generation
export interface IOpenAIClientProps {
  embeddings: { create: (params: { model: string; input: string }) => Promise<{ data: Array<{ embedding: number[] }> }> };
}

// Combined clients — passed to functions that need both database and AI
export interface IClientsProps {
  supabase: ISupabaseClientProps;
  openai: IOpenAIClientProps;
}
```

---

## Function Signatures

### `document-operations.ts`

| Function | Takes | Returns | Calls |
|----------|-------|---------|-------|
| `createDocument(clients, props)` | `IClientsProps`, `ICreateDocumentProps` | `number` (new ID) | embeddings.ts → `document_create` RPC |
| `updateDocument(clients, props)` | `IClientsProps`, `IUpdateDocumentProps` | `void` | embeddings.ts → `document_update` RPC |
| `updateDocumentFields(clients, props)` | `IClientsProps`, `IUpdateFieldsProps` | `void` | `document_update_fields` RPC |
| `deleteDocument(clients, id, agent)` | `IClientsProps`, `number`, `string` | `void` | `document_delete` RPC |
| `restoreDocument(clients, id, agent)` | `IClientsProps`, `number`, `string` | `void` | `document_restore` RPC |

### `document-fetching.ts`

| Function | Takes | Returns | Calls |
|----------|-------|---------|-------|
| `getDocumentById(supabase, id)` | `ISupabaseClientProps`, `number` | `IDocumentProps \| null` | SELECT from documents |
| `getDocumentByName(supabase, name)` | `ISupabaseClientProps`, `string` | `IDocumentProps \| null` | SELECT from documents |
| `listDocuments(supabase, filters)` | `ISupabaseClientProps`, `IListDocumentsProps` | `IDocumentProps[]` | SELECT with filters |
| `fetchSyncableDocuments(supabase)` | `ISupabaseClientProps` | `IDocumentProps[]` | SELECT WHERE is_auto_load = true (sync is driven by auto_load, not domain) |

### `ai-search.ts`

| Function | Takes | Returns | Calls |
|----------|-------|---------|-------|
| `searchByVector(clients, props)` | `IClientsProps`, `IVectorSearchProps` | `ISearchResultProps[]` | embeddings.ts → `match_documents` RPC |
| `searchByKeyword(supabase, props)` | `ISupabaseClientProps`, `IKeywordSearchProps` | `ISearchResultProps[]` | `match_documents_keyword` RPC |
| `searchHybrid(clients, props)` | `IClientsProps`, `IHybridSearchProps` | `ISearchResultProps[]` | embeddings.ts → `match_documents_hybrid` RPC |
| `retrieveContext(supabase, props)` | `ISupabaseClientProps`, `IRetrieveContextProps` | `IContextResultProps \| null` | `retrieve_context` RPC |

### `embeddings.ts`

| Function | Takes | Returns | Calls |
|----------|-------|---------|-------|
| `generateEmbedding(openai, text)` | `IOpenAIClientProps`, `string` | `number[]` | OpenAI API |
| `chunkText(text, strategy?)` | `string`, `ChunkStrategy?` | `IChunkProps[]` | Pure logic |
| `getOrCacheQueryEmbedding(clients, query)` | `IClientsProps`, `string` | `number[]` | query_cache table + OpenAI |
| `contentHash(text)` | `string` | `string` | Pure logic (SHA-256) |
| `toVectorString(embedding)` | `number[]` | `string` | Pure logic (format for RPC) |
| `parseVector(raw)` | `unknown` | `number[]` | Pure logic (parse Postgres vector string back to number[]) |

---

## MCP Server

### New tools (10 — use new functions)

| Tool name | Calls | Description |
|-----------|-------|-------------|
| `search_documents` | `ai-search.searchHybrid` | Default search — combines meaning + keywords via RRF fusion |
| `search_by_meaning` | `ai-search.searchByVector` | Vector-only search — conceptual matches (cosine similarity) |
| `search_by_keyword` | `ai-search.searchByKeyword` | Keyword-only search — exact words (full-text, GIN index) |
| `get_document_context` | `ai-search.retrieveContext` | Smart retrieval — full doc for small, chunk + neighbors for large |
| `add_document` | `document-operations.createDocument` | Create a new document (chunk + embed + store) |
| `list_documents` | `document-fetching.listDocuments` | List documents with filters (direct SELECT) |
| `update_document` | `document-operations.updateDocument` | Update document content (re-chunk + re-embed) |
| `update_document_fields` | `document-operations.updateDocumentFields` | Update document columns (no re-embedding) |
| `delete_document` | `document-operations.deleteDocument` | Soft delete (30-day restore window) |
| `restore_document` | `document-operations.restoreDocument` | Undo a soft delete |

### Protection checks (MCP layer)

Update and delete tools call `checkProtection()` before proceeding:
- `immutable` → hard block, error message
- `protected` / `guarded` → requires `confirmed: true`, shows content preview
- `open` → proceed

### Search defaults

Vector similarity threshold defaults to 0.25 (industry standard for `text-embedding-3-small`). The threshold gates the vector component before RRF fusion — it filters by cosine similarity, not by the fused RRF score. RRF scores are relative rankings, not absolute quality measures.

### Deprecated tools (6 — kept temporarily, call new functions internally)

| Old tool name | Redirects to |
|---------------|-------------|
| `search_notes` | `searchHybrid` |
| `add_note` | `createDocument` |
| `list_notes` | `listDocuments` |
| `update_note` | `updateDocument` |
| `update_metadata` | `updateDocumentFields` |
| `delete_note` | `deleteDocument` |

---

## Data Flows

### Creating a document

```
MCP add_document
  → document-operations.createDocument(clients, props)
    → embeddings.contentHash(content)
    → embeddings.chunkText(content, 'paragraph')
    → embeddings.generateEmbedding(chunk.content) × N chunks
    → embeddings.toVectorString(embedding) × N chunks
    → supabase.rpc('document_create', { all fields + chunk arrays })
    → return document ID
```

### Searching

```
MCP search_documents
  → ai-search.searchHybrid(clients, { query, filters })
    → embeddings.getOrCacheQueryEmbedding(clients, query)
      → check query_cache for normalized query (lowercase + trim)
      → if cached: parseVector(cached.embedding) → return number[]
      → if not cached: generateEmbedding(openai, query) → cache → return number[]
    → embeddings.toVectorString(embedding)
    → supabase.rpc('match_documents_hybrid', { embedding + text + filters })
      → Postgres applies cosine similarity threshold (0.25) on vector component
      → Postgres applies text match on keyword component
      → RRF fusion combines both rankings
    → return ISearchResultProps[]
```

### Updating content

```
MCP update_document
  → document-operations.updateDocument(clients, props)
    → embeddings.contentHash(newContent)
    → embeddings.chunkText(newContent)
    → embeddings.generateEmbedding(chunk) × N
    → embeddings.toVectorString(embedding) × N
    → supabase.rpc('document_update', { id, content, chunks, embeddings })
    (Postgres function handles: version snapshot, audit, chunk replacement)
```

### Updating fields (no content change)

```
MCP update_document_fields
  → document-operations.updateDocumentFields(clients, props)
    → supabase.rpc('document_update_fields', { id, field1, field2, ... })
    (Postgres function handles: domain sync to chunks, audit)
```

---

## Error Handling

All errors from Postgres RPC calls are thrown — no silent failures. The MCP server catches errors and returns them as tool responses with `status: 'error'`.

```typescript
const { error } = await supabase.rpc('document_create', params);
if (error) throw new Error(`Failed to create document: ${error.message}`);
```

Protection checks happen in TypeScript before calling RPC:
- `immutable` → block with error message
- `protected` / `guarded` → return `confirm` status, require `confirmed: true` to proceed
- `open` → proceed

---

## Structural Typing

Library files use structural types (`ISupabaseClientProps`, `IOpenAIClientProps`) instead of importing from `@supabase/supabase-js` and `openai` packages. This prevents Vitest from loading the full packages during testing, which caused heap out-of-memory crashes.

- **`ISupabaseClientProps`** covers `from()` (direct queries) and `rpc()` (function calls)
- **`IOpenAIClientProps`** covers `embeddings.create()`
- Both defined once in `document-classification.ts`, imported by all other files
- `rpc()` returns `PromiseLike` (not `Promise`) because Supabase's `PostgrestFilterBuilder` is thenable but not a strict Promise
- The real Supabase/OpenAI clients (created in `mcp-server.ts`) satisfy these interfaces via TypeScript's structural typing

**Future improvement:** Run `supabase gen types typescript` to generate full database types. Use `SupabaseClient<Database>` in `mcp-server.ts` for full autocomplete. Library files keep structural types for Vitest compatibility.

---

## Testing Strategy

### Database tests (pgTAP)
- Test all 15 Postgres functions directly
- Test CHECK constraints reject invalid values
- Test FK cascades work
- Test soft delete + restore cycle
- File: `tests/sql/001-document-functions.sql` (20 tests)

### TypeScript unit tests (Vitest)

| Test file | Tests | What it covers |
|-----------|-------|----------------|
| `tests/document-classification.test.ts` | 8 | Type shapes compile, interface field verification |
| `tests/embeddings.test.ts` | 15 | contentHash, toVectorString, parseVector, chunkText (paragraph, force-split, overlap) |
| `tests/document-fetching.test.ts` | 14 | Mock Supabase client, all 4 query functions, filter logic, soft-delete filtering |
| `tests/document-operations.test.ts` | 1 | Module exports verification |
| `tests/ai-search.test.ts` | 2 | Module exports verification |
| `tests/mcp-server.test.ts` | 4 | All 16 tools registered, deprecation notices, protection checks |

**Total: 44 TypeScript tests**

### E2E verification (live database)
- Full MCP tool flow verified: add → search (semantic + keyword) → update content → update fields → delete → verify gone
- Query cache round-trip verified: embed → cache → parseVector → search
- Protection checks verified: immutable blocks, guarded/protected require confirmation
