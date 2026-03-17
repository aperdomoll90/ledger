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
# 1. Set up credentials and database
ledger init

# 2. Connect your AI agent
ledger setup claude    # Claude Code (live sync, MCP, hooks)
ledger setup openclaw  # OpenClaw (persona files, CLI sync)
ledger setup chatgpt   # ChatGPT (static system prompt export)

# 3. Create your persona
ledger onboard
```

Second device? Same Ledger, same persona:

```bash
npm install -g @aperdomoll90/ledger-ai
ledger init            # connect to existing Supabase project
ledger setup claude    # pull persona, install hooks
```

## What It Does

**For you:** Define who you are, how you want AI to behave, your coding conventions, communication style. Do it once. Every AI agent on every device follows the same rules.

**For your agents:** Semantic search over your knowledge base. Notes are embedded with OpenAI and stored in Postgres with pgvector. Agents find relevant context by meaning, not keywords.

**For your workflow:** Automatic sync at session start, conflict detection, session-end checks. Hooks enforce rules (block credential file access, auto-ingest notes to Ledger).

## Commands

| Command | Description |
|---|---|
| `ledger init` | Set up credentials and database schema |
| `ledger setup <platform>` | Configure an agent (claude, openclaw, chatgpt) |
| `ledger onboard` | Create your persona (interactive wizard) |
| `ledger pull` | Download notes from Ledger to local cache |
| `ledger push <file>` | Upload a local file to Ledger |
| `ledger check` | Compare local files vs Ledger |
| `ledger show <query>` | Search by meaning, open matching note |
| `ledger export <query>` | Download a note to any path (untracked) |
| `ledger ingest [file]` | Add files to Ledger with duplicate detection |
| `ledger backup` | Backup all notes to ~/.ledger/backups/ |
| `ledger restore <file>` | Restore from backup |
| `ledger config list` | View settings |
| `ledger config set <key> <value>` | Change settings |

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
    ├── pull: download notes → local cache files + CLAUDE.md
    ├── push: upload local changes → Ledger (re-embeds)
    ├── check: compare hashes, detect drift
    ├── show: semantic search → open in editor
    └── MCP server: Claude Code talks to Ledger natively
```

Notes are stored with content + metadata + vector embeddings. Search finds relevant notes by meaning. Sync uses SHA-256 content hashes to detect changes without markers.

## Platforms

| Platform | Connection | Sync |
|---|---|---|
| Claude Code | MCP (live) + hooks | Bidirectional, automatic |
| OpenClaw | CLI | Bidirectional via `ledger` commands |
| ChatGPT | None | Static snapshot, re-run to update |

## Requirements

- Node.js 20+
- Supabase project (free tier works)
- OpenAI API key (for embeddings, ~$0.02/1M tokens)

## Known Limitations

- **Embeddings require OpenAI** — currently uses `text-embedding-3-small` only. Supabase built-in embeddings (free, no API key) and multi-provider support planned for v2.0.
- **Anthropic has no embedding API** — Claude is for text generation. Even Claude users need an OpenAI key for embeddings.
- **English-optimized** — semantic search works best with English content. Multilingual support depends on the embedding model.

## Roadmap

- Multi-provider embeddings (Supabase built-in, OpenAI, others)
- Note versioning / history
- Soft delete (trash)
- Multi-format ingest (PDF, Excel, images, audio)
- Web dashboard
- VS Code extension

## License

ISC
