# ledger-sync CLI — Design Spec

> Date: 2026-03-14 (updated 2026-03-15)
> Status: Approved + v2 (conflict detection, check command, hooks)

## Purpose

A CLI tool that syncs knowledge between Ledger (Supabase) and local cache files. Ensures behavioral uniformity across all agents and machines.

## Commands

### `ledger-sync pull`

Downloads cached notes from Ledger and generates local files. Detects local changes and skips conflicting files.

**Outputs:**

| File | Generated from |
|---|---|
| `~/CLAUDE.md` | Compiled from feedback notes |
| `~/.claude/projects/-home-adrian/memory/MEMORY.md` | Generated index linking to cache files |
| `~/.claude/projects/-home-adrian/memory/*.md` | One file per note with `local_cache: true` in metadata |

**Process:**
1. Connect to Supabase using env vars
2. Query all notes where metadata contains `local_cache: true`
3. Also query all `feedback` and `user-preference` type notes (for CLAUDE.md)
4. For each note with `local_file`:
   - If local file doesn't exist → write it
   - If local file exists and matches Ledger content → skip (up to date)
   - If local file exists but differs from Ledger → **skip and flag as CONFLICT**
5. Generate MEMORY.md index
6. Generate ~/CLAUDE.md from feedback notes
7. Report results

**Conflict output format:**
```
CONFLICT:feedback_coding_conventions.md
CONFLICT:project_status.md
```

This structured format is parsed by the SessionStart hook and surfaced to the agent for resolution.

**Flags:**
- `--quiet` — no output unless conflicts or errors
- `--force` — overwrite all files, ignore local changes

### `ledger-sync push <file>`

Uploads a local cache file back to Ledger, updating the matching note and re-generating its embedding.

**Process:**
1. Read the specified local file
2. Find matching Ledger note by `local_file` metadata field
3. If found, update content + re-generate embedding via OpenAI
4. If not found, error — must exist in Ledger first
5. Report success

### `ledger-sync check`

Compares all local cache files against Ledger and reports what's out of sync. Used at session end to catch forgotten pushes.

**Process:**
1. Query all notes with `local_cache: true`
2. For each, compare local file content with Ledger note content
3. Report status per file:
   - `in sync` — contents match
   - `local changes` — local file differs, needs push
   - `missing locally` — Ledger has it, local doesn't (needs pull)
   - `not in Ledger` — local file has no matching note

**Output format:**
```
feedback_coding_conventions.md — local changes, needs push
project_status.md — local changes, needs push
user_profile.md — in sync
user_working_style.md — in sync
```

## Session Lifecycle

```
Session start:   SessionStart hook runs `ledger-sync pull --quiet`
                 → skips conflicts, flags them via CONFLICT: output
                 → agent sees conflicts, shows diff, helps resolve

During session:  Agent updates Ledger first (via MCP), then local cache
                 → this is the normal flow, no sync needed

Session end:     Agent runs `ledger-sync check`
                 → catches any local files modified but not pushed
                 → agent pushes them before closing
```

## Hook Integration

### SessionStart hook
```bash
ledger-sync pull --quiet
```
Runs at every session start. Output captured by Claude Code — CONFLICT lines surface to the agent automatically.

### Stop hook (or agent discipline)
Agent runs `ledger-sync check` before wrapping up. Pushes any modified files.

## CLAUDE.md Generation

Compiles feedback notes into a structured rules document. Section mapping:

```
# Global Rules

## Security
← feedback-no-read-env

## Coding Conventions
← feedback-coding-conventions

## Architecture
← feedback-mcp-registration
← feedback-prefer-cli-and-skills
← feedback-repo-docs-structure
← feedback-project-logs

## Communication
← feedback-communication-style

## Knowledge System
← feedback-note-decomposition
← hardcoded Ledger-first rules
```

Unmapped feedback notes go into "## General" section.

## File Structure

```
~/repos/ledger/
├── src/
│   ├── mcp-server.ts      (MCP server)
│   └── cli.ts              (ledger-sync CLI)
├── dist/
│   ├── mcp-server.js
│   └── cli.js
├── install.sh              (npm link setup)
└── package.json            (bin field: ledger-sync → dist/cli.js)
```

## Dependencies

No new dependencies. Uses existing:
- `@supabase/supabase-js` — query/update notes
- `openai` — re-generate embeddings on push
- `dotenv` — load credentials from .env

## Configuration

Uses the same `.env` file as the MCP server:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`

Resolved via `DOTENV_CONFIG_PATH` env var or defaults to `~/repos/ledger/.env`.

## Install

```bash
cd ~/repos/ledger && ./install.sh
```

## Error Handling

- Missing .env / credentials → clear error message with setup instructions
- Supabase unreachable → error with retry suggestion
- Note not found on push → error: "No Ledger note with local_file X found. Add it via MCP first."
- File not found on push → error: "File not found: <path>"

## Metadata Contract

Notes that should be cached locally must have these metadata fields:
```json
{
  "local_cache": true,
  "local_file": "feedback_coding_conventions.md",
  "upsert_key": "feedback-coding-conventions"
}
```

`pull` queries: `metadata->>local_cache = 'true'`
`push` matches: `metadata->>local_file = '<filename>'`
`check` compares: local file content vs Ledger note content
