# Ledger

## What Is This

AI identity and memory system. MCP server + CLI for syncing agent memory across devices. **Supabase** (Postgres + **pgvector**) for semantic search, **OpenAI embeddings** for RAG.

**Package:** @aperdomoll90/ledger-ai | **Command:** ledger
**Stack:** Node.js | TypeScript (strict) | Supabase | pgvector | OpenAI | MCP | Commander

## Project Structure

```
src/
├── cli.ts              → Entry point (commander)
├── commands/           → 13 commands (init, setup, onboard, pull, push, check, show, export, ingest, backup, restore, config)
├── lib/                → config, hash, notes, generators, errors, prompt, migrate
├── hooks/              → block-env.sh, post-write-ledger.sh, session-end-check.sh
├── migrations/         → 000-tracking, 001-schema, 002-functions, 003-rls
└── mcp-server.ts       → MCP server (5 tools)
```

## Documentation

- `docs/devlog.md` — session record (git only)
- All architecture, design specs, and guides live in **Ledger** — search by project: ledger

## Conventions

- All knowledge lives in Ledger, not in local files
- Update `docs/devlog.md` every session
- All secrets in `.env`, never in code or docs
- `stdout` for machine-readable data, `stderr` for status messages
- Typed errors with meaningful exit codes (see `lib/errors.ts`)
- Separation of concerns: commands/ for CLI actions, lib/ for shared logic
