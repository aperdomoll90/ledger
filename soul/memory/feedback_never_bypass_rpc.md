---
name: Never bypass document RPC functions
description: Always use document_update/document_create RPC — never direct .update() on documents table. Direct updates skip chunking, hashing, and audit.
type: feedback
originSessionId: a26d5284-835f-4a3c-9916-031a1a007742
---
NEVER use `supabase.from('documents').update()` directly. Always use `updateDocument()` or `createDocument()` which call the Postgres RPC functions.

**Why:** Direct table updates skip: re-chunking, re-embedding, content hashing, audit log entry. The document content updates but the search index (chunks) becomes stale, the hash is wrong, and there's no audit trail. This happened in Session 30 with documents #109 and #144 — had to fix both afterward.

**How to apply:** Use `updateDocumentFromFile()` / `createDocumentFromFile()` from `document-operations.ts` (or the equivalent CLI/MCP surfaces: `ledger update -f <file>`, `ledger add -f <file>`, `mcp__ledger__update_document_from_file`, `mcp__ledger__add_document_from_file`). They wrap the underlying `updateDocument()` / `createDocument()` RPC pipeline with auto-verify (pull-back + byte-compare). The composed-string MCP tools and `-c` CLI flags were removed in Phase 4 of the file-based-write-api rollout (2026-05-02), so the previous "use updateDocument() via a script" workaround no longer applies; the file-based variants are now the only sanctioned path.
