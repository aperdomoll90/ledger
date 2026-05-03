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
└── mcp-server.ts       → MCP server (18 tools, including the `_from_file` write variants)
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

## Write Protocol

**All writes go through a file on disk.** Bytes flow file -> `updateDocument()` / `createDocument()` pipeline without retyping or string composition. Auto-verify (pull-back + byte-compare) is built into the write path; if drift slips in, the helper aborts with `VerifyMismatchError` carrying a line/col diff preview rather than succeeding silently.

This eliminates two failure modes that bit us before: ARG_MAX (CLI argv ceiling at ~128 KB on Linux) and composed-string drift (silent mutation of doc content during MCP `update_document(content=...)` calls).

### Editing an existing doc

```bash
mkdir -p /tmp/ledger-edit
ledger get <name> > /tmp/ledger-edit/<name>.md
# edit /tmp/ledger-edit/<name>.md with your editor or the Edit tool
ledger update <id> -f /tmp/ledger-edit/<name>.md --yes   # CLI
# or MCP: update_document_from_file(id=<id>, path="/tmp/ledger-edit/<name>.md")
rm /tmp/ledger-edit/<name>.md   # cleanup on success
```

### Creating a new doc

```bash
# compose in ~/.ledger/drafts/<name>.md (durable across sessions)
ledger add -f ~/.ledger/drafts/<name>.md -n <name> -d <domain> -t <type> -p <project>   # CLI
# or MCP: add_document_from_file(path="~/.ledger/drafts/<name>.md", domain=..., document_type=..., name=..., ...)
rm ~/.ledger/drafts/<name>.md   # cleanup on success
```

### Implementation surface

- Library helpers: `updateDocumentFromFile()` and `createDocumentFromFile()` in `src/lib/documents/operations.ts`. Both read the file, push via the existing `updateDocument()` / `createDocument()` pipeline, then call `verifyAfterWrite()` to pull the doc back and byte-compare against what we sent. Mismatches throw `VerifyMismatchError`.
- CLI: `-f <file>` flag on `ledger update <id>` and `ledger add`. Mutually exclusive with `-c`. `--yes` on `update -f` skips the interactive confirm prompt for non-interactive scripts.
- MCP: `mcp__ledger__update_document_from_file` and `mcp__ledger__add_document_from_file`. Path must be inside the FS-access allowlist (defaults: `~/.ledger/`, `~/repos/`, `/tmp/ledger-edit/`; override via env var `LEDGER_MCP_FILE_ACCESS_ALLOWLIST`).
- Folder conventions:
  - `~/.ledger/drafts/` durable in-progress new docs (will be pushed)
  - `~/.ledger/transient/` pre-implementation specs / plans / research (LOCAL ONLY, never pushed)
  - `/tmp/ledger-edit/` transient pull-edit-push for existing docs

### Deprecated paths

The composed-string write paths still exist but are scheduled for removal in Phase 4 of the file-based-write-api rollout:

- CLI: `ledger update -c <body>`, `ledger add -c <body>`. Break at ~128 KB (ARG_MAX).
- MCP: `mcp__ledger__update_document(id, content)`, `mcp__ledger__add_document(content, ...)`. Drift-prone (the agent retypes the doc body into a JSON parameter; any silent mutation slips through).

Do not use these for new code. Migrate any existing call sites to the `_from_file` variants.
