# V1 Onboarding Flow — Reference for Future Rebuild

> This documents the v1 onboarding commands that were removed during the v2 CLI cleanup.
> They all referenced the dropped `notes` table and `lib/notes.js`. The concepts are still
> needed but must be rebuilt against the v2 `documents` table and `documents/operations.ts`.

## Commands Removed

### `ledger init --legacy`
**What it did:** Gathered Supabase URL, service role key, and OpenAI API key. Wrote them to `~/.ledger/.env`. Ran SQL migrations against the database. Detected whether the database already had data.

**Steps:**
1. Ask for Supabase URL, service role key, OpenAI API key
2. Write to `~/.ledger/.env`
3. Test connection to Supabase
4. Check if `notes` table exists (detect new vs existing DB)
5. If new: show migration SQL for user to run in Supabase SQL Editor
6. If existing: report note count
7. Optionally enable daily backup cron

**What to keep:** The credential gathering + .env writing + connection test. The migration detection needs to check `documents` table instead of `notes`.

### `ledger init` (wizard)
**What it did:** Full guided setup combining credentials, database, persona, platform setup, and sync into one sequential flow.

**Steps:**
1. Credentials — gather or detect existing
2. Database — connect, detect schema, run migrations
3. Persona — run `onboard` (create personality profile)
4. Platform — detect and set up Claude Code / OpenClaw / ChatGPT
5. Sync — pull notes to local cache
6. Migration — detect and ingest local memory files

**What to keep:** The step-by-step wizard pattern. Each step detects if already done and skips. Steps 3-6 need redesign for v2.

### `ledger onboard`
**What it did:** Interactive persona creation. Asked the user questions about their role, communication preferences, working style. Saved responses as Ledger notes with type `persona-rule`.

**Questions asked:**
- Your name and role
- How you want AI to communicate (formal/casual, verbose/concise)
- Technical background (languages, frameworks, experience level)
- Working style preferences (ADHD management, learning style)
- Rules and boundaries (what AI should never do)

**What to keep:** The interview-to-document pattern. Responses should create `documents` with `domain: 'persona'` instead of notes.

### `ledger setup claude-code`
**What it did:** Registered Ledger as an MCP server with Claude Code, installed hooks, pulled notes to local cache.

**Steps:**
1. Run `claude mcp add ledger` with the MCP server path
2. Copy hook scripts to Claude Code hooks directory
3. Pull persona notes to generate CLAUDE.md
4. Generate `~/.claude/CLAUDE.md` from persona notes

**What to keep:** MCP registration and hook installation. The CLAUDE.md generation needs to use `documents` not `notes`.

### `ledger setup openclaw`
**What it did:** Generated personality files for the OpenClaw platform from persona notes.

### `ledger setup chatgpt`
**What it did:** Generated a system prompt for ChatGPT from persona notes. Static snapshot (no live sync).

### `ledger config get/set/unset/list`
**What it did:** View and modify Ledger config values. Managed custom document types (type registry).

**What to keep:** Config management is still needed. The type registry used `lib/notes.js` — needs to use `documents/classification.ts` types instead.

### `ledger sync`
**What it did:** Bidirectional sync between Ledger database and local file cache. Detected conflicts (both sides changed), supported `--quiet`, `--force`, `--dry-run`.

**What to keep for v2:** v2 doesn't use local file cache — documents live in the database and are accessed via MCP. If file sync is needed later (Phase 5), it should use the `documents` table and the Realtime subscription, not the polling approach.

### `ledger pull`
**What it did:** One-way download of notes to local cache files. Used for generating CLAUDE.md and persona files.

**Same as sync note above** — local cache is a v1 concept.

### `ledger add` (CLI version)
**What it did:** Added a note via CLI with flags for type, agent, project, upsert key, description, status. Included duplicate detection via semantic similarity.

**What to keep:** The flag structure and duplicate detection concept. Must use `createDocument()` from `documents/operations.ts` instead of `opAddNote()`.

### `ledger ingest`
**What it did:** Scanned for unknown local files and offered to add them to Ledger. Included duplicate detection. Used by the auto-ingest hook.

**What to keep for v2:** The concept, but it should use the `ingestion_queue` table (Phase 4.7) instead of direct insertion.
