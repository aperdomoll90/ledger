# Ledger — Architecture

## Overview

Centralized knowledge base and AI identity system. Two jobs:
1. **Self-management** — sync, storage, hash-based state tracking, conflict detection
2. **Persona management** — portable preferences, rules, conventions across devices/systems

Uses Postgres + pgvector for semantic search (RAG). Hosted on Supabase.

## System Diagram

```
Agents (Claude Code, ZhuLi, etc.)
    |
    v
MCP Server (Node.js — src/mcp-server.ts)
    |  read, write, semantic search
    v
Supabase (hosted Postgres + pgvector)
    |
    ├── notes table (content + metadata jsonb + embedding vector(1536))
    ├── HNSW vector index (cosine distance)
    ├── match_notes RPC (cosine similarity search)
    └── Edge Functions (capture endpoint)
```

## Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Runtime | Node.js (ES modules, TypeScript strict) | MCP server + CLI host |
| Database | Supabase (hosted Postgres) | Storage, hosting, dashboard |
| Vector search | pgvector extension | Similarity search on embeddings |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dimensions |
| Protocol | MCP (Model Context Protocol) | Standard agent-tool interface |
| CLI framework | Commander | Argument parsing, help text, validation |
| Capture | Supabase Edge Function (Deno) | HTTP endpoint for non-MCP ingestion |
| Hashing | SHA-256 (Node crypto) | Content change detection for sync |
| Security | Row Level Security (RLS) | Tables locked by default |

## Project Structure

```
src/
├── cli.ts              → Entry point, commander setup
├── commands/
│   ├── pull.ts         → Download notes from Ledger to local cache
│   ├── push.ts         → Upload local file to Ledger
│   ├── check.ts        → Compare local files vs Ledger
│   └── show.ts         → Semantic search, open matching note
├── lib/
│   ├── config.ts       → Paths, env, Supabase/OpenAI clients
│   ├── hash.ts         → SHA-256 content hashing
│   ├── notes.ts        → Fetch/query notes from Supabase
│   ├── markers.ts      → Marker helpers (transitional, replaced by hashes in v2)
│   ├── generators.ts   → CLAUDE.md and MEMORY.md generation
│   └── errors.ts       → Typed error classes and exit codes
└── mcp-server.ts       → MCP server with 5 tools
```

## Design Principles

1. **Code enforcement over prompt rules** — system behavior lives in code, not agent memory
2. **Never assume, always ask** — every data-modifying action requires user confirmation
3. **Token/context conservation** — confirmations happen in bash, not through the agent
4. **Redirect, not block** — intercept incorrect writes and funnel to Ledger
5. **Single source of truth** — all knowledge in Ledger, local files are cache
6. **Client-agnostic** — works from Claude Code, scripts, cron, any future client

## Database Schema

### `notes` table
| Column | Type | Purpose |
|--------|------|---------|
| `id` | serial | Primary key |
| `content` | text | The note text |
| `metadata` | jsonb | Flexible key-value (type, agent, project, upsert_key, local_file, content_hash, chunk_group, etc.) |
| `embedding` | vector(1536) | OpenAI embedding for semantic search |
| `created_at` | timestamptz | Auto-set on insert |
| `updated_at` | timestamptz | Auto-set on update |

### `match_notes` RPC
Cosine similarity search. Takes query embedding + threshold + limit, returns matching notes ranked by similarity.

## MCP Tools (5)

| Tool | Purpose |
|------|---------|
| `add_note` | Save note with auto-chunking (>25k chars). Supports upsert via `upsert_key`. |
| `update_note` | Update by ID. Re-embeds. Handles chunk groups. |
| `search_notes` | Semantic similarity search. Reassembles chunked notes. |
| `list_notes` | List recent notes (truncated preview). |
| `delete_note` | Delete by ID. Removes all chunks if part of group. |

### Chunking
- Notes >25,000 chars split on paragraph boundaries (double newlines)
- 2,000 char overlap between chunks
- Each chunk embedded independently
- Chunks share `chunk_group` UUID with `chunk_index` and `total_chunks`
- Search reassembles all siblings when any chunk matches

### Upsert
Include `upsert_key` in metadata for idempotent writes. Existing note with that key gets replaced.

## CLI Commands

```bash
ledger-sync pull [--quiet] [--force]   # Download from Ledger → local cache
ledger-sync push <file>                # Upload local file → Ledger
ledger-sync check                      # Compare local vs Ledger
ledger-sync show <query>               # Semantic search, open note
```

### Output convention
- `stdout` — machine-readable data (sync status summary, file paths)
- `stderr` — human-readable status messages (progress, per-file details)

### Generated files
- `memory/*.md` — cache files from notes with `local_cache: true`
- `MEMORY.md` — generated index of cache files
- `CLAUDE.md` — compiled from feedback notes (persona rules)

### Configuration
Paths resolved in order: environment variable → `~/.ledger/config.json` → defaults.

| Setting | Env var | Config key | Default |
|---------|---------|-----------|---------|
| Memory directory | `LEDGER_MEMORY_DIR` | `memoryDir` | `~/.claude/projects/-home-adrian/memory` |
| CLAUDE.md path | `LEDGER_CLAUDE_MD_PATH` | `claudeMdPath` | `~/CLAUDE.md` |
| Dotenv path | `DOTENV_CONFIG_PATH` | — | `~/repos/ledger/.env` |

## Error Handling

| Exit code | Meaning |
|-----------|---------|
| 0 | Success |
| 1 | General error |
| 2 | File not found |
| 3 | Note not found in Ledger |
| 4 | Supabase error |
| 5 | Embedding error |
| 6 | Conflict |
| 7 | Invalid input |

## Capture Edge Function

HTTP POST endpoint for non-MCP ingestion (webhooks, scripts, mobile).

```
POST https://<project-ref>.supabase.co/functions/v1/capture
Headers: Content-Type: application/json, Authorization: Bearer <ANON_KEY>
Body: { "content": "string", "metadata": { ... } }
```

## Key Decisions

| Decision | Why |
|----------|-----|
| Supabase over self-hosted Postgres | Free tier sufficient, dashboard for browsing |
| OpenAI embeddings over local model | Tiny cost, higher quality |
| MCP as interface | Standard protocol for all agents |
| Commander for CLI | Industry standard, auto-generates help, validates args |
| SHA-256 for hashing | Built into Node, collision-resistant, industry standard |
| Separate commands/ and lib/ | Separation of concerns, each file has one job |
| stderr for status, stdout for data | Unix convention, enables piping |
| ES modules + TypeScript strict | Modern Node.js, type safety |

## Cost

- Supabase free tier: $0/mo
- OpenAI embeddings: ~$0.02 per 1M tokens
- Estimated monthly: $0.10 — $0.30
