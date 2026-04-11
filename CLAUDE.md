# Ledger

## What Is This

AI identity and memory system. MCP server + CLI for syncing agent memory across devices. **Supabase** (Postgres + **pgvector**) for semantic search, **OpenAI embeddings** for RAG.

**Package:** @aperdomoll90/ledger-ai | **Command:** ledger
**Stack:** Node.js | TypeScript (strict) | Supabase | pgvector | OpenAI | MCP | Commander

**Design philosophy:** Ledger is designed as a production-grade system, not a personal tool. All architecture decisions, thresholds, caching strategies, and error handling must assume scale (thousands of documents, high query volume, multiple concurrent users). Never optimize for current corpus size or usage patterns. Build for the system it will become, not what it is today.

## Project Structure

```
src/
├── cli.ts              → Entry point (commander)
├── commands/           → add, backup, check, delete, eval, export, init, lint, list, push, restore, show, tag, update (16 commands incl. eval:sweep)
├── lib/                → config, hash, notes, domains, audit, backfill, file-writer, errors, prompt
├── hooks/              → block-env.sh, post-write-ledger.sh, session-end-check.sh
├── migrations/         → 000-tracking, 001-schema, 002-functions, 003-rls, 004-upsert-key-unique, 005-audit-log
└── mcp-server.ts       → MCP server (6 tools)
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
