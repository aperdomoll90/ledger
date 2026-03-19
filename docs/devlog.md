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
