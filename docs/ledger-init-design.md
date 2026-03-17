# ledger init + ledger setup — Design Spec

> Date: 2026-03-16
> Status: Approved (rev 2 — post spec review)

## Overview

Two commands that separate universal setup from platform-specific agent configuration.

- `ledger-sync init` — credentials, config, database schema. Runs once per machine.
- `ledger-sync setup <platform>` — agent connection and persona delivery. Runs once per agent.

**Note:** the binary is `ledger-sync` (as defined in package.json `bin` field). All commands use this name.

## Commands

### `ledger-sync init`

Sets up Ledger on a machine. Does not configure any agent.

**Flow:**
```
1. Welcome message
2. Check if ~/.ledger/.env already exists
   → Yes: "Existing config found. Overwrite credentials? [y/N]"
     → No: skip to step 8 (re-verify connection)
     → Yes: continue to step 3
3. "Do you have a Supabase project?"
   → No: show step-by-step instructions (create account, create project, find keys), wait
   → Yes: continue
4. Prompt: Supabase URL
5. Prompt: Service Role Key (masked input)
6. Prompt: OpenAI API Key (masked input)
7. Write ~/.ledger/.env (chmod 600)
8. Write ~/.ledger/config.json (preserve existing hook preferences, merge with defaults)
9. Connect to Supabase → verify credentials
   → Fail: show error, offer to re-enter
10. Validate OpenAI key → test embedding call ("test")
   → Fail: show error, offer to re-enter
11. Check if notes table exists
   → No (new): run SQL migrations
   → Yes (existing): "Found existing Ledger with X notes."
12. "Init complete. Run `ledger-sync setup <platform>` to connect an agent."
```

**Idempotency:** Running `init` again is safe.
- Credentials: asks before overwriting
- config.json: merges (preserves user hook preferences, adds new defaults)
- Migrations: all written to be idempotent (IF NOT EXISTS, DROP before CREATE where needed)
- Migration tracking: `schema_migrations` table records which migrations have run

**Output files:**
```
~/.ledger/
  .env              ← SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY (chmod 600)
  config.json       ← paths, hook preferences
```

**config.json structure:**
```json
{
  "memoryDir": "<auto-detected from homedir>",
  "claudeMdPath": "<homedir>/CLAUDE.md",
  "hooks": {
    "envBlocking": true,
    "mcpJsonBlocking": true,
    "writeInterception": true,
    "sessionEndCheck": true
  }
}
```

`ConfigFile` interface must be updated to include `hooks` field.

### `ledger-sync setup claude-code`

Configures Claude Code to use Ledger. Live sync, bidirectional.

**Flow:**
```
1. Verify ~/.ledger/.env exists → error if not: "Run `ledger-sync init` first."
2. Register MCP server: claude mcp add -s user ledger -- node <path-to-mcp-server.js>
3. Copy hook scripts to ~/.claude/hooks/ (respects config.json hook preferences)
4. Update ~/.claude/settings.json with hook config
5. Run ledger-sync pull --force
6. "Claude Code is ready. Start a new session."
```

**Hook installation respects config:**
- If `hooks.envBlocking: false` → skip block-env.sh
- If `hooks.writeInterception: false` → skip post-write-ledger.sh
- etc.

### `ledger-sync setup openclaw [path]`

Generates persona files for OpenClaw. Live sync via CLI.

Path is optional — if omitted, prompts for it.

**Flow:**
```
1. Verify ~/.ledger/.env exists
2. If no path provided, ask: "Where is your OpenClaw workspace?"
3. Read user-preference + feedback notes from Ledger
4. Generate SOUL.md (communication style, personality rules)
5. Generate USER.md (user profile, background, skills)
6. Generate IDENTITY.md (agent identity)
7. Write files to specified path
8. "OpenClaw persona written. OpenClaw can sync via `ledger-sync` CLI."
```

### `ledger-sync setup chatgpt`

Generates a static system prompt. No live connection.

**Flow:**
```
1. Verify ~/.ledger/.env exists
2. Read user-preference + feedback notes from Ledger
3. Compile into a single system prompt
4. Print to stdout with disclaimer:
   "WARNING: This is a snapshot, not a live connection.
    Run `ledger-sync setup chatgpt` again to regenerate after changes."
5. User copies text to ChatGPT → Settings → Custom Instructions
```

## SQL Migrations

Bundled in `src/migrations/`. Run by `init` via Supabase client.

All migrations must be idempotent — safe to run multiple times.

**000-tracking.sql:**
```sql
-- Migration tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz DEFAULT now()
);
```

**001-schema.sql:**
```sql
-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Notes table
CREATE TABLE IF NOT EXISTS notes (
  id bigserial PRIMARY KEY,
  content text NOT NULL,
  metadata jsonb DEFAULT '{}',
  embedding vector(1536),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_updated_at ON notes;
CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- HNSW index for semantic search (defaults are fine for small-to-medium datasets)
CREATE INDEX IF NOT EXISTS notes_embedding_idx
  ON notes USING hnsw (embedding vector_cosine_ops);
```

**002-functions.sql:**
```sql
CREATE OR REPLACE FUNCTION match_notes(
  q_emb text,
  threshold double precision DEFAULT 0.5,
  max_results integer DEFAULT 10
)
RETURNS TABLE(id bigint, content text, metadata jsonb, similarity double precision)
LANGUAGE sql STABLE AS $$
  SELECT notes.id, notes.content, notes.metadata,
    1 - (notes.embedding <=> q_emb::vector) AS similarity
  FROM notes
  WHERE 1 - (notes.embedding <=> q_emb::vector) > threshold
  ORDER BY notes.embedding <=> q_emb::vector
  LIMIT least(max_results, 200)
$$;
```

Note: `q_emb` is `text` not `vector`. The MCP server sends `JSON.stringify(embedding)` which PostgREST passes as text. The `::vector` cast happens inside the function. This is intentional — PostgREST cannot auto-cast JSON arrays to pgvector types.

**003-rls.sql:**
```sql
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to make migration idempotent
DROP POLICY IF EXISTS "service_role_all" ON notes;
DROP POLICY IF EXISTS "anon_read_only" ON notes;

-- Anon key (used by capture Edge Function): read-only
CREATE POLICY "anon_read_only" ON notes
  FOR SELECT TO anon USING (true);

-- Service role bypasses RLS entirely (Supabase built-in behavior).
-- No policy needed — service_role_key always has full access.
-- The anon policy above restricts the anon key to SELECT only.
```

## Config System

`config.ts` updated to load credentials from `~/.ledger/.env`:

**Full priority order:**
1. Environment variables (`SUPABASE_URL`, `OPENAI_API_KEY`, etc.)
2. `DOTENV_CONFIG_PATH` if set (development override — points to repo `.env`)
3. `~/.ledger/.env` (default credential location)
4. `~/.ledger/config.json` (paths, hook preferences)
5. Defaults (memoryDir and claudeMdPath derived from homedir)

Existing repo `.env` and `DOTENV_CONFIG_PATH` still work for development — they override `~/.ledger/.env` when set.

## Sync Model Per Platform

| Platform | Connection | Sync | Delivery |
|---|---|---|---|
| Claude Code | MCP (live) + CLI | Bidirectional, automatic (hooks) | CLAUDE.md + memory files |
| OpenClaw | CLI (live) | Bidirectional via `ledger-sync` | SOUL.md + USER.md + IDENTITY.md |
| ChatGPT | None | Static snapshot, manual re-export | System prompt text |
| CLI only | Direct Supabase | N/A — tool, not agent | N/A |

## New Files

```
src/
├── commands/
│   ├── init.ts           ← credential prompts, schema detection, migrations
│   └── setup.ts          ← platform-specific agent configuration
├── migrations/
│   ├── 000-tracking.sql
│   ├── 001-schema.sql
│   ├── 002-functions.sql
│   └── 003-rls.sql
```

## Changes to Existing Code

- `cli.ts` — add `init` and `setup` commander commands
- `config.ts` — load from `~/.ledger/.env` first, update `ConfigFile` interface to include `hooks` field, add `DOTENV_CONFIG_PATH` to priority chain
- `lib/prompt.ts` — add masked input for passwords/keys

## Error Handling

| Error | Action |
|---|---|
| Supabase credentials invalid | Show error, offer to re-enter |
| OpenAI key invalid (test embedding fails) | Show error, offer to re-enter |
| pgvector extension not enabled | Show instructions to enable in Supabase dashboard |
| Schema migration fails | Show SQL error, suggest running manually in dashboard |
| `setup` before `init` | "Run `ledger-sync init` first." |
| Claude Code not installed | "Install Claude Code first: npm install -g @anthropic-ai/claude-code" |
| Hook directory doesn't exist | Create it |
| settings.json doesn't exist | Create it with hook config only |
| Re-running init | Safe — asks before overwriting credentials, merges config, migrations are idempotent |

## Also Update

- `docs/ARCHITECTURE.md` — add `export` and `ingest` to CLI reference, add `init` and `setup`
