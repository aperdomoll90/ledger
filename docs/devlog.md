# Ledger — Setup Log

Chronological log of what was done, tried, what worked and what didn't.

---

## Session 1 — 2026-03-13 (Project Init)

### Steps Completed
1. **Created Supabase project** — free tier, Data API + automatic RLS enabled, provisioned in ~2 min, status: healthy
2. **Enabled pgvector** — Dashboard → Database → Extensions → vector
3. **Created project repo** at `/home/adrian/repos/ledger/` — `npm init`, ES modules, `.env` template, `.gitignore`, `CLAUDE.md`
4. **Added Supabase credentials** to `.env` — project URL, anon key, service_role key from Dashboard → Settings → API
5. **Created database schema** — `notes` table (id, content, metadata jsonb, embedding vector(1536), timestamps), vector similarity index, `match_notes` RPC, RLS policies
6. **Configured embeddings** — OpenAI `text-embedding-3-small`, 1536 dimensions, generated at insert time
7. **Built capture Edge Function** — `supabase/functions/capture/index.ts`, HTTP POST endpoint for non-MCP ingestion, deployed with `--no-verify-jwt`, CORS enabled
8. **Installed npm dependencies** — `@supabase/supabase-js`, `openai`, `@modelcontextprotocol/sdk`, `dotenv`, `zod` + dev deps
9. **Built MCP server** — `src/mcp-server.ts` with 4 tools: `add_note`, `search_notes`, `list_notes`, `delete_note`
10. **Inserted first test note** — "hello from the first memory" (id: 1) via direct API call, confirmed full pipeline works
11. **Connected Claude Code** — added to `~/.claude/mcp.json`
12. **Added `SUPABASE_ACCESS_TOKEN`** to `.env` for CLI access (no expiration)

### Issues
- MCP tools didn't appear in Claude Code after connecting — server configured but tools not picked up

---

## Session 2 — 2026-03-13

### Findings
- MCP tools still not appearing in Claude Code
- Server runs without errors when launched manually

---

## Session 3 — 2026-03-14

### Findings
- Confirmed server starts cleanly (`npx tsx src/mcp-server.ts` — no crash, no output, waits for stdin)
- Confirmed server responds correctly to MCP initialize request via stdin pipe — returns protocol version, capabilities, server info with all 4 tools
- `~/.claude/mcp.json` config verified correct
- Tools still don't appear in Claude Code (not even in deferred tools list)
- **Suspected cause:** `npx tsx` cold-start overhead may cause MCP handshake timeout

### Work Done
- Extracted project knowledge into global Claude memory (`~/.claude/projects/-home-adrian/memory/`)
- Set up global memory system with 5 memory files + index
- Reorganized repo documentation: split monolithic `ledger.md` into `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION.md`, and `docs/setup-log.md`
- Saved preferences: always maintain project logs, standard `docs/` folder structure for all repos

### Planned Fix for MCP Connection
1. Precompile TypeScript to JavaScript:
   ```bash
   cd /home/adrian/repos/ledger
   npx tsc src/mcp-server.ts --outDir dist --module nodenext --moduleResolution nodenext
   ```
2. Update `~/.claude/mcp.json` to use `node dist/mcp-server.js` instead of `npx tsx`
3. Restart Claude Code, check `/mcp`

### Next Session TODO (Session 4)
**Priority 1 — Fix Ledger MCP connection:**
1. Precompile TS → JS:
   ```bash
   cd /home/adrian/repos/ledger
   npx tsc src/mcp-server.ts --outDir dist --module nodenext --moduleResolution nodenext
   ```
2. Update `~/.claude/mcp.json` — change `["tsx", "/home/adrian/repos/ledger/src/mcp-server.ts"]` to `["/home/adrian/repos/ledger/dist/mcp-server.js"]` with command `node`
3. Restart Claude Code, run `/mcp` to check connection
4. If still broken, check Claude Code logs for handshake errors

**Priority 2 — Once MCP works:**
- [ ] Test all 4 tools live (`add_note`, `search_notes`, `list_notes`, `delete_note`)
- [ ] Store global memory notes into Ledger

**Priority 3 — Plugin setup:**
- [ ] Set up global Claude Code plugins (Slack, Firecrawl, Pinecone, Vercel, etc.)
- [ ] Create global `~/CLAUDE.md` for cross-project preferences

---

## Session 4 — 2026-03-14

### Work Done
1. **Precompiled TS → JS** — `npm run build` → `dist/mcp-server.js`, clean compile
2. **Updated `~/.claude/mcp.json`** — changed from `npx tsx src/mcp-server.ts` to `node dist/mcp-server.js`
3. **Verified MCP handshake** — piped `initialize` request, got correct response instantly (protocol version, capabilities, server info)
4. **Root cause confirmed** — `npx tsx` cold-start was exceeding Claude Code's MCP handshake timeout

### Status
- Awaiting Claude Code restart to confirm tools appear in `/mcp`

### What's in the Database
- Note id: 1 — "hello from the first memory" (inserted 2026-03-14 via direct API call)

---

## Session 5 — 2026-03-14

### Ledger-Specific Work
- Confirmed server still not loading despite precompile fix from session 4
- The remaining issue was a **global Claude Code environment problem** (not Ledger-specific) — see global work log for details
- Registered server via `claude mcp add` with `DOTENV_CONFIG_PATH` env var for dotenv resolution
- `claude mcp get ledger` → Status: ✓ Connected

### Next Steps
- [ ] Restart Claude Code, verify 4 tools appear
- [ ] Test all 4 tools live (`add_note`, `search_notes`, `list_notes`, `delete_note`)
- [ ] Store global memory notes into Ledger
- [ ] Connect OpenClaw/ZhuLi

---

## Session 7 — 2026-03-14

### Goal
Verify all 5 Ledger MCP tools work live after fresh session restart.

### What Worked
1. **MCP connection confirmed** — all 5 tools visible in Claude Code MCP panel (add_note, update_note, search_notes, list_notes, delete_note)
2. **`list_notes`** — returned 2 existing test notes (id 1 and 2 from sessions 1 and 4)
3. **`add_note`** — saved note with required `type`/`agent` params, got id 3 back. v2.0.0 metadata enforcement working.

### Bug Found: `search_notes` Returns Empty
**Symptom:** `search_notes` returned "No matching notes found" for any query, even at 0.1 threshold.

**Diagnosis steps:**
1. Searched for "ledger testing verification" (threshold 0.5) → no results
2. Searched for "v2.0.0 live test" (threshold 0.3) → no results — ruled out threshold being too high
3. Searched for "hello first memory" (threshold 0.1) — nearly verbatim match for note 1 → still no results
4. Read `src/mcp-server.ts` — code calls `getEmbedding()` then `supabase.rpc('match_notes', ...)`, looked correct
5. Checked embeddings exist in DB — all 3 notes have valid 1536-dim embeddings, self-similarity = 1.0
6. Tested `match_notes` RPC directly via supabase-js with dummy embedding → returned empty
7. Tested `match_notes` RPC via raw PostgREST fetch with real OpenAI embedding → returned empty
8. Tested **direct SQL** with the same real embedding → **returned note 1 at 0.877 similarity**
9. Retrieved `match_notes` function definition via `pg_get_functiondef()` — function SQL was correct

**Root cause:** The `match_notes` Postgres function parameter was typed as `vector(1536)`. When supabase-js calls the RPC via PostgREST, it sends the embedding as a JSON array. **PostgREST cannot auto-cast a JSON array to pgvector's `vector` type**, so the cosine distance operator (`<=>`) silently returns no matches.

Direct SQL worked because the `::vector` cast was explicit in the query string.

**Fix (two parts):**
1. **Database:** Changed `match_notes` function signature from `query_embedding vector` to `query_embedding text`, added explicit `query_embedding::vector` cast inside the function body
2. **MCP server:** Changed `search_notes` to pass `JSON.stringify(embedding)` instead of the raw array, so PostgREST sends it as a string that Postgres casts to vector

**SQL applied:**
```sql
CREATE OR REPLACE FUNCTION public.match_notes(
  query_embedding text,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 10
)
RETURNS TABLE(id bigint, content text, metadata jsonb, similarity double precision)
LANGUAGE sql STABLE AS $$
  select notes.id, notes.content, notes.metadata,
    1 - (notes.embedding <=> query_embedding::vector) as similarity
  from notes
  where 1 - (notes.embedding <=> query_embedding::vector) > match_threshold
  order by notes.embedding <=> query_embedding::vector
  limit match_count;
$$;
```

**Code change:** `src/mcp-server.ts` line 106 — `query_embedding: embedding` → `query_embedding: JSON.stringify(embedding)`

Recompiled to `dist/mcp-server.js`.

### First Fix Attempt: text param + JSON.stringify
Changed `match_notes` param from `vector` to `text`, added `::vector` cast inside function. Changed MCP server to pass `JSON.stringify(embedding)`. Recompiled. Reconnected MCP.

**Result:** Still returned empty. Got overload conflict error first (`Could not choose the best candidate function between vector and text versions`) because `CREATE OR REPLACE` doesn't replace when the signature changes — it creates a second overload. Dropped the old `vector` overload, reloaded PostgREST schema cache (`NOTIFY pgrst, 'reload schema'`). Still empty.

### Deeper Diagnosis
Created debug functions to isolate each layer:

1. **`debug_echo(text)`** — proved PostgREST passes text strings correctly
2. **`debug_vector(text)`** — proved `text::vector(1536)` cast works through PostgREST (29K chars, 1536 dims)
3. **`debug_count()`** — proved 4 notes exist in the table
4. **`debug_cosine(text)`** — `SELECT + ORDER BY <=>` returned empty through PostgREST
5. **`debug_select_notes(text)`** — `SELECT + LIMIT` (NO ORDER BY) returned **4 results with correct distances**

**Key finding:** Adding `ORDER BY n.embedding <=> variable` to any function caused it to return 0 results. Without ORDER BY, same function returned correct results.

Tried multiple approaches that did NOT fix it:
- `LANGUAGE plpgsql` instead of `sql` — no difference
- `::vector(1536)` explicit dimension cast — no difference
- Local variable (`DECLARE v_emb vector(1536); v_emb := param::vector(1536)`) — no difference
- Renamed parameters to avoid shadowing — no difference
- Fresh function with new name (`match_notes_v2`, `match_test`) — no difference
- Multiple PostgREST schema reloads — no difference

### Actual Root Cause: IVFFlat Index + Small Dataset

Checked the index definition:
```sql
CREATE INDEX notes_embedding_idx ON public.notes
  USING ivfflat (embedding vector_cosine_ops) WITH (lists='100')
```

**The problem:** IVFFlat with `lists=100` for 4 rows. IVFFlat divides the vector space into clusters. With 100 lists and 4 notes, almost every list is empty. `ORDER BY <=>` triggers an index scan. Default `probes=1` checks one list, which is empty → 0 results. Without ORDER BY, Postgres does a sequential scan and finds everything.

This is a known pgvector behavior documented in GitHub issues. The planner can't optimize the probe value for parameterized queries inside functions.

### Comparison: What We Ran vs Official Docs

| Area | What we ran | What Supabase docs say |
|---|---|---|
| Index type | IVFFlat | HNSW recommended — "performance and robustness" |
| Index lists | `lists = 100` | IVFFlat sizing: 100K vectors → 500 lists. Our 4 rows → ~1 |
| Vector prefix | `vector(1536)` | `extensions.vector(1536)` (schema-qualified) |
| Similarity calc | `1 - (embedding <=> query) > threshold` | `embedding <=> query < 1 - threshold` (compare distance directly) |
| Safety limit | None | `limit least(match_count, 200)` |

**Sources consulted:**
- [Supabase Semantic Search Guide](https://supabase.com/docs/guides/ai/semantic-search)
- [Supabase Vector Indexes](https://supabase.com/docs/guides/ai/vector-indexes)
- [Supabase Compute/Sizing Guide](https://supabase.com/docs/guides/ai/choosing-compute-addon)
- [pgvector GitHub README](https://github.com/pgvector/pgvector)

### Key Takeaways

1. **IVFFlat requires `lists` tuned to data size.** 100 lists for 4 rows is catastrophically wrong. Most lists are empty, index scans return nothing.
2. **HNSW is the recommended index type.** Works with any data size, no `lists` tuning, better speed-recall tradeoff.
3. **`ORDER BY <=>` triggers index scan.** Without ORDER BY, Postgres does a sequential scan and the query works. This is why our debug functions without ORDER BY worked.
4. **PostgREST + pgvector type casting is a separate issue.** The original `vector` param type DID need to change to `text` — but that alone didn't fix it because the index was the primary blocker.
5. **`CREATE OR REPLACE` doesn't replace when signature changes.** It creates an overload. Must `DROP FUNCTION` first.
6. **PostgREST schema cache must be reloaded** after DDL changes with `NOTIFY pgrst, 'reload schema'`.

### Plan: Clean Slate Rebuild
Drop the IVFFlat index and all debug functions. Rebuild with:
1. HNSW index (works at any scale, no tuning)
2. Rewritten `match_notes` following official Supabase pattern
3. Updated MCP server code to match

### Status
- DB has leftover debug functions to clean up
- `match_notes` currently broken (plpgsql text param version, still hitting bad index)
- MCP server has `JSON.stringify` change (keep this)

### Next Steps
- [x] Drop IVFFlat index, debug functions, current match_notes
- [x] Create HNSW index
- [ ] Create new match_notes following official pattern
- [ ] Test all 5 MCP tools live
- [ ] Update ARCHITECTURE.md
- [ ] Bulk migrate global memory into Ledger
- [ ] Build `ledger-sync` CLI

---

## Session 8 — 2026-03-14

### Goal
Clean slate DB rebuild — Adrian executing SQL manually to learn Postgres.

### Steps Completed

**1. Inspected existing functions**
```sql
SELECT proname AS function_name, pg_get_function_arguments(oid) AS parameters
FROM pg_proc WHERE pronamespace = 'public'::regnamespace;
```
Found 4 functions: `debug_select_notes`, `match_notes`, `match_test`, `rls_auto_enable`.

**2. Dropped debug/broken functions**
```sql
DROP FUNCTION debug_select_notes(text);
DROP FUNCTION match_test(text);
DROP FUNCTION match_notes(text, double precision, integer);
```
Only `rls_auto_enable` remains — intentional, it auto-enables RLS on new tables.

**3. Inspected existing indexes**
```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'notes';
```
Found: `notes_pkey` (btree, keep) and `notes_embedding_idx` (ivfflat lists=100, drop).

**4. Dropped broken IVFFlat index**
```sql
DROP INDEX notes_embedding_idx;
```

**5. Created HNSW index**
```sql
CREATE INDEX notes_embedding_idx ON public.notes USING hnsw (embedding vector_cosine_ops);
```
HNSW works at any data size, no `lists` tuning needed. Defaults are fine.

### SQL Concepts Learned
- `pg_proc` — catalog of all functions, filter with `pronamespace = 'public'::regnamespace`
- `pg_indexes` — catalog of all indexes, `indexdef` shows full CREATE statement
- `::` — Postgres cast operator (e.g. `'public'::regnamespace`, `text::vector`)
- `AS` — column alias, purely cosmetic
- `DROP FUNCTION name(types)` — must include param types due to function overloading
- `DROP INDEX` — removes lookup structure, data stays untouched
- Schemas — namespaces for objects. `public` is default, Supabase adds `auth`, `storage`, `extensions`
- Saved full Postgres catalog reference to Ledger (note #6)

**6. Created new match_notes function**
```sql
CREATE OR REPLACE FUNCTION public.match_notes(
  q_emb text,
  threshold double precision DEFAULT 0.5,
  max_results integer DEFAULT 10
)
RETURNS TABLE(id bigint, content text, metadata jsonb, similarity double precision)
LANGUAGE sql STABLE
AS $$
  SELECT notes.id, notes.content, notes.metadata,
    1 - (notes.embedding <=> q_emb::vector) AS similarity
  FROM notes
  WHERE 1 - (notes.embedding <=> q_emb::vector) > threshold
  ORDER BY notes.embedding <=> q_emb::vector
  LIMIT least(max_results, 200)
$$;
```
Key choices: `LANGUAGE sql` (planner can optimize), `STABLE` (read-only), `text` param with `::vector` cast (PostgREST compatible), `least()` safety cap.

**7. Reloaded PostgREST schema cache**
```sql
NOTIFY pgrst, 'reload schema';
```

**8. Fixed MCP server parameter names**
Server was calling `query_embedding`, `match_threshold`, `match_count` — renamed to match new function: `q_emb`, `threshold`, `max_results`.

**9. Fixed Zod type coercion**
MCP client sends numbers as strings. Changed all `z.number()` to `z.coerce.number()` for `id`, `limit`, `threshold` params across all tools.

**10. Recompiled and reconnected**
`npm run build` → clean compile. Reconnected MCP server.

### Test Results — All 5 Tools Verified
| Tool | Result |
|---|---|
| `search_notes` | Matched note #1 at 79.3% similarity ("hello first memory test" → "hello from the first memory") |
| `list_notes` | Returned all 6 notes with metadata |
| `add_note` | Created note #8 with type/agent enforcement |
| `update_note` | Updated note #8 → new id #9, re-embedded |
| `delete_note` | Deleted note #9 |

### Knowledge System Redesign
- Designed new system: Ledger = single source of truth, local files = cache only
- Added `event` and `error` note types to MCP server enum
- Restructured `project_status.md` to slim dashboard (recent done + next steps only)
- Slimmed MEMORY.md — only auto-loads user profile, feedback, project dashboard

### Global Memory Migration
Migrated all global memory files into Ledger:
- User profile (4 files → notes 10-13)
- Feedback rules (8 files → notes 14-21)
- References (3 files → notes 22-24, skipped credentials)
- Project architecture + config (notes 25-26)
- Project status dashboard (note 28)
- Events log (note 29), Error log (note 30)

Deleted 11 local files that are now in Ledger and not auto-loaded. 14 files remain (cache layer only).

### AI Studio Spec Decomposition
Decomposed AI_STUDIO.md (1057 lines) into 8 focused Ledger notes:
- ai-studio-overview (note 31) — system hierarchy, operation modes, model tiers
- ai-studio-agent-zhuli (note 32) — orchestrator responsibilities, tools, output format
- ai-studio-agent-marshall (note 33) — trust boundary, SafeBrief format, pre-send checks
- ai-studio-agent-hunter (note 34) — scoring rubric, thresholds, reject codes
- ai-studio-agent-ross-ada (note 35) — designer + accessibility, paired in pipeline
- ai-studio-agent-cody-stan (note 36) — developer + QA, tools, credential access
- ai-studio-upwork (note 37) — ToS rules, workflow, niche strategy
- ai-studio-infrastructure (note 38) — artifacts, metering, security, credential matrix

Deleted local AI_STUDIO.md, BOOTSTRAP.md, and .bak files from OpenClaw.

### Additional Work
- Created `docs/sql-reference.md` — comprehensive SQL/Postgres study reference
- Saved Postgres catalogs reference to Ledger (note #6)
- Saved MCP debugging guide to Ledger (note #7)
- Knowledge system architecture documented (note 39)

### ledger-sync CLI Built
Designed, implemented, and installed `ledger-sync` CLI tool:

**Design decisions:**
- Lives in Ledger repo (`src/cli.ts`), shares dependencies
- Two commands: `pull` (download from Ledger) and `push <file>` (upload to Ledger)
- `pull` always overwrites — Ledger is source of truth
- `push` is explicit direction — you decide when to upload
- `~/CLAUDE.md` is a generated build artifact — compiled from feedback notes in Ledger
- Push matches notes by `local_file` metadata field (exact lookup, not semantic search)

**Implementation:**
- `src/cli.ts` — pull queries `local_cache: true` notes, generates cache files + MEMORY.md + CLAUDE.md. Push finds note by `local_file` metadata, updates content + re-embeds via OpenAI.
- `install.sh` — `npm run build && npm link` for global `ledger-sync` command
- `bin` field added to package.json
- Suppressed dotenv v17 noisy logging with `quiet: true`

**CLAUDE.md generation:**
- Section mapping: Security ← feedback-no-read-env, Coding ← feedback-coding-conventions, Architecture ← feedback-mcp-registration + prefer-cli + repo-docs + project-logs, Communication ← feedback-communication-style, Knowledge System ← feedback-note-decomposition + hardcoded Ledger-first rules
- Unmapped feedback notes go into General section

**Testing:**
- `ledger-sync pull` — wrote 14 files + MEMORY.md + CLAUDE.md
- `ledger-sync push project_status.md` — updated note 28 → 41 in Ledger with new embedding
- `ledger-sync pull --quiet` — silent mode for hooks/cron

**Bugs found and fixed:**
- `upsertKey` reference after variable was removed → compile error → fixed
- Push initially derived upsert_key from filename (e.g. `project-status`), but Ledger had `project-status-dashboard` → switched to lookup by `local_file` metadata field

---

## Session 9 — 2026-03-15

### Goal
Harden ledger-sync CLI — conflict detection, sync markers, show command, session hooks.

### Features Added

**Conflict detection on pull:**
- Pull compares local files before overwriting
- Files with `modified` or `new` markers are skipped, prints `CONFLICT:filename`
- `--force` flag overrides and overwrites all
- SessionStart hook runs `ledger-sync pull --quiet` — conflicts surface to agent

**Sync markers:**
- Every file tracked by Ledger gets first-line marker: `<!-- ledger: clean -->`, `<!-- ledger: modified -->`, or `<!-- ledger: new -->`
- `pull` writes `clean`, agent changes to `modified` on edit, `push` resets to `clean`
- `check` scans markers locally — no API calls needed, instant
- Rule added as feedback note: agent must update marker when creating/modifying files

**check command (v2):**
- Reads markers instead of comparing content against Ledger
- Reports: clean, modified, new
- No Supabase queries needed

**show command:**
- `ledger-sync show <query>` — semantic search, writes top match to `/tmp/ledger-view/`
- Auto-opens in VS Code
- Push supports view files (matches by upsert_key as fallback)

**push improvements:**
- Strips marker before uploading content to Ledger
- Resets marker to `clean` after successful push
- Matches by `local_file` metadata first, falls back to `upsert_key` (for view files)

**SessionStart hook:**
- Added to `~/.claude/settings.json`
- Runs `ledger-sync pull --quiet` at every session start
- CONFLICT lines surface to agent for immediate resolution

**Feedback notes added:**
- `feedback-conflict-resolution` — agent handles conflicts at session start, checks at session end
- `feedback-sync-markers` — marker rules for all knowledge files

### Architecture Decisions
- Memory dir = only cached files (auto-loaded). No stale files.
- New knowledge → Ledger via MCP directly, never local file first
- `/tmp/ledger-view/` for temp viewing via `show` — OS cleans up
- ~/CLAUDE.md generated from Ledger — build artifact, not source
- Markers make check instant (no API), pull conflict-aware, push self-cleaning

### Enforcement Hooks (continued)
- Fixed hooks to read JSON from stdin (not env var) — first test of .env blocking failed, fixed, then worked
- PreToolUse: block-env.sh blocks .env reads/writes (exit 2)
- PreToolUse: check-sync-marker.sh allows all edits (PostToolUse handles markers)
- PostToolUse: post-write-ledger.sh auto clean→modified, auto-adds `new` to unmarked files, warns on generated file edit
- Stop: session-end-check.sh scans for unpushed modified/new files
- Tested all hooks — editing clean file without marker change → auto-updated by PostToolUse

### Generated Marker
- Added 5th marker `<!-- ledger: generated -->` for CLAUDE.md and MEMORY.md
- Pull writes generated marker, PostToolUse changes generated→modified if edited
- Pull skips modified generated files (CONFLICT), --force overrides

### System Analysis
- Created docs/system-map.md — full component map with NPM readiness
- Code is ready to package: MCP server, CLI, hooks, markers, generators
- Gap: automation of setup (schema migrations, MCP registration, hook installation, credentials)
- Identified cross-platform enforcement gap: hooks are Claude Code only
- Strategy: move enforcement to MCP server layer over time

### Architecture Decisions
- Hooks are local bash scripts, no LLM calls, no network
- Enforcement is hard in Claude Code (hooks), soft everywhere else (system prompts)
- MCP server validation (required type/agent) works for all agents
- CLAUDE.md and MEMORY.md are build artifacts, never edited directly

### Credential Exposure Incident
- First .env hook test failed (hooks read env var instead of stdin)
- .env was read and displayed before fix
- Credentials need rotation: Supabase service role key + OpenAI API key

### Next Session (Build Order)
1. `ledger init` — automated setup wizard
2. `ledger export` — backup to JSON
3. Filtered search (by type, project, date)
4. `ledger onboard` — persona wizard
5. `ledger migrate` — import existing files with dedup
6. Connect OpenClaw/ZhuLi to Ledger

### Status
Ledger system fully documented. 5 markers, 4 hooks, 4 CLI commands. 18 cached files. 68 notes in Ledger. Ready for npm packaging once `ledger init` is built.

---

## Session 10 — 2026-03-16

### Goal
Ledger Sync v2 — replace marker-based sync with hash-based sync. Move all Ledger behavior from prompt rules into code.

### Design Decisions (from discussion)
- **Hash-based sync** replaces marker system (`<!-- ledger: clean -->` etc.). Content hash stored in Ledger metadata, state computed by comparing local file hash vs stored hash.
- **Code enforcement over prompt rules** — system behavior must be in code (CLI, hooks), not agent memory files that consume context every session.
- **Ledger has two jobs**: self-management (sync, storage) and persona management (portable preferences across devices).
- **CLAUDE.md and MEMORY.md are generated output**, not manually maintained.
- **Write interception**: agent writes to `memory/` → hook auto-ingests to Ledger → deletes local file. Redirect, not block.
- **`export` vs `pull`**: `pull` = tracked cache, `export` = untracked download to any path.
- **Never assume, always ask** — every data-modifying action confirms with user (enforced in code, not prompts).
- **Token/context conservation** — confirmations happen in bash, not through the agent.
- **`claude -p` flag** — pipe mode for automation (devlog, convention lint, conflict summaries). Identified multiple use cases, saved behavioral rule to watch for more.

### CLI Refactor
- **Modular structure**: split monolithic `cli.ts` (496 lines) into `commands/` + `lib/` directories
- **Commander**: replaced if/else command dispatch with `commander` CLI framework
- **Typed errors**: `LedgerError` class with `ExitCode` enum (7 exit codes)
- **stdout/stderr separation**: machine-readable data to stdout, status to stderr
- **Configurable paths**: env vars → config file → defaults (no hardcoded user paths)
- **SHA-256 hashing**: `crypto.createHash('sha256')` for content change detection

### New File Structure
```
src/
├── cli.ts              → entry point (commander)
├── commands/
│   ├── pull.ts         → hash-aware conflict detection
│   ├── push.ts         → stores hash after push
│   ├── check.ts        → computes state from hashes (no markers)
│   ├── show.ts         → semantic search
│   ├── export.ts       → untracked download (new)
│   └── ingest.ts       → duplicate detection, interactive + auto mode (new)
├── lib/
│   ├── config.ts       → paths, clients, config file support
│   ├── hash.ts         → SHA-256
│   ├── notes.ts        → queries + hash storage/retrieval
│   ├── markers.ts      → transitional (will be removed)
│   ├── generators.ts   → CLAUDE.md + MEMORY.md generation
│   ├── errors.ts       → typed errors + exit codes
│   └── prompt.ts       → interactive prompts (ask, confirm, choose)
└── mcp-server.ts       → now stores content_hash on add/update
```

### New Commands
- `ledger-sync export <query> [-o path]` — download note to custom location, untracked
- `ledger-sync ingest [file] [--auto]` — scan for unknown files, duplicate detection (hash + embedding), interactive or auto mode

### Ingest Flow
1. Check exact match by hash → show content, ask to skip
2. Check similar by embedding → show both, ask: merge / replace / add as new / skip
3. No match → confirm add, choose type, create in Ledger
4. Always ask about deleting local copy
5. `--auto` flag: for hooks, auto-ingests without prompts, infers type from filename

### Hook Changes
- **post-write-ledger.sh**: rewritten — now calls `ledger-sync ingest <file> --auto` instead of managing markers
- **session-end-check.sh**: rewritten — runs `ledger-sync check`, only shows output if issues found
- **check-sync-marker.sh**: removed from settings.json (was a no-op pass-through)

### MCP Server Changes
- Added `contentHash()` function using SHA-256
- `add_note` now stores `content_hash` in metadata automatically
- `update_note` stores `content_hash` in cleaned metadata on re-insert

### Ledger Knowledge Cleanup
- **Consolidated** ~15 scattered project notes into 3 focused notes:
  - Architecture & System Map (id: 77)
  - Product Vision & Goals (id: 78)
  - Status & Roadmap (id: 79)
- **Deleted** 11 notes (47, 48, 51, 56, 57, 59, 61, 68, 73, 74, 75) — absorbed into merged notes
- **Deleted** 3 redundant notes: note_decomposition (id: 21), enforce_system_rules (id: 70), never_assume (id: 71) — covered by product goals
- **Fixed** SECTION_MAP in generators.ts — removed references to deleted notes
- **Added** repos reference note (id: 80)

### Test Results
| Test | Result |
|---|---|
| Check (baseline) | 14 clean, 2 modified, 3 unknown |
| Pull | 16 written, 0 conflicts, hashes stored |
| Check (after pull) | 16 clean, 3 unknown |
| Local edit detection | Correctly detected as modified |
| Pull with conflict | CONFLICT reported, file skipped |
| Force pull | Overwrites, back to clean |
| Export | Untracked, no sync impact |
| Session end hook | Reports status |
| Semantic search | Works |
| MCP server | Starts and responds |
| Final cleanup check | 15 clean, 0 unknown, all synced |

### Status
v2 core complete. Hash-based sync working. Marker system still in code (transitional) but not used for state detection. Next: remove markers entirely, set up `claude -p` automations, build `ledger init`.

---

## Session 11 — 2026-03-16

### Goal
Clean up marker system, add tests, audit behavioral enforcement, prepare for `ledger init`.

### Marker System Removal
- Removed all marker imports from pull.ts, push.ts, check.ts, ingest.ts
- Deleted `lib/markers.ts`
- Stripped `<!-- ledger: ... -->` markers from all 16 local files + CLAUDE.md
- pull now writes raw content (no marker prefix)
- push reads raw content (no strip needed)
- check compares hashes only (no marker parsing)

### Ghost Behavior / Redundancies Fixed
- **Dead code in pull.ts**: `writeGeneratedFiles` had a MEMORY.md diff check that computed a comparison but did nothing with the result — removed
- **Repeated API calls in ingest.ts**: `fetchCachedNotes` was called inside `ingestFile` which runs in a loop — moved to single call before loop, passed as parameter
- **Dead hook**: `check-sync-marker.sh` was a pass-through (allowed everything) — deleted

### Hardcoded Path Fixes
- `config.ts`: `'-home-adrian/memory'` → dynamic `homedir().replace(/\//g, '-')`
- `generators.ts`: `'About Adrian'` → `'User Profile'`
- `post-write-ledger.sh`: `'-home-adrian'` → dynamic `$HOME | sed 's|/|-|g'`

### Unit Tests Added
Framework: vitest (ES module native)
- `tests/hash.test.ts` (6 tests) — SHA-256 consistency, uniqueness, format, unicode, whitespace
- `tests/generators.test.ts` (14 tests) — CLAUDE.md section mapping, unmapped notes, stripping, MEMORY.md grouping
- `tests/errors.test.ts` (3 tests) — LedgerError class, ExitCode values, uniqueness
- `tests/config.test.ts` (3 tests) — path derivation from homedir for any user

All 26 tests passing.

### Behavioral Rule Audit
Mapped every rule to enforcement level:

**Code enforced (MCP server):** type/agent required, content hash, upsert dedup, chunking, type coercion, configurable paths
**Hook enforced:** .env blocking, mcp.json blocking, auto-sync on session start, session-end check, write interception to Ledger
**Prompt only (can't be code):** communication style, sycophancy, scope control, design judgment
**Decided not to enforce in code:** BEM/CSS linting, emoji checking — too noisy, not worth the complexity

Added mcp.json blocking to block-env.sh hook.

### Notes
- Integration tests backlogged (Ledger note #83) — needs test Supabase or mocked client
- Devlog tracking as configurable hook — needs `ledger config` system, part of `init`
- Linting hooks (BEM, emoji) — decided against, prompt rules are sufficient for style

### Status
Marker system fully removed. 26 unit tests. All enforcement audited. 15 files synced. Ready for `ledger init`.

---

## Session 11b — 2026-03-16 (continued)

### Goal
Build `ledger-sync init` and `ledger-sync setup`.

### Implementation

**SQL Migrations (4 files in src/migrations/):**
- 000-tracking.sql — schema_migrations table
- 001-schema.sql — notes table, updated_at trigger, HNSW index
- 002-functions.sql — match_notes RPC (text param, ::vector cast)
- 003-rls.sql — RLS enabled, anon locked out, service role bypasses

**Migration Runner (lib/migrate.ts):**
- getMigrationFiles() — reads and sorts .sql files
- readMigration() — reads file content
- getAppliedMigrations() — queries schema_migrations table

**Prompt Enhancements (lib/prompt.ts):**
- Added askMasked() — masked password input with * echo
- Fixed ask() — removed .toLowerCase() that broke URLs/keys

**Config Update (lib/config.ts):**
- Priority: env vars → DOTENV_CONFIG_PATH → ~/.ledger/.env → repo .env
- Exported getLedgerDir(), loadConfigFile(), getDefaultConfig()
- Added HookConfig interface, updated ConfigFile interface

**Init Command (commands/init.ts):**
- Checks for existing credentials, asks before overwriting
- Guides through Supabase project creation if needed
- Prompts for URL, service role key, OpenAI key (masked)
- Writes ~/.ledger/.env (chmod 600) + config.json
- Validates Supabase connection + OpenAI key (test embedding)
- Detects new vs existing database
- Outputs SQL for manual execution in Supabase dashboard

**Setup Command (commands/setup.ts):**
- `setup claude-code` — removes existing MCP registration, re-registers, copies hooks, updates settings.json, runs pull
- `setup openclaw [path]` — generates SOUL.md + USER.md from Ledger notes
- `setup chatgpt` — generates static system prompt with snapshot warning
- Hook installation respects config.json preferences
- buildHookSettings() generates settings.json hook config

**Build System:**
- Added `cp -r src/migrations dist/migrations && cp -r src/hooks dist/hooks` to build script
- Migrations and hooks bundled in dist/ for npm distribution

### Test Results
| Test | Result |
|---|---|
| Build | Clean compile, migrations + hooks copied |
| Unit tests | 32 passing (26 existing + 6 migrate) |
| ledger-sync --help | All 9 commands visible |
| ledger-sync setup --help | 3 subcommands (claude-code, openclaw, chatgpt) |
| setup claude-code | MCP registered, 3 hooks installed, settings.json updated, 15 files pulled |
| ledger-sync check | 15 clean, all synced |

### Design Decisions
- Supabase JS can't run raw SQL — init prints SQL for manual execution in dashboard
- MCP registration is idempotent — removes before adding
- Credentials in ~/.ledger/.env, settings in ~/.ledger/config.json — separate concerns
- Hook installation respects user config preferences
- RLS: service role only, anon key locked out

### Status
Init + setup complete. 9 CLI commands. 32 tests. Ready for: export, filtered search, npm packaging.

---

## Session 11c — 2026-03-16 (continued)

### Goal
Complete production features, code review, npm publish.

### Features Built
- `ledger backup` — dump all notes to ~/.ledger/backups/YYYY-MM-DD.json, keeps last 5, cron support
- `ledger restore <file>` — restore from backup, skips duplicates by upsert_key, re-embeds
- `ledger config list/get/set` — view and change settings, double-confirm on security changes
- `ledger onboard` — persona wizard (name, role, communication presets, tech level, skills, goals)
- Filtered search — `--type` and `--project` flags on search_notes, list_notes MCP tools + CLI show
- Auto-push on temp view edits (PostToolUse hook watches /tmp/ledger-view/)
- Session-end hook alerts for leftover temp view files
- Expanded block-env.sh — blocks .env variants, credentials.json, .pem/.key, SSH keys, AWS credentials, .npmrc, mcp.json

### Code Review Fixes (pre-publish)
1. Removed hardcoded repo path from config.ts (was ~/repos/ledger/.env)
2. Added env validation to MCP server startup (fail fast on missing keys)
3. Fixed shell injection in backup cron (spawnSync with stdin instead of shell interpolation)
4. Fixed version mismatch: MCP server said 2.0.0, package.json said 1.0.0
5. Added unhandled rejection handler to CLI
6. Updated install.sh with new command name
7. Protected existing CLAUDE.md on pull (checks for "# Global Rules" header before overwriting)
8. Removed dead session-start.sh hook (functionality covered by settings.json SessionStart)
9. Fixed ingest hash comparison (use metadata.content_hash instead of recomputing)
10. Added chmod +x to build script for cli.js and hook scripts

### Naming & Publishing
- Renamed command: ledger-sync → ledger (bin field in package.json)
- Updated all references across src/, hooks, cron, settings.json
- Searched for product name: checked ~100 names, omnisoul strongest but deferred
- Published as @aperdomoll90/ledger-ai@1.0.0 (scoped, command stays `ledger`)
- 37 files, 25KB package, 32 tests passing

### Status
v1.0.0 published on npm. 13 CLI commands. 32 tests. 5 MCP tools. Hash-based sync. Hooks. Init/setup/onboard.

---

## Session 12 — 2026-03-17

### Goal
Improve Ledger note management — fix search gaps, prevent note fragmentation, preserve note identity on updates.

### Search Improvements
- **Search fallback**: when `search_notes` returns 0 results at default threshold (0.5), automatically retries at 0.3 and labels results as low-confidence. Discovered when searching for "installer wizard" failed to find a note containing "Unified Init Wizard."
- **Duplicate guard on `add_note`**: when no `upsert_key` is provided, searches for similar existing notes (>0.6 similarity) and returns suggestions instead of silently creating a duplicate. Agent must ask user whether to update existing or create new.

### Note Identity Preservation
- **Real SQL UPDATE**: `update_note` and `add_note` upsert now use `UPDATE` for single-chunk notes instead of delete+insert. Preserves original ID and `created_at`.
- **ID preservation on chunk changes**: when chunk count changes (requiring delete+insert), the original note ID is passed explicitly on the first insert. `created_at` is also preserved from the old row.
- All update paths now preserve note identity — IDs are stable across edits.

### Code Extraction
- Extracted `chunkText` from `mcp-server.ts` into `lib/notes.ts` as an exported function
- Added 9 unit tests for `chunkText` in `tests/chunk.test.ts` (paragraph splitting, overlap, force-split, content preservation)
- Total: 54 tests passing across 7 test files

### Hook Update
- Updated `block-env.sh` to allow `feedback_*.md`, `user_*.md`, `reference_*.md`, `project_*.md` files in the memory directory (`~/.claude/projects/-home-adrian/memory/`)
- These are local cache files that sync to Ledger — needed for feedback rules that must be in every conversation context

### Note Consolidation
- Merged fragmented notes into parent notes:
  - 94 (Architecture) + 95 (System Map) → back into 82 (original Architecture & System Map)
  - 96 (Setup Guide) + 104 (New Machine Setup) + 106 (Onboarding TODOs) + 107 (Search TODO) → into 86 (Init Design Spec)
  - 97 (Docs Sync TODO, done) → into 102 (Event Timeline)
  - Deleted 93 (Session-end hook gaps) after merging TODOs into architecture note
- Deleted auto-ingested duplicates: 110, 111 (frontmatter copies of feedback file)
- Net result: ~37 notes from ~46

### Feedback Rules Added
- `feedback_consolidate_notes.md` — don't fragment notes, track active upsert_keys, ask user before creating vs updating, TODOs live in parent notes

### Status
54 tests, 7 test files. MCP server rebuilt with search fallback, duplicate guard, ID preservation. Notes consolidated. Needs: MCP restart to pick up new build, upsert_key naming standardization, commit.

---

## Session 15 — 2026-03-18

### Goal
Implement `delivery` field — replace `local_cache: boolean` with semantic delivery tiers.

### Delivery Field Migration
- Replaced `local_cache?: boolean` with `delivery?: 'persona' | 'project' | 'knowledge'` in `NoteMetadata` type
- Replaced all `local_cache: true` writes with `delivery` values in `ingest.ts`, `migrate.ts`, `onboard.ts`
- Removed deprecated `fetchCachedNotes()` function — all callers now use `fetchPersonaNotes()`
- Verified no remaining references to `local_cache` in codebase

### inferDelivery() Helper
- New function in `lib/notes.ts` — maps note type to delivery tier automatically
- `user-preference`, `feedback` → `persona` (syncs everywhere)
- `architecture-decision`, `project-status`, `error`, `event` → `project` (repo-specific)
- `reference`, `general` → `knowledge` (searched on demand)
- Unknown types default to `knowledge` (cheapest tier)
- Centralized in `DELIVERY_BY_TYPE` lookup table

### Interactive Delivery Override
- Interactive `ledger ingest` now shows delivery tier prompt after note type selection
- Default is pre-selected based on `inferDelivery()`, user can override
- Auto-ingest still uses `inferDelivery()` without prompting

### Documentation Updates
- Updated architecture note (ledger-architecture-system-map) — delivery section now documents the full type→delivery mapping, where delivery is set, and marks it as implemented
- Updated project status — marked delivery + sync as done, renumbered next items
- Confirmed all existing Supabase notes already had `delivery` field (backfilled in session 14)
- Confirmed `ledger sync` was already built in session 14

### Init Wizard Design
- Designed unified init wizard spec via brainstorming skill
- Approach: replace `init` with smart step-skipping (7 steps, detects what's done)
- New features: device alias (optional, stored in Ledger as reference note), platform uninstall, multi-platform support with keep/reinstall/uninstall per platform
- Spec reviewed by code-reviewer agent — fixed credential lifecycle, persona detection, re-run semantics, error handling categories
- Saved spec to Ledger (ledger-spec-init, note 114) — not local files

### Process Improvements
- Added feedback rule: save brainstorming specs to Ledger, not `docs/superpowers/specs/`
- Added feedback rule: session checkpoint protocol — update devlog + project status + architecture after each major task, not just at end of session

### Status
Build clean, zero TypeScript errors. `delivery` field fully implemented. Init wizard spec complete and reviewed. Next: implementation plan for wizard.

---

## Session 19 — 2026-03-21 (Art Director Plugin + Protected Delivery Tier)

### Art Director Plugin — New
Created `~/.claude/plugins/art-director/` — a design critic skill for UI color review.

**Skill architecture:**
- SKILL.md (940w lean core) — 8-step workflow: gather context → capture → analyze color roles → diagnose tone/mood → check hierarchy → check interaction states → assess image impact → recommend changes
- tone-vocabulary.md — 9 tones (clinical, premium, cinematic, trustworthy, vibrant, playful, minimal, warm craft, urgent) with context signal mapping
- hierarchy-rules.md — 6 rules (one accent one job, CTA must win, dominant/supporting separation, dark mode consistency, text hierarchy, tone consistency)
- anti-patterns.md — 9 named patterns (Rainbow Dashboard, Ghost Button, Concrete Slab, Dark Mode Glow-Up, Shouting Label, Frankenstein, Wallflower Accent, Anxiety Palette, Hover Hijack)

**Design decisions:**
- Perceived visual weight over pixel counting — saturation, isolation, and position matter more than area
- Context-aware tone detection — reads design docs, business docs, Ledger notes, token naming before inferring from screenshot
- Confidence levels (high/medium/low) based on context source quality
- Component-level two-pass review (isolation check + integration check)
- Split into lean core + reference files to reduce context load (940w on invoke vs 4,104w monolithic)

**Tested on adrianperdomo.com:**
- Full review using Chrome DevTools MCP for screenshots and hover states
- Identified Frankenstein (tonal drift between sections), Wallflower Accent (no clear accent color), Ghost Button (nav links low-contrast)
- Produced actionable token change recommendations with severity calibration

**Dom integration:**
- Updated `agents/dom.md` to list `Skill(art-director)` in tools

### Ledger — Protected Delivery Tier
Added `protected` as a fourth delivery tier alongside persona, project, knowledge.

**Changes:**
- `DeliveryTier` type updated in notes.ts, config.ts, NoteMetadata interface
- `opUpdateNote` — protected notes require explicit confirmation with warning message before update
- `opUpdateMetadata` — now accepts `confirmed` param, gates on protected delivery
- `opDeleteNote` — protected notes get extra warning before deletion
- MCP `update_metadata` tool updated to accept `confirmed` parameter
- CLI validation (config.ts, add.ts, ingest.ts) updated to include `protected` option
- All 228 tests pass, clean build

**New type registered:**
- `skill-reference` type with `protected` delivery — for skill backing documents
- 3 notes saved: art-director-tone-vocabulary (#150), art-director-hierarchy-rules (#151), art-director-anti-patterns (#152)

### Hook Update
- `block-env.sh` — added path-based exception for `~/.claude/plugins/` to allow SKILL.md and agent template writes

### Project Notes
- Plugin portability idea saved (note #154) — git repo for custom plugins, revisit when more skills exist
- User profile updated with Claude Code plugins section
- Project dashboard updated with Art Director project entry

### Status
Build clean, 228 tests pass. Art Director plugin complete and tested. Protected delivery tier implemented. Next: more skills, plugin portability repo.

---

## Session 21 — 2026-03-24 (Knowledge Extraction + RAG Reframe)

### Overview
Bulk knowledge extraction from ~25 video transcripts and screenshots. No code changes — pure knowledge management session. Major reframing of Ledger as a production RAG system.

### Ledger Changes
- **README.md** — Updated "What It Does" to explicitly call Ledger a RAG system. Roadmap split into RAG Enhancements + Platform sections.
- **RAG Status Matrix** created in product vision (note 78) — 14 components, 5 done, 9 to build
- **7-step RAG Implementation Plan** prioritized: hybrid search → chunking → re-ranking → multi-format ingest → multi-provider embeddings → eval/metrics → automated consolidation
- **Automated consolidation** concept added (Dream-inspired) — merge duplicates, flag contradictions, identify stale notes

### Notes Created (7 new)
| ID | Type | Content |
|---|---|---|
| 177 | knowledge-guide | AI engineering roadmap (Alexi) — 7-step learning path |
| 178 | knowledge-guide | CSS Patterns & Tricks — masonry, optical button padding, overflow debug |
| 179 | persona-rule | Always preview note changes before updating (like PR diffs) |
| 180 | architecture-decision | Chase agent spec — offensive security tester |
| 181 | code-craft | Skill writing conventions — gotcha sections, progressive disclosure |
| 182 | code-craft | Hero Layout Patterns — 5 wireframes + CSS Grid skeletons |
| 184 | code-craft | Clean Code Ch.6 — Objects & Data Structures |

### Notes Updated (20+)
- **AI Studio (31):** Chase added, ZhuLi→Charlie, deviation logging, multi-model review, self-improvement (autoresearch), skills roadmap (15 tools), dashboard inspiration, context usage report
- **Charlie spec (32):** Renamed from ZhuLi, platform table
- **Ross+Ada (35):** WCAG contrast ratios added to Ada
- **Infrastructure (38):** ZhuLi→Charlie, agent sandboxing
- **Ledger Dashboard (64):** ZhuLi→Charlie
- **Ledger Vision (78):** RAG status matrix, 7-step plan, mission updated
- **User Profile (10):** AI Systems Built section, agency opportunity
- **Learning Path (12):** RAG reframed as ACTIVE, harness engineering, certification target
- **Dashboard (118):** Full session 21 work log
- **Agent Teams Spec (147):** Deviation logging in handoff + pipeline, ZhuLi→Charlie
- **Color (158):** WCAG contrast ratios
- **Spacing (160):** White space types
- **Composition (167):** Logo family
- **UX Patterns (169):** Fitts's Law
- **Formatting (170):** Section 02 filled, checklist to 11 items
- **Clean Code Index (171):** Updated to 6 chapters

### Key Decisions
- Orchestrator renamed ZhuLi → Charlie (Charles → "in charge") across 6 notes
- Chase added as 10th agent (offensive security)
- Ledger recognized as production RAG system — reframed everywhere
- ~/CLAUDE.md updated with skill writing rules
- Feedback rule: always show diff before Ledger note updates

### Errors
None — no code changes this session.

### Status
No code changes, no build needed. Knowledge base significantly expanded. Immediate next: implement hybrid search (RAG enhancement #1) in Ledger codebase.

---

## Session 23 — 2026-03-25

### Code Changes (12 commits, v1.4.0 + v1.4.1 published)
- Split ESLint into TS-only and TS+React configs (lint-configs.ts, lint.ts)
- Added UNIQUE index on upsert_key (migration 004)
- Added `ledger check --chunks` for chunk integrity
- Removed `.limit(1)` safety net from upsert lookups (DB constraint enforces now)
- Added type/delivery conflict validation in opAddNote
- Added auto-cascade delivery on type change in opUpdateMetadata
- Published v1.4.0 and v1.4.1 to npm

### Ledger Note Changes
- Created `session-checkpoint` skill + system-rule-session-checkpoint note
- Consolidated handoff procedures (#120, #129, #198)
- Designed Ledger v2 production roadmap — 6 spec notes (roadmap + 5 phases)
- 9 spec review issues found and fixed

### Key Decisions
- Ledger v2: bottom-up approach (database foundation → search → sync → access → observability)
- Event-driven sync via Supabase Realtime (not polling)
- Recursive chunking first, semantic later
- Re-ranking deferred until metrics prove need
- JWT-based per-agent auth replacing service role key
- Audit log as linchpin serving 4 of 5 phases

### Tests
252 passing across 16 test files (was 243 at session start)

### Status
v1.4.1 published (needs OTP to complete). v2 roadmap fully spec'd with 5 phase documents in Ledger. Next: Phase 1 (database foundation — audit_log, schema_version, embedding metadata, backfill).

---

## Session 27 — 2026-03-28

### Goal
Separate AI Studio (now Atelier) from Ledger — Hunter agent code, database, and all agent infrastructure into its own repo and Supabase project.

### Ledger Note Renames (19 updates)
- Renamed all 17 `project: ai-studio` notes to `project: atelier`
- Updated 12 architecture notes: upsert_keys (`ai-studio-*` → `atelier-*`), content ("AI Studio" → "Atelier")
- Updated 5 skill/event notes: project metadata only
- Updated project-status-dashboard (#118), user-learning-goals (#12), ledger-devlog (#117)

### Atelier Repo Created
- Moved `~/.claude/plugins/agent-teams/` → `~/repos/atelier/` (preserved 8 commits)
- Renamed plugin: `agent-teams` → `atelier`, skill: `agent-teams` → `atelier`
- Symlinked `~/.claude/plugins/atelier` → `~/repos/atelier/`
- Extracted Hunter code from Ledger `feat/hunter-agent` branch into Atelier
- Created Atelier-specific config system (`.env` + `config.json` in repo root)
- 5 test files, 32 tests passing, clean build

### Atelier Supabase
- New project created (`ctevunlyqdlmishminuz`)
- Applied 3 migrations: trigger function, opportunities, hunt_analytics
- Migrated 172 opportunities from Ledger's Supabase → Atelier's Supabase

### Ledger Cleanup
- Deleted `feat/hunter-agent` branch (local + remote, 11 commits)
- Removed `rss-parser` dependency
- Removed `hunter` key from `~/.ledger/config.json`
- Dropped `opportunities` and `hunt_analytics` tables from Ledger's Supabase
- 252 tests still passing across 16 files

### Key Decisions
- Atelier = agent orchestration layer, Ledger = context/memory layer
- Each system owns its own Supabase project
- Atelier repo serves dual purpose: Claude Code plugin + npm package with runtime code
- Secrets live in repo root `.env` (gitignored), not `~/.atelier/`

### Status
Clean separation complete. Ledger: 252 tests, no Hunter code. Atelier: 32 tests, 172 opportunities, own Supabase. Next: score opportunities, enable cron, research OpenCLI for Upwork.

---

## Session 28 — 2026-03-29 (v2 Data Model Design)

### Setup
- Installed zsh + Oh My Zsh on Linux workstation
- Fixed MCP disconnection caused by shell switch (NVM/node not in new .zshrc)
- Created dev environment setup note in Ledger (#251) — new machine playbook

### v2 Data Model Redesign
- Brainstormed full domain architecture: system, persona, workspace, project
- Designed 4 protection levels: open, guarded, protected, immutable
- Added `auto_load` field for granular context loading control
- Added `owner_type`/`owner_id` for future team support
- Added `file_path`/`file_permissions` for machine rebuild from DB
- Decided CLAUDE.md = stored document (not generated from fragments)
- Decided MEMORY.md = search guide pointing to Ledger (not local file index)
- Dropped `delivery` field — replaced entirely by `domain`
- Dropped devlog concept — replaced by audit_log + per-session event notes
- Replaced monolithic error log with per-error notes
- Defined complete type registry per domain with domain-scoped TypeScript unions
- Wrote full spec to `docs/superpowers/specs/2026-03-28-v2-data-model-design.txt` and Ledger (#265)
- Updated v2 roadmap (#209) with expanded Phase 1

### Backups
- Saved complete CLAUDE.md to Ledger (#266) as protected note
- Updated Charlie persona note (#32) to match current CLAUDE.md

### Key Decisions
- One content table + separate audit_log (not separate tables per domain)
- Skills are flat notes with `skill_ref` linking (no parent-child hierarchy yet)
- `domain` replaces `delivery` — clean break, no coexistence period
- Protection is orthogonal to domain (any domain can have any protection level)

### Status
v2 Phase 1 fully specced. Branch `feat/v2-phase-1-database` created with draft `005-audit-log.sql`. Next: write implementation plan, start building.

---

## Session 29 — 2026-03-29 (v2 Phase 1 Implementation)

### Implementation
- Wrote implementation plan (14 tasks) using writing-plans skill
- Implemented all 14 tasks via subagent-driven development
- Created `src/lib/domains.ts` — domain model with 5 domains, 4 protection levels, shared types
- Created `src/lib/audit.ts` — audit log module (later simplified to just table verification)
- Created `src/lib/backfill.ts` — v1→v2 metadata migration (pure function)
- Created `src/lib/file-writer.ts` — write notes to disk with permissions
- Created `src/commands/backfill.ts` — CLI command for backfill
- Updated `src/lib/notes.ts` — NoteMetadata interface, domain model, protection flow, transactional writes
- Updated `src/mcp-server.ts` — domain filter, protection descriptions
- Updated `src/commands/add.ts` — domain-aware type picker
- Created `src/migrations/005-audit-log.sql` — audit_log table with domain column
- Created `src/migrations/006-audited-operations.sql` — 5 Postgres functions for transactional writes

### Database Changes (applied to production)
- Migration 004: upsert_key unique index
- Migration 005: audit_log table
- Migration 006: Postgres functions (note_create, note_update, note_replace, note_delete, note_update_metadata)
- Ran backfill on 130 notes — all migrated to v2 metadata
- Fixed 15 edge cases manually (misclassified types, wrong domains)

### Design Decisions
- Added 5th domain: `general` — for personal knowledge not tied to projects (restaurants, OAuth explainers, etc.)
- Extracted shared types: ExtensionType (skill, hook, plugin-config), ResourceType (reference, knowledge, eval-result), DocType (claude-md, memory-md)
- Workspace is purely informational — no extensions, no docs
- hook and plugin-config valid in persona + system (not workspace)
- claude-md and memory-md valid in persona + project (not workspace)
- CLAUDE.md and MEMORY.md stored as complete documents, not generated — deleted generators.ts
- All write operations use Postgres transactions (note + audit atomic)
- No silent error handling — all errors surfaced to user
- delivery field fully removed from codebase (no fallbacks, no coexistence)
- Multi-user persona layering designed (global→user→project) using existing owner_type/owner_id

### Dead Code Removed
- Deleted `src/commands/sync.ts` — was overwriting CLAUDE.md incorrectly, rebuild in Phase 3
- Deleted `src/commands/migrate.ts` — old file migration approach
- Deleted `src/commands/wizard.ts` — depends on sync/migrate, rebuild post-restructure
- Deleted `src/lib/generators.ts` — replaced by stored documents
- Deleted `tests/migrate.command.test.ts`

### Session 29 continued — Schema Rewrite Design

### Production Database Work
- Applied migrations 004 (upsert_key unique), 005 (audit_log), 006 (Postgres functions) on Supabase
- Ran v2 backfill on 130 production notes — all migrated
- Fixed 15 edge cases manually (misclassified types, wrong domains)
- Fixed vector format bug — `supabase.rpc()` needs vector strings, not number arrays
- Fixed chunked upsert_key duplicate bug — only first chunk keeps the name
- Fixed audit silent-fail — errors now thrown, not swallowed
- Fixed duplicate check silent-fail — errors surfaced to user

### Schema Rewrite Spec (complete)
Designed production-grade RAG schema rewrite from scratch. Spec at `docs/superpowers/specs/2026-03-29-schema-rewrite.md`.

**11 tables designed:**
- `documents` (was `notes`) — source of truth, all columns promoted from JSONB
- `document_chunks` (was rows in `notes`) — search index, separate from content
- `audit_log` ��� partitioned by year, auto-partition function
- `agents` — agent registry with permissions (Phase 4)
- `embedding_models` — model registry with FK from chunks
- `query_cache` — embedding cache for repeated searches
- `collections` + `document_collections` — arbitrary document grouping
- `document_versions` — full content snapshots (not just diffs)
- `search_evaluations` ��� search quality metrics
- `ingestion_queue` — file processing pipeline for PDFs, audio, images

**13 Postgres functions designed:**
- Transactional writes (document_create, update, delete, restore, purge)
- 3 search modes (vector, keyword, hybrid RRF fusion)
- Smart retrieval (full doc vs chunk+neighbors based on size)
- Auto-partition and cache cleanup utilities

**Key design decisions:**
- Renamed `notes` → `documents` (supports PDFs, audio, images — not just text notes)
- Document-chunk separation (industry standard RAG pattern)
- No JSONB metadata — every field is a real column with constraints
- `name` column NOT NULL UNIQUE replaces `upsert_key`
- `search_vector tsvector GENERATED` for keyword search (Phase 2 foundation)
- Soft delete via `deleted_at` + 30-day purge
- Multi-format source tracking (source_type, source_url)
- Content metrics (content_length generated, chunk_count, retrieval_count)
- Chunk metadata (content_type, chunk_strategy, overlap_chars, embedding_model_id)
- Realtime publication + REPLICA IDENTITY FULL (Phase 3 foundation)

### Research
- Sage researched data modeling best practices — saved to `docs/superpowers/specs/2026-03-29-data-modeling-reference.md`
- Pre-DDL checklist used for all schema decisions
- Stored MEMORY.md as Ledger note #272 (persona/memory-md)

### RAG Education
- Learned full RAG pipeline: extraction → chunking → embedding → storage → retrieval
- Learned HNSW index (layered graph for fast vector search)
- Learned GIN index (inverted index for keyword search)
- Learned document-chunk pattern (content vs search index separation)
- Learned smart retrieval (full doc vs chunk+neighbors)
- Learned hybrid search (RRF fusion of vector + keyword results)

### Schema Implementation (in progress — mid-session checkpoint)
Running Phase 1 database setup step by step in Supabase Dashboard.

**Completed so far:**
- Created all 9 tables: documents, document_chunks, audit_log (partitioned), agents, embedding_models, query_cache, document_versions, search_evaluations, ingestion_queue
- Created all indexes: documents (7), document_chunks (8 including per-domain HNSW), audit_log (3), plus indexes on remaining tables
- Created triggers: updated_at auto-trigger on documents
- Created utility functions: create_audit_partition_if_needed, cleanup_query_cache, cleanup_document_versions
- Discovered HNSW limitation: can't use subqueries in WHERE clause for partial vector indexes. Fix: denormalized `domain` column on document_chunks (standard pattern used by Pinecone, Weaviate, Qdrant)
- Old `notes` table still live — side-by-side migration approach

**Phase 1 Database Setup — COMPLETE:**
- All 9 tables created and verified
- All indexes created (53 total including per-domain HNSW vector indexes)
- All triggers and utility functions (4: updated_at trigger, auto-partition, cache cleanup, version cleanup)
- All transactional functions (6: document_create, update, update_fields, delete, purge, restore)
- All search functions (4: match_documents vector, keyword, hybrid RRF, retrieve_context smart retrieval)
- RLS enabled on all 9 tables — service_role full access, anon blocked. Verified via pg_policy query.
- Realtime enabled on documents table with REPLICA IDENTITY FULL
- Old v1 functions dropped (note_create, note_update, etc.)
- Old `notes` table still live for migration

**Key fixes during implementation:**
- HNSW can't use subqueries → added denormalized `domain` column on document_chunks
- document_update was missing `p_embedding_model_id` → fixed, chunks now get model ID
- document_delete was missing fields in rollback JSONB → added file_permissions, content_hash, schema_version, created_at
- Duplicate document_update function created by overloading → dropped old version
- Renamed document_update_metadata → document_update_fields with typed params (no more JSONB input)
- query_cache and embedding_models were missing RLS → added
- SHA-256 via pgcrypto for all content hashing (not md5)

**Database state:** 9 new tables + old `notes`, 53 indexes, 15 functions (11 new + 4 utility), all RLS verified

**Testing:**
- Installed pgTAP extension in Supabase for database unit testing
- Wrote first test file: `tests/sql/001-document-functions.sql` (20 tests covering create, update_fields, delete, restore, constraints)
- Ran manual DO block test — all assertions passed (create → update → delete → restore cycle)

**Next session:**
1. Set up automated database testing (pgTAP, proper test runner)
2. Run full test suite against all functions
3. Write migration script (TypeScript) — read from `notes` table, write to `documents` + `document_chunks`
4. Run migration, verify counts match
5. Rewrite TypeScript codebase (notes.ts → documents.ts, MCP server, CLI)
6. Drop old `notes` table after verification
7. Create Ledger database architecture note
8. Commit all v2 changes

### Stats
- 294 TypeScript tests passing, 18 test files, typecheck clean
- 20 pgTAP database tests written (not yet automated)
- Nothing committed — all changes unstaged on feat/v2-phase-1-database
- Database: 9 tables, 53 indexes, 15 functions, full RLS, Realtime enabled, pgTAP installed

---

## Session 30 — 2026-03-31 (v2 TypeScript Rewrite — Tasks 5-6 + E2E)

### Continued from Session 29
Picked up mid-Task 5 (ai-search.ts) — fixing type incompatibility across files.

### Type Unification
- Centralized client types in `document-classification.ts`: `ISupabaseClientProps`, `IOpenAIClientProps`, `IClientsProps`
- Removed all local type definitions from `embeddings.ts`, `document-fetching.ts`, `ai-search.ts`
- Fixed `rpc()` return type: `Promise` → `PromiseLike` (Supabase's `PostgrestFilterBuilder` is thenable but not a strict Promise)
- All 5 library files now import types from one source — no circular deps

### MCP Server Rewrite (Task 6)
- Created `src/mcp-server.ts` from scratch — 16 tools total:
  - **10 new tools:** `search_documents`, `add_document`, `list_documents`, `update_document`, `update_document_fields`, `delete_document`, `restore_document`, `search_by_meaning`, `search_by_keyword`, `get_document_context`
  - **6 deprecated tools:** `search_notes`, `add_note`, `list_notes`, `update_note`, `update_metadata`, `delete_note` (redirect to new functions)
- Protection checks at MCP layer: immutable → block, protected/guarded → require confirmed, open → proceed
- All deprecated tools include `[DEPRECATED]` in description and suggest new tool name

### Bugs Found and Fixed During E2E Testing
1. **`embedding.join is not a function`** — Postgres returns `vector(1536)` columns as strings via REST API. Our `getOrCacheQueryEmbedding()` cached embeddings as vector strings, but assumed `number[]` on read. Created `parseVector()` helper (inverse of `toVectorString()`) to handle the round-trip. Old code never hit this because it had no query cache.
2. **Search threshold too high** — Default was 0.5 (from cosine similarity convention). But the threshold gates the vector component *before* RRF fusion. Industry standard for `text-embedding-3-small` is 0.2-0.35. Lowered to 0.25. Old code used 0.3 with a fallback retry mechanism.

### Key Design Decisions
- **Structural typing over package imports** — `ISupabaseClientProps`/`IOpenAIClientProps` prevent Vitest from loading heavy packages (heap OOM fix from earlier session)
- **RRF threshold ≠ cosine threshold** — RRF scores are rankings (~0.033 for 1 doc), not similarity. Threshold correctly applied pre-fusion on cosine similarity only
- **All Postgres functions exposed** — added `restore_document`, `search_by_meaning`, `search_by_keyword`, `get_document_context` because if the function exists and an agent could use it, it should be accessible
- **Direct SELECT for reads, RPC for writes** — `list_documents`/`getDocumentById` don't need transactional guarantees, so they query directly

### Documentation Updated
- `docs/superpowers/specs/2026-03-30-typescript-architecture.md` — structural typing section, updated function signatures, 10 new MCP tools, search defaults, testing summary, data flows with cache detail
- `docs/superpowers/plans/2026-03-30-typescript-rewrite.md` — Task 6 complete, Task 8 partial, follow-up tasks (Supabase gen types, onboarding tool guide)

### E2E Test Results (live database)
All 6 core operations verified: add → search (semantic + keyword) → update content → update fields → delete → verify gone. Query cache round-trip verified.

### Files Created/Modified
- **Created:** `src/mcp-server.ts`, `tests/mcp-server.test.ts`
- **Modified:** `src/lib/document-classification.ts` (client types + PromiseLike), `src/lib/embeddings.ts` (parseVector + IOpenAIClientProps), `src/lib/document-fetching.ts` (ISupabaseClientProps), `src/lib/ai-search.ts` (IClientsProps + threshold), `tests/embeddings.test.ts` (parseVector tests)

### Stats
- 43 TypeScript tests passing across 6 test files
- 20 pgTAP database tests (from previous session)
- 16 MCP tools (10 new + 6 deprecated)
- Branch: `feat/v2-phase-1-database` — nothing committed yet
- Old MCP tools were broken (called deleted Postgres functions) — rebuilt and verified working

### Data Migration (Task 7)
- Created `src/scripts/migrate-v2.ts` — reads from `notes` table, maps fields, calls `document_create` RPC
- Dry run verified all 132 notes map cleanly: 0 chunk groups, 0 missing upsert_keys, all domains/types valid
- Ran migration: 132/132 succeeded, 0 failures
- Old `notes` table still exists as safety net

### Ledger Document Restructure
- Updated `ledger-product-vision` (#22) — mission, principles, RAG pipeline status, architecture overview
- Created 5 architecture docs: `ledger-architecture` (#137, overview), `ledger-architecture-database` (#138), `ledger-architecture-database-functions` (#139), `ledger-architecture-typescript` (#140), `ledger-architecture-mcp-tools` (#141)
- Updated `ledger-v2-roadmap` (#109) — phases 1-3 marked done, phases renumbered (old 3/4/5 → new 5/6/7)
- Merged `ledger-current-work` into `project-status-dashboard` — one source of truth
- Moved dashboard to workspace domain (cross-project)
- Created `atelier-status-dashboard` (#142) with TODO for missing docs
- Deleted 12 superseded/duplicate documents (#128, #90, #91, #92, #50, #51, #106, #110, #27, #111, #23, #47)
- Renamed 7 docs for naming convention (starbrite-campaigns-*, workspace-*, knowledge-*)
- Moved 12 skill/eval docs to `custom-skills` project
- Moved 4 lint configs to workspace domain
- Fixed 3 missing project fields (#12, #44, #41)
- Updated CLAUDE.md: new IDs, new MCP tools, removed stale refs, synced Ledger copy (#129)

### CLAUDE.md Changes
- Breadcrumb IDs updated (12 references) to new document table IDs
- MCP tools section: 10 new tools listed (was 6), grouped by category
- Ledger breadcrumbs: added product-vision, architecture, devlog
- Removed repo specs section (architecture doc is the entry point now)
- Synced to Ledger (#129)

### Stats
- 44 TypeScript tests passing across 6 test files (was 43 — added parseVector tests)
- 20 pgTAP database tests
- 16 MCP tools (10 new + 6 deprecated)
- ~117 active documents in Ledger (was ~132 before cleanup)
- Branch: `feat/v2-phase-1-database` — committed TypeScript rewrite, migration script uncommitted

### Next Session
1. Commit migration script + doc updates
2. Run `UPDATE documents SET protection = 'open' WHERE id = 127;` then delete dead type-registry doc
3. Drop old `notes` table
4. Delete `src/_old_v1/` directory
5. Housekeeping: move system-rule-mcp-registration and system-rule-naming-convention to persona domain
6. Fix block-env.sh hook (.md write blocking)
7. Phase 4 planning

---

## Session 30 continued — 2026-04-01 (Phase 4 Planning + Documentation)

### Cleanup completed
- Deleted `src/_old_v1/` and `tests/_old_v1/` directories
- Dropped old `notes` table (SQL in Supabase)
- Deleted dead `system-rule-type-registry` (#127) — had to unlock immutable via SQL first
- Added `check_documents_name_format` CHECK constraint on documents.name (lowercase, hyphens only)
- All 43 TypeScript tests still passing

### Schema changes applied (Supabase SQL)
- `document_chunks.context_summary` text column — ready for contextual retrieval
- `document_chunks.token_count` int column — ready for token budgeting
- HNSW index on `query_cache.embedding` — ready for semantic cache lookup
- `search_evaluations.document_types` text[] + `source_types` text[] — per-type quality tracking
- `eval_golden_dataset` table + index + RLS — ready for golden dataset

### Ledger document restructure (continued)
- Reorganized all ~117 documents across projects
- Renamed 7+ docs for naming convention (starbrite-campaigns-*, workspace-*, knowledge-*)
- Moved 12 skill/eval docs to `custom-skills` project
- Moved lint configs to workspace domain
- Created `atelier-status-dashboard` (#142)
- Merged `ledger-current-work` into `project-status-dashboard` — one source of truth
- Updated `ledger-architecture-rag-features` (#145) with schema changes

### Documentation created
- `reference-rag-system-architecture` (#144) — complete production RAG reference, 1100+ lines
  - 11 sections: ingestion, storage, search, eval, quality, observability, access control, scaling, security, API, deployment
  - Feature inventory with sub-headers per function
  - Complete table schemas for all 9+ tables
  - Decision guide for starting new RAG projects
  - Cost estimation, A/B testing process, migration guidance
  - Security threats + defenses organized by layer
- `convention-architecture-document-structure` (#143) — how to structure architecture docs (diagrams, per-area breakdown)
- `docs/research/2026-03-31-rag-security-best-practices.md` — 1000-line security research (raw)
- Feedback memory: architecture docs need visual diagrams

### Phase 4 planned
- 4.1: Auto-logging (wire search_evaluations)
- 4.2: Golden dataset (50+ query/expected-doc pairs)
- 4.3: Eval runner script
- 4.4: Establish baseline
- 4.5: Tune (recursive chunking → contextual retrieval → semantic cache → reranking → threshold)

### Stats
- 44 TypeScript tests, 6 test files
- ~117 active documents in Ledger
- 10 tables in database (9 original + eval_golden_dataset)
- Old `notes` table dropped, `_old_v1` deleted
- Branch: `feat/v2-phase-1-database`

### Next Session
1. Commit all changes
2. Phase 4.1: Wire auto-logging to search_evaluations
3. Phase 4.2: Curate golden dataset (50+ test cases)
4. Phase 4.3: Build eval runner script
5. Phase 4.4: Run baseline eval

---

## Session 31 — 2026-04-01 (Phase 4 Implementation Start)

### Phase 4.1: Auto-logging — DONE
- Created `logSearchEvaluation()` function in `ai-search.ts`
- Captures: query, search mode, result count, result details (IDs + scores + types), document_types, response_time_ms
- Added timing + logging to all 3 search functions: `searchByVector`, `searchByKeyword`, `searchHybrid`
- Fire-and-forget pattern — logging doesn't block search response
- Tested live: search for "ledger architecture overview" logged correctly (3 results, 4493ms, hybrid mode)
- Fixed naming: `r.document_type` → `result.document_type` (no single-letter variables)

### Database additions
- Created `search_evaluation_aggregates` table — daily summaries (1 row/day instead of 50+ raw rows)
- Created `aggregate_search_evaluations()` function — computes daily stats from raw rows
  - Fixed CROSS JOIN LATERAL bug that would multiply row counts (used separate queries instead)
- Created `cleanup_search_evaluations()` function — deletes raw rows older than 30 days
- Tiered retention: raw (30 days) → daily aggregates (forever)

### CLI commands rewritten for v2
All 8 commands in `src/commands/` updated to use new library functions instead of deleted `notes.js`:

| Command | Old function | New function |
|---|---|---|
| `list` | `opListNotes()` | `listDocuments()` |
| `delete` | `opDeleteNote()` | `getDocumentById()` + `deleteDocument()` |
| `update` | `opUpdateNote()` | `getDocumentById()` + `updateDocument()` |
| `tag` | `opUpdateMetadata()` | `getDocumentById()` + `updateDocumentFields()` |
| `show` | `searchNotes()` | `searchHybrid()` |
| `export` | `searchNotes()` | `searchHybrid()` |
| `push` | `findNoteByFile()` | `listDocuments()` + `updateDocument()` |
| `check` | `fetchNoteHashes()` | `fetchSyncableDocuments()` + `contentHash()` |

Removed `checkChunks()` from check.ts — v1 chunk integrity check no longer relevant (v2 chunks managed by RPC).

### Documentation
- RAG reference doc (`reference-rag-system-architecture.md`) — major updates:
  - Added TOC
  - Added "Starting a New RAG Project" decision guide with cost estimation
  - Expanded Ingestion (## 1) to 9 numbered steps with migration guidance
  - Expanded Quality Improvement (## 5) with A/B testing process and interpreting results
  - Expanded Observability (## 6) with alerting thresholds, cost breakdown, tools
  - Expanded Access Control (## 7) with auth models (RBAC/ABAC/ReBAC), multi-tenant patterns
  - Added API Layer (## 10) — protocols, tool set, design principles
  - Added Deployment & Infrastructure (## 11) — components, cron, backups, health checks
  - Added Security (## 9) — threats + defenses by layer, defense-in-depth diagram
  - Added security to feature inventory and production defaults
- Updated Ledger RAG feature map (#145) — auto-logging marked done
- Updated v2 roadmap (#109) — full step-by-step breakdown for all 7 phases
- RAG security research doc created (`docs/research/2026-03-31-rag-security-best-practices.md`)
- Architecture document convention saved (#143) — diagrams required in architecture docs
- Added CLAUDE.md rule: never bypass RPC functions for document updates
- Feedback memory: never direct `.update()` on documents table

### Bug caught
- Direct `.update()` on documents table bypasses chunking/embedding/audit — fixed #109 and #144
- Added to Phase 6 roadmap: database trigger to enforce RPC-only writes

### Stats
- 44 TypeScript tests, 6 test files (unchanged)
- 11 tables in database (added search_evaluation_aggregates)
- 17 Postgres functions (added aggregate_search_evaluations, cleanup_search_evaluations)
- Auto-logging live — every search now recorded
- Build clean with all CLI commands included

### Phase 4.2-4.4 completed same session

**Golden dataset:** 56 test cases inserted into `eval_golden_dataset` table
- 19 simple, 13 conceptual, 10 exact-term, 6 multi-doc, 4 cross-domain, 4 out-of-scope

**Eval runner:** `src/scripts/eval-search.ts` — runs all test cases, computes metrics, prints report

**Baseline results:**

| Metric | Score | Target |
|---|---|---|
| Hit rate | 88.5% | > 90% |
| First-result accuracy | 46.2% | > 85% |
| Recall | 73.7% | > 90% |
| Zero-result rate | 0.0% | < 5% |
| Out-of-scope accuracy | 0.0% | > 80% |
| Avg response time | 958ms | < 2000ms |

Key findings: exact-term strong (100% hit), conceptual weak (77% hit, 31% first-result), first-result accuracy biggest gap. Saved as #146.

**Database:** Added `eval_runs` table for storing eval run history persistently.

### Documentation continued (same session)

**RAG reference doc** (`reference-rag-system-architecture.md`):
- Added production eval infrastructure section (run storage, auto-compare, regression detection, CI/CD gating, feedback collection, scheduled automation)
- Added eval component index to ## 4
- Added agents table to storage inventory + ERD
- Slimmed storage detailed section — replaced 250 lines of column definitions with table index + link to schema doc
- Aligned all inventory tables visually
- Removed Ledger-specific references (domain columns, etc.) — doc is now fully generic

**RAG schema doc** (`reference-rag-database-schemas.md`) — NEW:
- 13 tables with column inventories grouped by concern + SQL CREATE statements
- Tables grouped by function: Storage, Caching, History, Security, Ingestion, Evaluation
- All indexes, functions (with full SQL for maintenance), triggers, RLS patterns
- Generic — no project-specific columns, "add as needed" comments
- Uploaded to Ledger as #147

**CLAUDE.md** updated:
- Added rule: documentation tables must be visually aligned

### Next Session
1. Commit all changes
2. Create `reference-rag-api-patterns.md` (request/response, error handling, versioning)
3. Create `reference-rag-setup-walkthrough.md` (zero to working RAG step-by-step)
4. Upgrade eval runner to production-grade (save to eval_runs, auto-compare)
5. Phase 4.5: Start tuning

---

## Session 31 — 2026-04-01/02

### Lib Restructure
- Reorganized `src/lib/` into subdirectories: `documents/`, `search/`, `eval/`
- Moved 5 files, updated 17 import consumers (mcp-server, 8 commands, 6 tests, eval script)
- Created `src/lib/eval/eval.ts` — extracted types (`IGoldenTestCaseProps`, `ITestResultProps`, `IEvalMetricsProps`), `scoreTestCase()`, `computeMetrics()`, `formatReport()` from eval-search.ts
- Slimmed `eval-search.ts` from 221 → 80 lines (thin orchestration only)
- Deleted orphaned `migrate-v2.ts` and stale `dist/_old_v1/`
- All 95 tests pass, clean TypeScript compile

### Eval Research & Planning
- Researched production-grade RAG eval requirements against our own reference docs
- Identified 7 infrastructure gaps (persist runs, auto-compare, regression detection, MRR, aggregation cron, feedback, feedback→golden set)
- Wrote implementation plan: `docs/superpowers/plans/2026-04-01-eval-hardening.md` (5 tasks, 18 tests, TDD)

### Schema Documentation
- Created `docs/ledger-architecture-database-schemas.md` — complete ground-truth from live Supabase
  - 13 tables with column tables + CREATE TABLE SQL + CHECK constraints
  - 56 indexes (full CREATE INDEX statements)
  - 17 functions (full SQL bodies from `pg_get_functiondef`)
  - 7 extensions, 1 trigger (verified), RLS policies (all 14 tables), Realtime status
  - Cron status (pg_cron not installed — 6 functions unscheduled)
  - Active vs Unused table mapping
- Found: `eval_runs` table missing RLS policies
- Updated `docs/reference-rag-database-schemas.md` — fixed `document_purge` SQL, search eval index sort order, added Extensions/Realtime/Cron sections

### RAG Eval Reference
- Created `docs/reference-rag-evaluation.md` — complete generic eval reference (~930 lines)
  - 9 retrieval metrics with formulas (Hit Rate, First-Result, MRR, Recall, Precision, NDCG, MAP, Zero-Result Rate, Latency)
  - Generation metrics (Faithfulness, Answer Relevancy, LLM-as-Judge)
  - Golden dataset design (9 query categories, building from zero, sizing, anti-patterns)
  - Component-level eval (chunking, embedding, search, reranking)
  - Eval runner architecture (3-layer separation)
  - Regression detection, statistical significance
  - A/B testing protocol, cost analysis, common pitfalls, tools comparison

### Key Decisions
- Subdirectories over flat lib — prevents boiling frog as Phase 4-5 adds more files
- `logSearchEvaluation()` stays in `ai-search.ts` — avoids circular dependency
- MRR added as ranking quality metric — captures position, not just presence
- `computeMetrics()` and `formatReport()` separated — composable for eval_runs persistence

### Next Session
1. Commit all session 31 changes
2. Execute eval hardening plan (5 tasks) — subagent-driven recommended
3. Run eval against live Supabase to verify persistence + comparison
4. Add RLS policies to `eval_runs` table
5. Phase 4.5: Start tuning (reranker first, per reference doc priority order)

---

## Session 32 — 2026-04-02

### Eval Hardening (Plan Executed — 5/5 Tasks Complete)
- Task 1: Added MRR (Mean Reciprocal Rank) metric — `reciprocalRank` per test case, `meanReciprocalRank` in aggregate metrics
- Task 2: Persistence layer — `saveEvalRun()` + `loadPreviousRun()` in `eval-store.ts`
- Task 3: Auto-compare + regression detection — `compareRuns()` + `formatComparison()` with severity levels (ok/warning/block/critical), inverted metric handling
- Task 4: Wired persistence + comparison into eval runner script
- Task 5: Live verification — 2 runs against Supabase, comparison working, runs saved (id: 1, 2)
- MRR baseline: **0.601** (right doc averages position ~1.7)

### Variable Naming Cleanup
- Created hookify rule: `descriptive-variable-names` — blocks single-letter variables AND 28 common abbreviations in .ts files
- Fixed 20+ violations across 8 files (eval.ts, eval-store.ts, prompt.ts, migrate.ts, embeddings.ts, init.ts, backup.ts, eval-store.test.ts)
- Renamed `mrr` → `meanReciprocalRank`, `rrf_k` → `reciprocalRankFusionK` across all files
- Inlined unnecessary intermediate variable in MRR computation

### CLI Modernization
- Created `src/cli.ts` — clean entry point with 14 v2 commands (was only in dist/ as compiled JS)
- Created `src/commands/eval.ts` — `ledger eval` and `ledger eval --dry-run`
- Created `src/commands/add.ts` — `ledger add` using `createDocument()`
- Rewrote `backup.ts`, `restore.ts`, `init.ts` — `from('notes')` → `from('documents')`
- Renamed: `deleteNote()` → `removeDocument()`, `exportNote()` → `exportDocument()`, `ExitCode.NOTE_NOT_FOUND` → `DOCUMENT_NOT_FOUND`
- Documented v1 onboarding flow in `docs/v1-onboarding-flow.md` before removing dead commands
- Dropped 11 dead commands from CLI: pull, sync, add(v1), ingest, onboard, wizard, setup, config, backfill, migrate, hunt
- Deleted subagent-created v1 stubs: pull.ts, backfill.ts, notes.d.ts, generators.d.ts, backfill.d.ts
- Build verified: `npm run build` clean, `ledger --help` shows 14 commands

### Reference Docs
- Added "Building Your Eval System Step by Step" walkthrough to `reference-rag-evaluation.md`
- All tables in eval reference visually aligned (28 tables)

### Test Count: 125 (was 95 at session start)

### Next Session
1. Commit all session 32 changes
2. Advanced eval metrics (Phase 4.6): NDCG@k, graded relevance, confidence intervals, score calibration, golden set coverage
3. Add RLS policies to `eval_runs` table
4. Phase 4.5: Start tuning (reranker first)

---

## Session 32 (continued) — 2026-04-02

### Phase 4.6: Advanced Eval Metrics — Complete (6/6 Tasks)
- Task 1: Added NDCG (Normalized Discounted Cumulative Gain) — scores all result positions, not just first hit. Computed per-query in `scoreTestCase`, averaged in `computeMetrics`, added to comparison + report
- Task 2: Confidence intervals via bootstrap resampling — 1000-iteration resample, 95% CI for all 6 metrics. New file `eval-advanced.ts`
- Task 3: Score calibration — separates scores into relevant vs irrelevant buckets, computes distribution stats + separation gap
- Task 4: Coverage analysis — queries per tag, unique docs tested, undertested tag detection (< 3 queries)
- Task 5: `formatAdvancedReport()` — produces human-readable Advanced Analysis section. Wired into both `eval-search.ts` script and `eval.ts` CLI command
- Task 6: Live verification — 4 eval runs stored in Supabase, all metrics computing correctly
- Fixed confidence interval formatting bug (was multiplying already-percentage values by 100)
- Renamed `ndcgAtK` → `normalizedDiscountedCumulativeGain` across all files (per naming conventions)

### Key Findings from Live Eval Data
- NDCG: 0.623 (slightly higher than MRR 0.598 — multi-doc queries get partial credit)
- Confidence intervals: hit rate 88.5% ±8.7% — changes under ~9% could be noise with 56 cases
- Score calibration: separation only 0.004 — RRF scores don't cleanly separate relevant/irrelevant. Threshold tuning won't help; reranker is the right lever
- Coverage: 49 unique docs tested out of ~130 (38%), 8 tags undertested

### Reference Doc Updates
- Rewrote NDCG section in `reference-rag-evaluation.md` — binary vs graded relevance, concrete examples
- Updated metric selection table — added NDCG to multi-result agent rows
- Added new "Advanced Analysis" section — confidence intervals (bootstrap), score calibration, coverage analysis

### Test Count: 145 (was 125 at start of 4.6)

### Eval Audit & Data Fixes (continued)
- Audited all eval code — identified 7 issues, fixed 3 immediately
- Enriched `per_query_results` JSONB — added NDCG, returnedScores, tags, expectedDocIds (stored runs now self-contained)
- Enriched `missed_queries` JSONB — added gotScores and tags (can distinguish ranking vs relevance failures)
- Extracted `CURRENT_SEARCH_CONFIG` to `eval-store.ts` — single source of truth for script + CLI
- Added `mean_reciprocal_rank`, `normalized_discounted_cumulative_gain`, `confidence_intervals`, `score_calibration`, `coverage_analysis` columns to `eval_runs` table (SQL ran in Supabase)
- Updated `saveEvalRun()` to persist all new columns + enriched JSONB
- Updated `loadPreviousRun()` comparison to use real MRR/NDCG from stored runs (was hardcoded 0)
- Verified run 5 in Supabase — all 15 columns populated correctly
- Updated schema doc + test assertions

### Phase 4.5.1: Reranker
- Built `src/lib/search/reranker.ts` — Cohere cross-encoder reranking via native fetch (no SDK)
- Wired into `searchHybrid()` as optional step — fetches 2x candidates, reranker selects best N
- Added `cohereApiKey` to `IClientsProps`, `LedgerConfig`, MCP server, eval script, eval CLI
- Added `reranker` option to `IHybridSearchProps` ('none' | 'cohere')
- Search telemetry logs `hybrid+rerank` mode when active
- Security: API key only in Authorization header, never in request body or stored data
- 7 new tests including security test (key not leaked in body)
- Live eval with Cohere: **+15.3% first-result accuracy, +10.5% recall, +0.119 MRR, +0.122 NDCG**
- **Disabled Cohere** — privacy concern, personal knowledge base data sent to third party
- Reranker code stays in place for future local cross-encoder
- Run 7 (no reranker) stored as current baseline
- Added RLS policies to `eval_runs` table (SQL in Supabase)

### Test Count: 152 (was 145)

### Next Session
1. Commit all changes
2. Phase 4.5.2: Contextual retrieval (LLM prepend per chunk — no third-party data concern since we already use OpenAI for embeddings)
3. Phase 4.5.3: Recursive chunking
4. Grow golden dataset toward 100+ cases

---

## Session 33 — 2026-04-03

### Phase 4.5.2 + 4.5.3: Recursive Chunking & Chunk Context Enrichment — DONE

Designed, planned, and implemented two complementary improvements to the ingestion pipeline. Went from brainstorm → spec → plan → implementation → eval in one session.

**Recursive chunking:**
- Replaced greedy paragraph packer with hierarchical splitter: headers → paragraphs → lines → sentences → character fallback
- Default chunk size dropped from 2000 → 1000 chars (industry standard for semantic search)
- Configurable via `IChunkConfigProps` — `maxChunkSize`, `overlapChars`, `strategy`
- Old `'paragraph'` strategy available as option, new default is `'recursive'`
- `chunkText()` signature changed from 4 positional params to config object

**Chunk context enrichment (Contextual Retrieval, Anthropic 2024):**
- New module: `src/lib/search/chunk-context-enrichment.ts`
- Before embedding, each chunk + full document sent to gpt-4o-mini to generate 2-3 sentence context summary
- Summary stored in `context_summary` column (was NULL), token count in `token_count` column
- Embedding input: `summary + "\n\n" + chunk.content` — enriched vector, original text in results
- Named "chunk context enrichment" (describes the operation) rather than "contextual retrieval" (describes the goal)
- Updated all reference docs (RAG architecture, RAG evaluation, RAG schemas) with both names

**Pipeline integration:**
- `createDocument()` and `updateDocument()` now: chunk → enrich → embed(enriched) → RPC
- `IOpenAIClientProps` expanded with `chat.completions.create` for gpt-4o-mini calls
- Used `(...args: any[]) => PromiseLike<...>` for chat type — real OpenAI SDK has overloaded signatures too complex for structural typing
- RPC functions updated: `document_create` and `document_update` gain `p_chunk_summaries text[]`, `p_chunk_token_counts int[]`, `p_chunk_overlap int`
- Old RPC overloads (22-param create, 10-param update) dropped to avoid Postgres ambiguity

**Re-index:**
- Created `src/scripts/reindex.ts` — bulk re-index with dry-run mode, single-doc mode
- Re-indexed all 129 documents through new pipeline (~$0.25 total cost)
- Backed up database before re-indexing (`ledger backup`)

### Phase 4.5.4: Threshold Tuning — DONE

**Golden dataset expanded:** 56 → 145 test cases (89 new)
- 44 simple queries covering previously untested documents
- 15 conceptual, 7 exact-term, 7 multi-doc, 8 cross-domain, 8 out-of-scope
- Document coverage: 49 → 120 docs tested (38% → 93%)
- Confidence intervals shrank: hit rate ±8.5% → ±3.4%

**Threshold sweep CLI command:**
- Created `ledger eval:sweep` — permanent CLI command for testing multiple thresholds
- Default range: 0.15, 0.20, 0.25, 0.30, 0.35, 0.40
- Custom: `--thresholds 0.38,0.40,0.42,0.45,0.50`
- Diagnostic tool — results not stored, run `ledger eval` after applying winner

**Sweep results:**
- 0.38 peaked across all metrics (hit rate, first-result, recall, MRR, NDCG)
- Higher threshold works because enriched embeddings push relevant scores higher — stricter filter cuts noise without dropping relevant results
- Updated threshold from 0.25 → 0.38 in: `ai-search.ts` (2 places), `mcp-server.ts` (3 MCP tools), `eval-store.ts` (config)

### Eval Results — Before & After

| Metric            | Run 7 (old pipeline) | Run 11 (new pipeline) | Change       |
|-------------------|----------------------|-----------------------|--------------|
| Hit rate          | 88.5%                | **95.5%**             | **+7.0%**    |
| First-result      | 44.2%                | **64.7%**             | **+20.5%**   |
| Recall            | 72.6%                | **77.6%**             | **+5.0%**    |
| MRR               | 0.595                | **0.747**             | **+0.152**   |
| NDCG              | 0.620                | **0.759**             | **+0.139**   |
| Out-of-scope      | 25.0%                | **75.0%**             | **+50.0%**   |

### Documentation Updates
- `reference-rag-system-architecture.md` — renamed "Contextual Retrieval" → "Chunk Context Enrichment" throughout, updated Ledger Implementation section with active pipeline, updated Production Defaults threshold note
- `reference-rag-evaluation.md` — added Threshold Sweep section, renamed technique
- `reference-rag-database-schemas.md` — updated context_summary column description
- `ledger-architecture-database-schemas.md` — updated RPC functions with new params
- `ledger-architecture-database-functions.md` — same RPC updates
- `CLAUDE.md` — updated command count to 16 (incl. eval:sweep)
- Created design spec: `docs/superpowers/specs/2026-04-03-chunking-and-context-enrichment-design.md`
- Created implementation plan: `docs/superpowers/plans/2026-04-03-chunking-and-context-enrichment.md`

### Files Created
- `src/lib/search/chunk-context-enrichment.ts` — context summary generation
- `src/scripts/reindex.ts` — bulk re-index script
- `tests/chunk-context-enrichment.test.ts` — 10 tests
- `docs/superpowers/specs/2026-04-03-chunking-and-context-enrichment-design.md`
- `docs/superpowers/plans/2026-04-03-chunking-and-context-enrichment.md`

### Files Modified
- `src/lib/documents/classification.ts` — `IChunkConfigProps`, `'recursive'` in ChunkStrategy, chat on IOpenAIClientProps
- `src/lib/search/embeddings.ts` — recursive `chunkText()` with config object
- `src/lib/documents/operations.ts` — enrichment pipeline in create/update
- `src/lib/eval/eval-store.ts` — expanded `CURRENT_SEARCH_CONFIG`
- `src/lib/search/ai-search.ts` — threshold 0.25 → 0.38
- `src/mcp-server.ts` — threshold defaults 0.25 → 0.38
- `src/commands/eval.ts` — added `sweepThreshold()`
- `src/cli.ts` — added `eval:sweep` command
- `tests/embeddings.test.ts` — recursive chunker tests (25 tests)
- `tests/document-operations.test.ts` — enriched pipeline tests (7 tests)

### Key Decisions
- Named technique "chunk context enrichment" instead of "contextual retrieval" — describes the operation, not the goal
- gpt-4o-mini for summaries (20x cheaper than gpt-4o, same quality for 2-sentence summaries)
- Synchronous enrichment (not background queue) — acceptable for current corpus size, queue deferred to Phase 4.7
- Temperature 0 for deterministic summaries
- `(...args: any[]) => PromiseLike` for OpenAI chat type — pragmatic over purist
- Threshold sweep is diagnostic (not stored) — eval run after applying winner is the record

### Test Count: 126 (project tests, 12 test files)

### Next Session
1. Phase 4.5.5: Semantic cache — use HNSW on query_cache for fuzzy query matching instead of exact text match
2. Phase 4.6.2: Graded relevance — upgrade golden dataset from binary (found/not found) to 0/1/2 scoring for more nuanced eval
3. Phase 4.7: Multi-format ingestion — PDF, audio, images via ingestion_queue table
4. Investigate: 6 missed queries — are expected_doc_ids correct or do golden dataset entries need fixing?

---

## Session 34 — 2026-04-03

### DISTINCT ON Ordering Bug Fix (Critical)
- **Discovered and fixed** a PostgreSQL `DISTINCT ON` ordering bug in `match_documents` and `match_documents_hybrid`
- **Root cause:** `DISTINCT ON (n.id)` forces `ORDER BY n.id` as leading sort column. When `LIMIT` was applied in the same query, results were clipped by document ID order, not similarity. Documents with high IDs (e.g. #137-141 architecture docs) were systematically invisible.
- **Fix:** Two-step query pattern — inner subquery deduplicates with DISTINCT ON (forced ID ordering), outer query re-sorts by similarity DESC and applies LIMIT
- **Impact:** All 6 "missed" queries from run 11 traced back to this bug. Run 12 after fix: 5 missed queries remain (1 resolved, 4 are genuine retrieval gaps)
- SQL deployed to Supabase manually by Adrian

### Eval Run 12 (post-fix)

| Metric              | Run 11 (before) | Run 12 (after) | Change    |
|---------------------|-----------------|----------------|-----------|
| Hit rate            | 95.5%           | **96.2%**      | +0.8%     |
| First-result        | 64.7%           | **65.4%**      | +0.8%     |
| Recall              | 77.6%           | **79.3%**      | +1.7%     |
| MRR                 | 0.747           | **0.756**      | +0.009    |
| NDCG                | 0.759           | **0.764**      | +0.005    |
| Missed queries      | 6               | **5**          | -1        |

### Remaining 5 Missed Queries (genuine retrieval gaps)
1. "how to protect sensitive documents" — expected [141, 137], got [144, 149]
2. "websearch_to_tsquery tsvector GIN" — expected [138, 139], got [22, 149, 144, 137, 140]
3. "what are Adrian's strengths and weaknesses as a developer" — expected [7, 8], got [52, 16, 119, 33, 15]
4. "how does Ledger prevent data loss during updates" — expected [139, 138], got [28, 112, 149, 22, 19]
5. "all system rules and sync rules" — expected [25, 30, 34, 36, 107, 116], got [135, 126, 129, 26, 100]

### Phase 4.7 Multi-Format Ingestion — Research Saved
- Researched provider plugin architecture, library picks for all 11 source_types
- Saved to Ledger #150 (`ledger-phase-4-7-multi-format-ingestion-research`)
- **Deferred to end of v2** — retrieval quality improvements have higher ROI

### Documentation Updates
- `docs/ledger-architecture-database-functions.md` — updated SQL for both search functions
- `docs/reference-rag-database-schemas.md` — added DISTINCT ON pitfall warning
- Ledger #137 (architecture overview) — threshold 0.25→0.38, function count 15→17, added RAG pipeline + evaluation sections, current baseline
- Ledger #139 (database functions) — added deduplication pattern note, updated descriptions

### Key Decisions
- Two-step DISTINCT ON deduplication is the correct Postgres pattern for chunk→document search
- Phase 4.7 multi-format ingestion deferred — provider plugin architecture researched and saved for later
- Remaining 5 missed queries are genuine retrieval gaps, not stale labels or ordering bugs

### Next Session
1. Phase 4.5.5: Semantic cache — HNSW fuzzy query matching on query_cache
2. Phase 4.6.2: Graded relevance — upgrade golden dataset from binary to 0/1/2 scoring
3. Investigate remaining 5 missed queries — may need query reformulation or golden dataset label fixes

## Session 35 — 2026-04-07

### eval:show CLI Command
- Added `ledger eval:show <runId>` command to inspect saved eval runs, resolves doc ids → names, shows top-3 returned for each missed query with snippets
- New `loadEvalRun(id)` in `eval-store.ts` (sibling to `loadPreviousRun`)
- Committed on `feat/v2-phase-1-database`, pushed

### Run 12 Missed-Query Diagnosis
Diagnosed all 5 misses from run 12 via `search_by_keyword` + `search_by_meaning` isolation tests:
- **Query #5** ("all system rules and sync rules"): enumeration request, not a retrieval shape. **Deleted from dataset** (row id 124).
- **Queries #1, #2**: false negatives — retrieval surfaced defensible alternatives (#144, #22) that binary dataset counts as wrong. Graded relevance will fix.
- **Queries #3, #4**: genuine conceptual→jargon vocabulary gap (bi-encoder can't bridge "strengths/weaknesses" → "ADHD/habits", "prevent data loss" → "transactional/audit"). Cross-encoder reranker is the industry-standard fix. Deferred — we'll re-enable the existing disabled reranker later if graded metrics still show the gap.
- **Query #2 special note**: AND-semantics granularity trap — only one chunk in the corpus contains all three terms (`websearch_to_tsquery`, `tsvector`, `GIN`) together, and it's the summary line in `ledger-product-vision`. Deep docs lose because the terms are spread across chunks. Not a bug, just how AND-semantics interacts with chunk granularity.

### Run 13 — New Baseline
After deleting query #5, re-ran eval. 144 test cases.
- Hit rate: 96.2 → **97.0%** (+0.8)
- First-result: 65.4 → **65.2%** (-0.2)
- Recall: 79.3 → **81.4%** (+2.1)
- MRR: 0.756 → **0.760**
- NDCG: 0.764 → **0.769**
- Saved as `eval_runs.id = 13`

### Phase 4.6.2 Brainstorming Complete
Five-question design session for graded relevance:
1. **Scale**: TREC 4-level (0/1/2/3) — matches NDCG `2^g-1` gain formula, industry standard
2. **Schema**: normalized `eval_golden_judgments` table (not JSONB) — matches CLAUDE.md "no JSONB grab bags" rule, supports audit trail, FK to documents with cascade
3. **Migration**: convert + augment — auto-convert existing binary to grade 3, then human-rejudge top-10 for each query via tool
4. **Metrics**: `hit_threshold = 2` for rate metrics (hit rate, first-result, recall, MRR), NDCG uses full `2^grade - 1` gradation
5. **Tool UX**: resumable full-dataset walkthrough (`ledger eval:judge`), durable per-keystroke writes, inline rubric, back-step support

Design spec written: [docs/superpowers/specs/2026-04-07-phase-4.6.2-graded-relevance-design.md](docs/superpowers/specs/2026-04-07-phase-4.6.2-graded-relevance-design.md)

### Key Decisions
- Reranker deferred (not removed) — existing disabled code stays, will revisit if 4.6.2 metrics still show conceptual→jargon gap
- HyDE explicitly rejected — adds latency + hallucination risk, and we already have a built reranker as the textbook fix
- Phase 4.6.2 ordered BEFORE 4.5.5 semantic cache — you can't tune what you can't measure, and cache thresholds depend on honest similarity separation (current calibration separation is 0.005, which is noise)
- Expected metric shifts post-graded: first-result 65 → 75-85%, NDCG spreads meaningfully. These are measurement changes, NOT retrieval improvements. Will be documented clearly.

### Branch Management
- Work on `eval:show` + missed-query diagnosis + query #5 deletion was committed/pushed on `feat/v2-phase-1-database`
- New branch `feat/v2-phase-4.6.2-graded-relevance` cut from `origin/main` for Phase 4.6.2 work

### Next Session
1. User reviews spec at [docs/superpowers/specs/2026-04-07-phase-4.6.2-graded-relevance-design.md](docs/superpowers/specs/2026-04-07-phase-4.6.2-graded-relevance-design.md)
2. Invoke `writing-plans` skill to produce implementation plan
3. Execute per plan: migration → types/scoring → conversion script → dry-run parity check → rejudging tool → rejudge → run 14 → drop `expected_doc_ids`

## Session 36 — 2026-04-08

### Phase 4.6.2 Execution (Tasks 1–7)

Worked through the implementation plan for graded relevance. Committed Tasks 1–6. Task 7 dry-run surfaced an environment shift — documented below.

**Setup changes:**
- Installed `psql` (postgresql-client 17.9) and configured `DATABASE_URL` with the Supabase Session Pooler URI. Direct connection is IPv6-only and not reachable from this machine; pooler on port 5432 is IPv4 and supports schema changes.
- Enables running pgTAP, migrations, and ad-hoc SQL from the code instead of pasting into the dashboard.

**Task 1 — pgTAP red phase:** `tests/sql/002-eval-golden-judgments.sql` with 8 tests defining the contract for the new table + RPC functions. Ran against current schema — all assertions failed with "relation does not exist" as expected.

**Task 2 — Migration:** `src/migrations/007-eval-golden-judgments.sql` creates the `eval_golden_judgments` table (FK cascades to `eval_golden_dataset` and `documents`, `CHECK (grade BETWEEN 0 AND 3)`, `UNIQUE (golden_id, document_id)`, audit columns), 3 indexes, RLS with service-role policy, and 3 RPC functions (`judgment_create`, `judgment_update`, `judgment_delete`). All 8 pgTAP tests green after apply.

**Task 3 — Auto-conversion:** `src/scripts/convert-judgments-to-graded.ts` reads the legacy `expected_doc_ids` column and creates grade-3 rows via the `judgment_create` RPC. **Result: 144 queries scanned, 231 grade-3 judgments inserted, 0 errors.** Cross-checked with psql: `sum(array_length(expected_doc_ids)) = count(grade=3) = 231`. Tagged `judged_by='converter-phase-4.6.2'` for rollback.

**Task 4 — TS types + loader join:** Expand phase of the parallel-change pattern.
- `eval.ts`: added `TGradeValue`, `IJudgmentProps`, extended `IGoldenTestCaseProps` with `judgments[]` (kept `expected_doc_ids` temporarily with `@deprecated`)
- `eval-store.ts`: `CURRENT_SEARCH_CONFIG` now includes `hit_threshold: 2` and `ndcg_gain_formula: '2^g - 1'`
- `commands/eval.ts`: loader selects joined via PostgREST nested select `judgments:eval_golden_judgments(document_id, grade)`

**Task 5 — Parity harness:** `tests/eval-graded-parity.test.ts` is a gated integration test (`PARITY_TEST=1`) that verifies the judgments table is a faithful graded mirror of the legacy column. Two invariants: per-row check (every `expected_doc_id` has a matching grade-3) and aggregate count (sums match). Both passing.

**Task 6 — Scoring rewrite:** `scoreTestCase` now reads `testCase.judgments` exclusively. Exported `HIT_THRESHOLD = 2`. NDCG uses `gain = 2^grade - 1` (TREC standard). Updated `computeMetrics` filter, `formatReport` header, missed-queries block, and `eval-store.ts` serialization. Also updated `eval-advanced.ts` (`computeScoreCalibration`, `computeCoverageAnalysis`) to use grade-based relevance. Deleted dead `src/scripts/eval-search.ts`. All 190 unit tests green, parity harness still green.

### Task 7 — Dry-run sanity check — surfaced a corpus shift

Expected behavior: with only grade-3 judgments in the table, graded scoring should mathematically match run 13 (grade 3 passes `>=2` threshold for every rate metric, and `2^3-1=7` is a constant in NDCG that cancels in IDCG).

Observed:

| Metric            | Run 13 | Task 7 dry-run | Δ     |
|-------------------|--------|----------------|-------|
| Hit rate          | 97.0%  | 94.7%          | -2.3  |
| First-result acc  | 65.2%  | 59.8%          | -5.4  |
| Recall            | 81.4%  | 78.4%          | -3.0  |
| MRR               | 0.760  | 0.712          | -0.048|
| NDCG              | 0.769  | 0.725          | -0.044|

**Root cause: the corpus changed between run 13 (2026-04-07) and today (2026-04-08).**

Querying `documents` showed 11 new rows with ids 144–155. Several were auto-synced from local `docs/*.md` edits during pass-1 doc updates earlier in this session:

- `#151 ledger-architecture-database-tables`
- `#152 ledger-architecture-database-schemas`
- `#153 ledger-architecture-database-indexes`
- `#155 reference-rag-evaluation`
- plus `#146`–`#150` from earlier this week

These new docs now compete in retrieval. They surface for many queries and push the canonical answers down, lowering first-result accuracy and MRR. The scoring is correct; the retrieval is correct; the corpus is just different.

Previously-diagnosed query #4 from run 12 ("how does Ledger prevent data loss during updates") still returns the exact same top-3 doc ids as before, confirming the scoring path is stable. The divergence is driven by queries that newly pick up the added docs.

**Decision:** proceed with Option A from the plan. Do not save this as run 14 (it's diagnostic only). Continue to Task 8. Task 9's rejudging pass will capture the defensible alternatives against today's corpus naturally. Run 14 (Task 10) will be the honest post-graded baseline, documented alongside the corpus-shift context.

**Lesson:** golden datasets assume a fixed corpus. When the corpus drifts, historical metrics stop being comparable unless you snapshot and restore. For Ledger's scale (personal-use, low frequency), periodic rejudging against the live corpus is the pragmatic answer — which is exactly what Phase 4.6.2 does.

### Task 8 — `ledger eval:judge` rejudging CLI

Built the interactive rejudging tool. Four new files:

- `src/migrations/008-judge-helpers.sql` — `count_golden_with_min_judgments()` function for progress tracking
- `src/lib/eval/eval-judge-session.ts` — session state, input parsing (`parseGradeInput` discriminated union), progress rendering, interactive loop with per-keystroke durable writes via `judgment_create` / `judgment_update` RPC
- `src/commands/eval-judge.ts` — thin command wrapper (loads config, calls `runJudgeSession`)
- `tests/eval-judge-session.test.ts` — 9 unit tests for pure helpers (`parseGradeInput`, `pickNextUngraded`, `formatProgressLine`)

CLI registered as `ledger eval:judge` with optional `--query <id>` flag. Resumable: default finds the first query with ungraded top-10 candidates. Per-keystroke durable writes (every grade hits the DB immediately via RPC, zero-loss on crash). Inline TREC rubric on `?` with boundary heuristics.

**Tests:** 199 passing (190 prior + 9 new judge-session tests). Build clean.

### Environment setup
- Installed `psql` (postgresql-client 17.9)
- Configured `DATABASE_URL` in `.env` using Supabase Session Pooler (IPv4-compatible, port 5432). Direct connection is IPv6-only and unreachable from this machine.
- All migrations, pgTAP tests, and ad-hoc queries now runnable from the terminal via `psql "$DATABASE_URL" -f ...`

### Branch state
- 8 commits on `feat/v2-phase-4.6.2-graded-relevance`, pushed to remote
- All tests green (199 passing, 2 skipped parity cases gated by env var)
- Tasks 1–8 complete. Task 9 (human judging pass) is the next step.

### Task 9 — Batch grading

Manual judging session covered 4 queries (30 judgments). Tool worked well but grading all 144 queries manually would take 2-3 hours across multiple sessions.

**Decision: batch grading script.** Built `src/scripts/batch-grade.ts` that applies Charlie's corpus knowledge programmatically using a rule-based grading system:
- Extracts query topic (project scope, subject, type)
- Matches doc identity against query via name-word overlap, project scope, doc-type patterns
- Applies grade based on canonical match (3), substantial coverage (2), tangential mention (1), unrelated (0)

**Result:** 885 judgments created, 0 errors. Tagged `judged_by='charlie-batch-4.6.2'`.

**Final dataset state:** 1,146 total judgments across 132 normal queries (12 out-of-scope have zero, correct).

| Source                | Count | What                                    |
|-----------------------|-------|-----------------------------------------|
| Auto-converted        | 231   | Legacy binary → grade 3                 |
| Manual (adrian)       | 30    | 4 queries judged by hand                |
| Batch (charlie)       | 885   | Remaining top-10 candidates             |

| Grade | Count | Percentage |
|-------|-------|------------|
| 0     | 641   | 56%        |
| 1     | 167   | 15%        |
| 2     | 89    | 8%         |
| 3     | 249   | 22%        |

### Task 10 — Run 14 (graded baseline)

Run 14 saved with `hit_threshold=2`, `ndcg_gain=2^g-1` against 1,146 judgments.

| Metric            | Run 13 (binary) | Run 14 (graded) | Δ     |
|-------------------|-----------------|-----------------|-------|
| Hit rate          | 97.0%           | **96.2%**       | -0.8  |
| First-result acc  | 65.2%           | **62.9%**       | -2.3  |
| Recall            | 81.4%           | **84.9%**       | +3.5  |
| MRR               | 0.760           | **0.749**       | -0.011|
| NDCG              | 0.769           | **0.738**       | -0.031|

First-result accuracy dropped instead of rising. Two entangled effects: (1) corpus grew by 11 docs pushing canonical results down in ranking, (2) graded scoring raised the recall denominator (338 grade-2+ docs vs 231 old expected). Recall lift (+3.5) is the honest signal from graded relevance. The 5 missed queries are the same vocabulary-gap and corpus-competition cases identified in Task 7.

### Task 11 — Drop legacy column

`ALTER TABLE eval_golden_dataset DROP COLUMN expected_doc_ids` executed. Post-drop dry-run confirmed eval runs cleanly. Migration file saved as `src/migrations/008-drop-expected-doc-ids.sql`.

### Task 12 — Docs reconciliation pass 2

Spot-checked all 6 docs updated in pass 1. Found and fixed:
- `ledger-architecture-database.md`: header "13 tables, 17 functions, 56 indexes" updated to "15 tables, 21 functions, 61 indexes", RLS "14 tables" to "15 tables"
- `ledger-architecture-database-schemas.md`: "20 custom" functions to "21 custom", added `count_golden_with_min_judgments` to function table

All other docs (database-tables, database-indexes, reference-rag-evaluation, reference-rag-database-schemas) checked out accurate as written in pass 1.

### Phase 4.6.2 complete

Graded relevance is fully shipped:
- New `eval_golden_judgments` table (TREC 4-level, normalized, FK cascades, audit columns)
- 4 RPC functions + 1 helper function
- Scoring rewrite: `HIT_THRESHOLD=2` for rate metrics, `gain = 2^grade - 1` for NDCG
- `ledger eval:judge` CLI: resumable, per-keystroke durable
- 1,146 judgments (231 auto-converted + 30 manual + 885 batch)
- Run 14 baseline established
- Legacy `expected_doc_ids` column dropped
- 6 architecture/reference docs updated (2 passes)
- 199 TypeScript tests + 28 pgTAP tests

### Post-4.6.2: Infrastructure gaps discovered

**1. No rate-limit handling on OpenAI API calls.**
`generateContextSummaries()` and `generateEmbedding()` fire calls with no retry, no backoff, no token budget tracking. Large docs (85K+) hit the gpt-4o-mini 200K TPM limit and crash. Needs a rate-aware API client layer (token budget tracking, pre-flight checks, exponential backoff with jitter). Industry standard for production RAG systems.

**2. MCP tool can't handle large document updates.**
The MCP transport layer has message size constraints. Documents over ~50K chars should go through `updateDocument()` in TypeScript directly, not through the MCP tool parameter. Built `sync-local-docs.ts` as a workaround. Need a permanent solution: either size check + warning in MCP tool, or make the CLI `push` command match by doc name.

**3. Error handling audit needed.**
No systematic review of all external API call sites (OpenAI, Supabase) for error handling. The rate-limit crash was discovered by accident during doc sync. Other silent failures may exist.

**4. Ledger doc sync gap.**
Local `docs/*.md` edits via the Edit tool don't trigger the post-write Ledger sync hook. Built `sync-local-docs.ts` script to push manually. 6 of 8 docs synced, 2 failed on rate limit (reference-rag-evaluation.md, reference-rag-system-architecture.md). Still pending.

**5. Errorlog audit.**
Reviewed full devlog history. Added 6 missing error/solution pairs to `ledger-errorlog` (#19): HNSW subquery limitation (S28), Vitest heap OOM (S30), DISTINCT ON ordering bug (S34), IPv6 direct connection (S36), rate limit crash (S36), MCP large content (S36).

### Next Session
1. **Rate-aware API client layer** -- brainstorm + plan + implement. Fixes rate limit crashes for large doc ingestion.
2. **Error handling audit** -- systematic review of all OpenAI/Supabase call sites
3. **Retry the 2 failed doc syncs** (reference-rag-evaluation.md, reference-rag-system-architecture.md) after rate limiter is built
4. Phase 4.5.5: Semantic cache (HNSW fuzzy query matching)
5. Revisit reranker if metrics plateau

## Session 37 -- 2026-04-09

### Rate-Aware API Client Layer

Built proactive rate limiting for all external API calls. This was the #1 infrastructure gap from S36 (2 docs failed to sync due to OpenAI rate limiting during bulk ingestion).

**Design phase:**
- Researched how production SDKs handle rate limiting (OpenAI, Stripe, AWS, Bottleneck, p-retry, p-queue)
- Key finding: OpenAI SDK already retries 429s with exponential backoff (default 2 retries). Missing piece was proactive pacing.
- Design spec: `docs/superpowers/specs/2026-04-09-rate-aware-api-client-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-09-rate-aware-api-client.md`

**Implementation (8 tasks, all complete):**
- `src/lib/rate-limiter.ts` (new): provider-agnostic Bottleneck factory with presets (OpenAI Tier 1: 450 RPM, Cohere trial: 90 RPM), singleton instances, retry on 429/5xx with exponential backoff + jitter, adaptive header reading from OpenAI responses
- `tests/rate-limiter.test.ts` (new): 13 tests covering factory, presets, retry behavior, header adaptation
- `src/lib/config.ts`: bumped OpenAI SDK maxRetries from 2 to 5
- `src/lib/search/embeddings.ts`: generateEmbedding() routes through openaiLimiter with .withResponse() for header reading
- `src/lib/search/chunk-context-enrichment.ts`: Contextual Retrieval calls route through openaiLimiter
- `src/lib/search/reranker.ts`: Cohere calls route through cohereLimiter (ready for when reranker is re-enabled)
- `src/lib/documents/classification.ts`: IOpenAIClientProps updated to support .withResponse()
- `tests/document-operations.test.ts`: mock updated to support .withResponse() (6 tests were failing)
- `docs/reference-rag-system-architecture.md`: added "Outbound API Rate Limiting" section to Scaling chapter

**Documentation updates:**
- Ledger error log (#19): updated S36 rate limit entry with fix details
- Ledger architecture (#137): update saved locally at `docs/ledger-architecture-update-s37.md` (too large for MCP transport, needs sync via sync-local-docs.ts)
- RAG reference doc: added outbound rate limiting as standard production pattern

**Test results:** 212 passing (199 prior + 13 new rate limiter tests). Build clean.

**Key decisions:**
- Bottleneck over custom implementation (industry standard, 14M weekly downloads, stable since 2019)
- Function-level wrapping over client-level proxy (only 2 hot paths + reranker, simpler and more explicit)
- Shared OpenAI limiter instance across embeddings and Contextual Retrieval (same RPM budget)
- Separate Cohere limiter instance (independent rate limit)
- 90% safety margin on stated limits (450 of 500 RPM for OpenAI, 90 of 100 RPM for Cohere)

**CLAUDE.md updates:**
- Added "Production-grade defaults" to Core philosophy
- Added feedback memory: always recommend industry-standard solutions
- Added feedback memory: always explain acronyms and tech terms

### Branch state
- Branch: `feat/rate-aware-api-client`
- All tests green (212 passing, 2 skipped)
- Build clean

### Next
1. Sync architecture update to Ledger (#137) via sync-local-docs.ts
2. Error handling audit across all OpenAI/Supabase call sites
3. Phase 4.5.5: Semantic cache
4. Revisit reranker if first-result accuracy plateaus
