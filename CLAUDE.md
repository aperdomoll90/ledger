# Ledger

## What Is This

A centralized knowledge base and AI identity system. MCP server + CLI for syncing agent memory across devices. **Supabase** (Postgres + **pgvector**) for semantic search, **OpenAI embeddings** for RAG.

**Stack:** Node.js | TypeScript (strict) | Supabase | pgvector | OpenAI | MCP | Commander

## Project Structure

```
src/
├── cli.ts              → Entry point (commander)
├── commands/           → pull, push, check, show
├── lib/                → config, hash, notes, markers, generators, errors
└── mcp-server.ts       → MCP server (5 tools)
```

## Documentation

- `docs/ARCHITECTURE.md` — system design, schema, decisions, CLI reference
- `docs/IMPLEMENTATION.md` — setup from scratch
- `docs/devlog.md` — session record

## Current Status

**v2 in progress.** Refactored to modular structure. Building hash-based sync to replace marker system.

## Conventions

- Update `docs/devlog.md` every session
- Document decisions in `docs/ARCHITECTURE.md`
- All secrets in `.env`, never in code or docs
- `stdout` for machine-readable data, `stderr` for status messages
- Typed errors with meaningful exit codes (see `lib/errors.ts`)
- Separation of concerns: commands/ for CLI actions, lib/ for shared logic
