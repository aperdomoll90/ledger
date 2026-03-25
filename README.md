# @aperdomoll90/ledger-ai

Your AI, everywhere. One identity, one memory, every device.

Ledger stores who you are, how you work, and what you know in a single knowledge base. Connect any AI agent — Claude, OpenClaw, ChatGPT — and it immediately knows your rules, preferences, and context. Switch devices and pick up where you left off.

## Install

```bash
npm install -g @aperdomoll90/ledger-ai
```

Requires Node.js 20+.

## Quick Start

```bash
# One command does everything:
ledger init
```

The init wizard walks you through:
1. **Credentials** — Supabase + OpenAI keys
2. **Database** — connect and set up schema
3. **Device** — name this machine (optional)
4. **Persona** — profile, communication style, rules
5. **Platforms** — install Claude Code, OpenClaw, or ChatGPT
6. **Sync** — pull everything down
7. **Migrate** — detect stray local files

Smart step-skipping — re-run anytime, it only does what's needed.

### Second device? Same Ledger, same persona:

```bash
npm install -g @aperdomoll90/ledger-ai
ledger init    # connect to existing Supabase, pull persona, set up platform
```

## What It Does

**For you:** Define who you are, how you want AI to behave, your coding conventions, communication style. Do it once. Every AI agent on every device follows the same rules.

**For your agents:** A full RAG (Retrieval-Augmented Generation) system. Notes are embedded with OpenAI and stored in Postgres with pgvector. Agents find relevant context by semantic meaning, not keywords. Retrieved context is injected into agent prompts automatically via MCP.

**For your workflow:** Automatic sync at session start, conflict detection, session-end checks. Hooks enforce rules (block credential file access, auto-ingest notes to Ledger).

## Commands

| Command | Description |
|---|---|
| `ledger init` | Guided setup wizard (credentials, persona, platforms, sync) |
| `ledger setup <platform>` | Configure an agent (claude-code, openclaw, chatgpt) |
| `ledger onboard` | Create your persona (interactive questionnaire) |
| `ledger sync` | Bidirectional sync between Ledger and local cache |
| `ledger pull` | Download notes from Ledger to local cache |
| `ledger push <file>` | Upload a local file to Ledger |
| `ledger check` | Compare local files vs Ledger (dry-run sync) |
| `ledger show <query>` | Search by meaning, open matching note |
| `ledger export <query>` | Download a note to any path (untracked) |
| `ledger ingest [file]` | Add files to Ledger with duplicate detection |
| `ledger migrate` | Migrate local files to Ledger (backup, compare, merge) |
| `ledger add` | Add a new note (interactive metadata prompts) |
| `ledger update <id>` | Update a note by ID |
| `ledger delete <id>` | Delete a note by ID |
| `ledger list` | List recent notes |
| `ledger tag <id>` | Update metadata on a note |
| `ledger backup` | Backup all notes to ~/.ledger/backups/ |
| `ledger restore <file>` | Restore from backup |
| `ledger config list` | View settings |

## Note Metadata

Every note has structured metadata for organization and discovery:

| Field | Purpose | Example |
|---|---|---|
| `type` | Categorization | `feedback`, `user-preference`, `architecture-decision`, `reference` |
| `upsert_key` | Unique identifier, dedup | `feedback-communication-style`, `ledger-spec-init` |
| `description` | What the note IS and what it's FOR | `"How to communicate with Adrian"` |
| `status` | Lifecycle stage | `idea`, `planning`, `active`, `done` |
| `project` | Which project | `ledger`, `ai-studio` |
| `delivery` | Sync tier | `persona` (everywhere), `project` (per-repo), `knowledge` (search only) |

### Interactive prompting

When creating notes, Ledger prompts for missing metadata by default — both via MCP (agents) and CLI. This helps keep notes organized without requiring users to memorize the schema.

Skip prompts with `--force` (CLI) or `interactive_skip: true` (MCP). Disable globally: `ledger config set naming.interactive false`.

### Naming enforcement (opt-in)

Enable strict naming validation: `ledger config set naming.enforce true`

Keys follow the pattern `{prefix}-{topic}` or `{project}-{prefix}-{topic}`:
- `feedback-communication-style`
- `ledger-spec-init`
- `user-profile`

## Stack

- **Database:** Supabase (hosted Postgres + pgvector) — free tier
- **Embeddings:** OpenAI `text-embedding-3-small`
- **Protocol:** MCP (Model Context Protocol) for Claude Code
- **CLI:** Commander, TypeScript, ES modules
- **Sync:** SHA-256 content hashing, conflict detection

## How It Works

```
Your devices / agents
    |
    v
ledger CLI ←→ Supabase (Postgres + pgvector)
    |
    ├── init: guided wizard (credentials → persona → platforms → sync)
    ├── sync: bidirectional, hash-based conflict detection
    ├── show: semantic search → open in editor
    ├── add: interactive metadata prompts → duplicate guard → save
    └── MCP server: Claude Code talks to Ledger natively (6 tools)
```

Notes are stored with content + metadata + vector embeddings. Search finds relevant notes by meaning. Sync uses SHA-256 content hashes to detect changes without markers.

## Platforms

| Platform | Connection | Sync |
|---|---|---|
| Claude Code | MCP (live) + hooks | Bidirectional, automatic |
| OpenClaw | CLI | Bidirectional via `ledger` commands |
| ChatGPT | None | Static snapshot, re-run to update |

Platform management is built into the wizard — install, reinstall, or uninstall from `ledger init`.

## Development

```bash
npm run ship       # typecheck → test → commit → push
npm run release    # version bump → build → test → publish to npm
```

## Requirements

- Node.js 20+
- Supabase project (free tier works)
- OpenAI API key (for embeddings, ~$0.02/1M tokens)

## Known Limitations

- **Embeddings require OpenAI** — currently uses `text-embedding-3-small` only. Multi-provider support planned.
- **Anthropic has no embedding API** — Claude is for text generation. Even Claude users need an OpenAI key for embeddings.
- **English-optimized** — semantic search works best with English content.

## Roadmap

### RAG Enhancements
- Hybrid search (vector + BM25 keyword via PostgreSQL full-text search)
- Re-ranking — score retrieved chunks before feeding to LLM
- Chunking strategies for large documents (auto-split on ingest)
- Multi-format ingest (PDF, Excel, images, audio)
- Multi-provider embeddings (Supabase built-in, OpenAI, Ollama, Cohere)

### Platform
- Note versioning / history
- Soft delete (trash)
- Web dashboard
- Skills system (context-aware convention enforcement)
- VS Code extension

## License

ISC
