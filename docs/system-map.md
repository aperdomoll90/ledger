# Ledger System — Component Map

> Last updated: 2026-03-16 (v2)

## 1. Database Layer (Supabase)
Postgres + pgvector, hosted on Supabase free tier.

| Component | Status | Needs for NPM |
|---|---|---|
| `notes` table + schema | Manual SQL | Migration script |
| HNSW index | Manual SQL | Migration script |
| `match_notes` RPC | Manual SQL | Migration script |
| RLS policies | Manual SQL | Migration script |
| Edge Function (capture) | Deployed via CLI | Deploy script |

## 2. MCP Server (`src/mcp-server.ts`)
5 tools: add_note, update_note, search_notes, list_notes, delete_note.
Auto-chunking, upsert, embedding generation, content_hash on every write.

| Component | Status | Needs for NPM |
|---|---|---|
| MCP server code | Working, compiled to JS | Ready |
| content_hash on add/update | Working (v2) | Ready |
| Registration in Claude Code | Manual `claude mcp add` | `ledger init` |
| .env credentials | Manual setup | `ledger init` with prompt |

## 3. CLI Tool (`src/cli.ts` + `commands/` + `lib/`)
6 commands, modular structure, commander framework, typed errors, configurable paths.

| Command | Status | Description |
|---|---|---|
| pull | Working (v2) | Hash-aware conflict detection, stores hashes |
| push | Working (v2) | Updates hash after push |
| check | Working (v2) | Computes state from SHA-256 hashes, queries Ledger |
| show | Working | Semantic search, opens in VS Code |
| export | Working (v2, new) | Untracked download to any path |
| ingest | Working (v2, new) | Duplicate detection (hash + embedding), interactive + auto mode |

## 4. Sync System (v2 — Hash-Based)
Content hash (SHA-256) stored in Ledger note metadata. State computed by comparison.

| State | Detection | Action |
|---|---|---|
| Clean | Local hash = stored hash, Ledger unchanged | Skip |
| Modified locally | Local hash ≠ stored hash, Ledger unchanged | "Push?" |
| Updated upstream | Local hash = stored hash, Ledger changed | "Pull?" |
| Conflict | Both changed | Show both, user decides |
| Unknown | No hash stored | Ingest flow |
| Deleted locally | Hash exists, file missing | "Re-pull or remove?" |

## 5. Hooks (`~/.claude/hooks/`)
Bash scripts, no LLM calls, run locally.

| Hook | Event | Action |
|---|---|---|
| block-env.sh | PreToolUse:Read,Edit,Write | Blocks .env access (exit 2) |
| post-write-ledger.sh | PostToolUse:Edit,Write | Auto-ingests memory/ writes to Ledger, deletes local |
| session-end-check.sh | Stop | Runs `ledger-sync check`, reports issues |

SessionStart: `ledger-sync pull --quiet` (in settings.json, not a hook file)

## 6. Generated Files
| File | Generated from | Purpose |
|---|---|---|
| ~/CLAUDE.md | Feedback notes + section mapping | Behavioral rules for agent |
| MEMORY.md | List of local_cache files | Index for auto-loading |
| memory/*.md | Notes with local_cache: true | Local cache for instant context |

## 7. Enforcement Summary

### Code-enforced (v2)
- Hash comparison for sync state
- Conflict detection in pull/push
- Write interception (auto-ingest to Ledger)
- MCP stores content_hash on every write
- block-env.sh prevents credential exposure

### Prompt rules (agent behavior only)
- Communication style
- Coding conventions
- Prefer CLI & skills
- Reusable tool mindset
- Watch for `claude -p` opportunities

## NPM Readiness Summary

**Ready to package:**
- MCP server code (with content_hash)
- CLI (6 commands, modular, commander)
- Hook scripts
- Hash-based sync
- CLAUDE.md / MEMORY.md generation

**Needs automation (`ledger init`):**
- Supabase schema creation (SQL migrations)
- MCP registration
- Hook installation
- Credential prompting and storage
- Edge Function deployment

**Needs building:**
- `ledger init` — automated setup wizard
- `ledger onboard` — persona wizard for new users
- `ledger migrate` — import existing .md files with dedup
- `ledger export` (JSON backup) — full database dump
- Filtered search (by type, project, date)
- Note versioning/history
- Soft delete (trash)
- Multi-format ingest (PDF, Excel, etc.)
- Web dashboard
- VS Code extension
