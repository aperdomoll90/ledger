# Ledger v2 TypeScript Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript client from scratch that calls the Postgres database we created. Start with the simplest working piece, test it, then build up.

**Architecture:** 5 library files. Each file is a thin client that calls Postgres functions or queries. The database handles all business logic (transactions, audit, versioning, constraints). TypeScript's job: prepare data, call the right function, return the response.

**Tech Stack:** TypeScript (strict), Supabase client, OpenAI (embeddings), Vitest (tests)

**Source of truth:** The database schema at `docs/superpowers/specs/2026-03-29-schema-rewrite.md`

**Rule:** Each task creates one file, tests it, and verifies it works BEFORE moving to the next. No task references old code.

---

## Build Order

We build bottom-up — files with no dependencies first, then files that import from them:

```
1. document-classification.ts  — pure types, no imports
2. embeddings.ts               — imports from document-classification
3. document-fetching.ts        — imports from document-classification
4. document-operations.ts      — imports from document-classification, embeddings
5. ai-search.ts                — imports from document-classification, embeddings
6. mcp-server.ts               — imports from all above
7. cleanup + migration          — delete old files, migrate data
8. end-to-end verification      — test everything together
```

---

## Task 1: Types and Interfaces

**Create:** `src/lib/document-classification.ts`
**Test:** `tests/document-classification.test.ts`
**What:** Define all the TypeScript types that match the database columns. Pure data — no logic, no I/O, no imports from other project files.
**Why:** Every other file imports types from here. It must exist first.
**How:** Read the `documents` table columns, create an interface with one field per column. Use string unions for columns that have CHECK constraints.

---

## Task 2: Embeddings

**Create:** `src/lib/embeddings.ts`
**Test:** `tests/embeddings.test.ts`
**What:** Three things the database can't do: (1) call OpenAI to generate embeddings, (2) split text into chunks, (3) format embeddings as Postgres vector strings.
**Why:** The `document_create` and `document_update` Postgres functions expect chunk text arrays and embedding arrays. TypeScript must prepare these before calling the functions.
**How:** Call OpenAI API for embeddings. Split text on paragraph boundaries for chunks. Format `number[]` as `[0.1,0.2,...]` string for Postgres.

---

## Task 3: Document Fetching

**Create:** `src/lib/document-fetching.ts`
**Test:** `tests/document-fetching.test.ts`
**What:** Read documents from the `documents` table. Get by ID, get by name, list with filters.
**Why:** The MCP `list_documents` tool and other tools need to fetch documents. Also needed by `document-operations.ts` to check if a document exists before updating/deleting.
**How:** Direct Supabase `SELECT` queries on the `documents` table with `deleted_at IS NULL` filter.

---

## Task 4: Document Operations

**Create:** `src/lib/document-operations.ts`
**Test:** `tests/document-operations.test.ts`
**What:** Write operations — create, update content, update fields, delete, restore. Each one prepares data and calls a Postgres RPC function.
**Why:** The MCP `add_document`, `update_document`, `delete_document` tools need these.
**How:** For create/update: chunk text, generate embeddings, hash content, then call `document_create` or `document_update` RPC. For fields/delete/restore: just call the RPC directly.

---

## Task 5: AI Search

**Create:** `src/lib/ai-search.ts`
**Test:** `tests/ai-search.test.ts`
**What:** Search operations — call the Postgres search functions. Three modes: vector (by meaning), keyword (by exact words), hybrid (both combined).
**Why:** The MCP `search_documents` tool needs this. This is the core RAG retrieval.
**How:** Generate embedding for the query, then call `match_documents`, `match_documents_keyword`, or `match_documents_hybrid` RPC.

---

## Task 6: MCP Server — COMPLETE

**Created:** `src/mcp-server.ts`
**Test:** `tests/mcp-server.test.ts`
**What:** 16 MCP tools (10 new + 6 deprecated). Each tool: Zod validation → protection check → library call → text response.
**Tools added:**
- 6 core: `search_documents`, `add_document`, `list_documents`, `update_document`, `update_document_fields`, `delete_document`
- 4 additional: `restore_document`, `search_by_meaning`, `search_by_keyword`, `get_document_context`
- 6 deprecated: `search_notes`, `add_note`, `list_notes`, `update_note`, `update_metadata`, `delete_note`

**Bugs found and fixed during E2E testing:**
- `parseVector()` — Postgres returns vector columns as strings; added helper to parse back to `number[]`
- Search threshold — lowered default from 0.5 to 0.25 (industry standard for `text-embedding-3-small`; threshold gates vector cosine similarity pre-fusion, not RRF score)

---

## Task 7: Cleanup + Migration

**Create:** `src/scripts/migrate-v2.ts`
**What:** Migrate ~130 notes from old `notes` table to new `documents` table via `document_create` RPC.

### Migration script steps

1. Read all rows from `notes` table
2. Group chunked notes by `metadata.chunk_group`, reassemble content (ordered by `chunk_index`)
3. For each unique document, map old fields to `ICreateDocumentProps`:
   - `metadata.upsert_key` → `name` (fallback: `note-{id}`)
   - `metadata.domain` → `domain` (fallback: `general`)
   - `metadata.type` → `document_type` (fallback: `reference`)
   - Reassembled `content` → `content`
   - All other metadata fields map 1:1 to columns
4. Call `createDocument()` for each — chunks, embeds, stores via RPC
5. Log: old id(s) → new id, success/failure for each
6. Print summary: total migrated, failed, skipped

### Verification after migration

- Count: documents table count matches unique notes (after chunk reassembly)
- Search: `search_documents` finds known content
- Spot-check: compare 5 random documents old vs new
- After verification: `DROP TABLE notes CASCADE` (separate step, manual)

### Cost

~130 documents × ~1-3 chunks = ~200-400 OpenAI embedding calls ≈ $0.02

### Approach decision

Using `document_create` RPC (not direct INSERT) because:
- Same code path as normal operation — tests the real system
- Gets chunking + embedding + audit for free
- Tradeoff: loses original `created_at` (acceptable — timestamps are in audit trail)

---

## Task 8: End-to-End Verification — PARTIALLY COMPLETE

**What:** Verify everything works together — MCP server starts, search returns results, create/update/delete work.
**Done:** Full tool cycle verified (add → search semantic/keyword → update content → update fields → delete → verify gone). Query cache round-trip verified. Protection check logic verified.
**Remaining:** Re-verify after migration (Task 7) populates the database with real data.

---

## Follow-up Tasks

### Supabase Generated Types
**When:** After Tasks 7-8 are complete.
**What:** Run `npx supabase gen types typescript --project-id <id> > src/lib/database.types.ts`. Use `createClient<Database>(...)` in `mcp-server.ts` for full autocomplete. Library files keep structural types for Vitest compatibility.

### Onboarding Tool Guide
**When:** After migration is complete.
**What:** Update `ledger onboard` to generate a Ledger tools block for CLAUDE.md/AGENTS.md so new users' agents know which tools to use and when.
