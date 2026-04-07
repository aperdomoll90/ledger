# Ledger v2 — Data Model & Domain Architecture

> Date: 2026-03-28 | Status: Draft | Project: Ledger

## Problem

Ledger v1's metadata model conflates three concerns into one `delivery` field:
- **What kind of thing is this?** (agent identity vs infrastructure vs project state)
- **How should it sync?** (every machine vs on-demand)
- **Who can modify it?** (anyone vs user-only)

This causes:
- System rules and persona skills both land in `delivery: persona` with no distinction
- Cross-project notes (dashboards, devlog) are scattered across `project` and `knowledge` delivery tiers
- No write protection — CLAUDE.md can be overwritten by any agent or hook
- No versioning — changes to critical files are unrecoverable
- No clear model for "what gets installed on a new machine"

## Solution

Replace `delivery`-driven organization with a **domain + protection + auto_load** model. One content table, one audit table. Every note belongs to a domain, has a protection level, and declares whether it auto-loads into context.

---

## Core Concepts

### Domains — "What kind of thing is this?"

| Domain | Purpose | Example |
|--------|---------|---------|
| **system** | Ledger infrastructure — hooks, configs, sync rules | block-env.sh, type registry |
| **persona** | Agent identity — personality, skills, behavioral rules | Charlie's personality, code-review skill |
| **workspace** | User operational view — cross-project dashboards and information | Project dashboard, devlog, dev environment |
| **project** | Single-project state — architecture, errors, status | Starbrite architecture, error log |
| **general** | Personal knowledge and reference — anything not tied to a project or dev setup | OAuth explainer, restaurant list, book notes |

**Sync is driven by `is_auto_load`, not domain.** Documents sync to a machine only if they need to be in the AI's context every session (CLAUDE.md, MEMORY.md, personality, behavioral rules). Everything else — regardless of domain — stays in the database and is accessed via search on demand. This avoids stale local copies that drift when updated from another machine.

**What each domain is NOT for:**

| Domain | Not for | Why |
|--------|---------|-----|
| **system** | User content, personal preferences, project state | System is Ledger's own infrastructure — only things Ledger needs to run. Not user data. |
| **persona** | Reference material, general knowledge, project-specific data | Persona is who you are, not what you know. Knowledge goes to general or project. |
| **workspace** | Behavior (skills, hooks, plugins), identity docs (CLAUDE.md, MEMORY.md) | Workspace is informational only — it describes your setup, it doesn't add behavior or define identity. |
| **project** | Cross-project knowledge, personal preferences, infrastructure | Project is scoped to one codebase. Anything that spans projects goes elsewhere. |
| **general** | Behavior, identity, project-scoped work, infrastructure | General is your personal knowledge store — things you want to remember, not things that do work. |

**Domain capabilities at a glance:**

| Domain | Purpose | Has extensions? | Has docs? | Has resources? |
|--------|---------|----------------|-----------|---------------|
| **persona** | Identity | Yes (skill, hook, plugin-config) | Yes (claude-md, memory-md) | No |
| **system** | Infrastructure | Yes (skill, hook, plugin-config) | No | No |
| **workspace** | Operational info | No | No | Yes (reference, knowledge, eval-result) |
| **project** | Codebase state | Yes (skill) | Yes (claude-md, memory-md) | Yes (reference, knowledge, eval-result) |
| **general** | Personal knowledge | No | No | Yes (reference, knowledge) |

### Protection — "Who can modify this?"

| Level | Who can edit | Confirmation required | Use case |
|-------|-------------|----------------------|----------|
| **open** | Any agent or user | No | Error logs, devlog entries, events |
| **guarded** | Any agent or user | Yes — show diff first | Architecture decisions, preferences, dashboards |
| **protected** | User only | Yes — show diff + explicit approval | CLAUDE.md, skills, hooks, personality |
| **immutable** | Nobody (system managed) | Cannot be edited, only replaced by system | Type registry, audit_log entries |

### Auto-load — "Does this sync locally and load into context?"

`is_auto_load` is the single flag that controls both sync and context loading. If a document has `is_auto_load: true`, it syncs to every machine and loads into the AI's context at session start. There is no case where a document syncs but doesn't load, or loads but isn't synced.

| Domain | auto_load default | Override allowed |
|--------|-------------------|-----------------|
| system | true | No — system rules always load |
| persona | true | Yes — skills load on demand |
| workspace | false | Yes — pin a dashboard if needed |
| project | false | No — too much data, always on-demand |
| general | false | No — searched on demand |

### Ownership — "Who does this belong to?"

| owner_type | owner_id | Meaning |
|-----------|----------|---------|
| `system` | null | Ledger infrastructure — same for everyone |
| `user` | user-uuid | Personal — one user's persona, workspace, projects |
| `team` | team-uuid | Future — shared across team members |

Team ownership is designed but not implemented. Groundwork is laid so the schema doesn't need to change later.

---

## Note Type Registry

### Shared Types

Some types are reused across multiple domains. They fall into three categories:

**Extensions** — add behavior to the system:
| Type | Default domain | Also valid in | What it does |
|------|---------------|---------------|-------------|
| `skill` | persona | system, workspace, project | Adds capability (code review skill, deploy checklist, eval runner) |
| `hook` | system | persona, workspace | Runs code on events (block-env.sh, strip-ai-coauthor.sh) |
| `plugin-config` | system | persona, workspace | Configures a tool integration (Atelier, Chrome DevTools MCP) |

**Documents** — identity files that define how agents interact:
| Type | Default domain | Also valid in | What it is |
|------|---------------|---------------|-----------|
| `claude-md` | persona | project | Agent instructions (global ~/CLAUDE.md or project-scoped) |
| `memory-md` | persona | project | Search guide (global MEMORY.md or project-scoped) |

**Resources** — store information:
| Type | Default domain | Also valid in | What it stores |
|------|---------------|---------------|---------------|
| `reference` | general | workspace, project | Links, bookmarks, API docs |
| `knowledge` | general | workspace, project | Learnings, how-tos, explainers |
| `eval-result` | workspace | project | Skill performance metrics |

Extensions are available in persona, system, and project — domains that add behavior. Documents appear in persona and project — domains with agent-facing instructions. Resources appear in workspace, project, and general — domains that store information. Workspace is purely informational (no extensions, no docs).

When creating a shared type, `inferDomain` picks the default. Override with `domain: 'project'` etc. for non-default placement. Notes with a `project` field and ambiguous types (reference, knowledge) are promoted to project domain during backfill.

### Persona Domain

| Type | Protection | auto_load | What it stores |
|------|-----------|-----------|----------------|
| `personality` | protected | true | Agent identity — "You are Charlie, direct and educational" |
| `behavioral-rule` | protected | true | "No trailing summaries", "don't mock the DB" |
| `preference` | guarded | true | "BEM with c- prefix", coding conventions, tool choices |
| `skill` | protected | false | Code review skill, design system skill — loaded by Claude on demand |
| `claude-md` | protected | true | The full CLAUDE.md document — stored complete, not generated |
| `memory-md` | protected | true | The MEMORY.md search guide — stored complete, not generated |
| `hook` | protected | false | Personal hooks (strip-ai-coauthor.sh, custom linters) — follow you across machines |
| `plugin-config` | guarded | false | Personal plugins (Atelier agent team, Chrome DevTools MCP) |

### System Domain

| Type | Protection | auto_load | What it stores |
|------|-----------|-----------|----------------|
| `hook` | protected | false | Shell scripts (block-env.sh, post-write-ledger.sh) |
| `plugin-config` | guarded | false | Which plugins to install, versions |
| `type-registry` | immutable | false | Built-in + custom type definitions |
| `sync-rule` | immutable | false | Rules for how sync behaves |
| `skill` | protected | false | System-level skills (session-checkpoint, eval runner) |

### Workspace Domain

| Type | Protection | auto_load | What it stores |
|------|-----------|-----------|----------------|
| `dashboard` | guarded | false | Project status dashboard, cross-project overview |
| `device-registry` | guarded | false | List of connected machines |
| `environment` | guarded | false | Dev setup checklist (new machine playbook) |
| `eval-result` | open | false | Skill performance history (workspace-level) |
| `reference` | open | false | Cross-project references (dev tools docs, internal links) |
| `knowledge` | open | false | Cross-project learnings (not tied to one repo) |

### Project Domain

| Type | Protection | auto_load | What it stores |
|------|-----------|-----------|----------------|
| `architecture` | guarded | false | System maps, design specs, implementation plans |
| `project-status` | open | false | Per-project status, what's done/next |
| `event` | open | false | Deployments, incidents, milestones, session summaries |
| `error` | open | false | One note per error — problem, cause, fix (see below) |
| `claude-md` | protected | false | Project-scoped CLAUDE.md (e.g. ~/repos/ledger/CLAUDE.md) |
| `memory-md` | protected | false | Project-scoped MEMORY.md |
| `reference` | open | false | Project-scoped links, API docs, tool references |
| `knowledge` | open | false | Project-scoped learnings, guides |
| `skill` | guarded | false | Project-specific skills (deploy checklist) |
| `eval-result` | open | false | Skill performance history (project-level) |

### General Domain

| Type | Protection | auto_load | What it stores |
|------|-----------|-----------|----------------|
| `reference` | open | false | External links, bookmarks, tool references not tied to a project |
| `knowledge` | open | false | General learnings, how-tos, explainers (OAuth, DNS, etc.) |
| `general` | open | false | Catch-all for untyped personal notes (restaurants, books, etc.) |

### Skill Linking

Skills are flat notes. Related pieces (eval cases, eval results) reference the skill by key:

```
metadata.skill_ref: "code-review-conventions"
```

Query all pieces of a skill: `WHERE metadata->>'skill_ref' = 'code-review-conventions'`

No parent-child hierarchy for now. Can add `parent_id` later if flat approach becomes painful.

### Devlog Replaced by Audit Log + Events

v1 had a monolithic devlog that grew forever. In v2, this is replaced by:
- **audit_log table** — automatically tracks what changed, when, and by whom
- **event notes** (`domain: project`, `type: event`) — per-session summaries capturing decisions, reasoning, and what's next
- **Spec notes** — architecture decisions and reasoning already stored as notes

The devlog's only unique value was session narrative ("we started X, pivoted to Y"). That becomes a per-session `event` note instead of an ever-growing document.

### Error Notes — One Per Error

v1 stored all errors in a single growing note. In v2, each error is its own note:

```
domain:     project
type:       error
project:    ledger
upsert_key: error-mcp-handshake-timeout

Content:
## MCP tools not appearing
**Problem:** npx tsx cold-start exceeds handshake timeout
**Cause:** TypeScript compilation on every MCP startup
**Fix:** Precompile TS to JS, run with node
```

Benefits:
- Semantically searchable ("have I seen this CORS error before?")
- Filterable by project
- No single document bloating
- If a better fix is found, the old fix is preserved in the audit log

---

## Metadata Schema

### Base Fields (every note)

```typescript
// Domain-scoped type unions — type must be valid for its domain
type PersonaType   = 'personality' | 'behavioral-rule' | 'preference' | 'skill' | 'claude-md';
type SystemType    = 'hook' | 'plugin-config' | 'type-registry' | 'sync-rule' | 'skill';
type WorkspaceType = 'dashboard' | 'device-registry' | 'environment' | 'eval-result' | 'skill';
type ProjectType   = 'architecture' | 'project-status' | 'event' | 'error' | 'reference' | 'knowledge' | 'skill' | 'eval-result';
type GeneralType   = 'reference' | 'knowledge' | 'general';

type NoteType = PersonaType | SystemType | WorkspaceType | ProjectType | GeneralType;

interface NoteMetadata {
  // Domain & organization
  domain:        'system' | 'persona' | 'workspace' | 'project' | 'general';
  type:          NoteType;
  protection:    'open' | 'guarded' | 'protected' | 'immutable';
  auto_load:     boolean;

  // Ownership
  owner_type:    'system' | 'user' | 'team';
  owner_id:      string | null;

  // Identity & dedup
  upsert_key:    string;
  description:   string;
  content_hash:  string;           // SHA-256 for change detection
  schema_version: number;          // for future metadata migrations

  // Provenance
  agent:         string;           // who created/last modified

  // Embedding tracking
  embedding_model:      string;    // e.g. "openai/text-embedding-3-small"
  embedding_dimensions: number;    // e.g. 1536

  // Extensible
  [key: string]: unknown;
}
```

### File-based Fields (notes that become files on disk)

```typescript
// Present when the note should be written as a file during install/sync
file_path:        string | null;   // e.g. "~/.claude/hooks/block-env.sh"
file_permissions: string | null;   // Unix octal, e.g. "755", "644"
```

Applicable to: system hooks, persona skills, CLAUDE.md, plugin configs.

### Project-specific Fields

```typescript
project:  string;                                    // e.g. "ledger", "starbrite"
status:   'idea' | 'planning' | 'active' | 'done';  // lifecycle stage
```

### Skill-linking Fields

```typescript
skill_ref: string | null;  // links eval cases/results to their parent skill
```

---

## Database Schema

### notes table (existing — extended)

No structural change to the table. All new fields live in the `metadata` JSONB column. The table stays:

```sql
CREATE TABLE notes (
  id         bigserial PRIMARY KEY,
  content    text NOT NULL,
  metadata   jsonb DEFAULT '{}',
  embedding  vector(1536),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

New fields (`domain`, `protection`, `auto_load`, `owner_type`, `owner_id`, `schema_version`, `embedding_model`, `embedding_dimensions`, `file_path`, `file_permissions`) are all stored inside `metadata`.

### audit_log table (new)

```sql
CREATE TABLE audit_log (
  id         bigserial    PRIMARY KEY,
  note_id    bigint,                          -- NO foreign key (survives note deletion)
  domain     text,                            -- which domain was affected
  operation  text         NOT NULL,           -- 'create', 'update', 'delete', 'update_metadata'
  agent      text         NOT NULL,           -- who did it
  diff       jsonb,                           -- old values for rollback
  created_at timestamptz  DEFAULT now()
);

CREATE INDEX idx_audit_note_id ON audit_log (note_id);
CREATE INDEX idx_audit_created ON audit_log (created_at);
CREATE INDEX idx_audit_domain  ON audit_log (domain);
```

**No FK on note_id** — audit entries must survive after the referenced note is deleted. A delete operation stores the full note content in `diff` for rollback.

**diff contents by operation:**
- `create` — null (rollback = delete the note)
- `update` — `{ content: "old content", metadata: { ...old metadata } }`
- `update_metadata` — `{ metadata: { ...old metadata fields that changed } }`
- `delete` — `{ content: "full content", metadata: { ...full metadata } }` (rollback = re-create)

---

## File System Layout

Notes with `file_path` are written to disk during install/sync:

```
~/.claude/
|-- CLAUDE.md                              <- persona | claude-md | protected
|-- hooks/
|   |-- block-env.sh                       <- system  | hook      | protected | 755
|   |-- post-write-ledger.sh               <- system  | hook      | protected | 755
|   |-- session-end-check.sh               <- system  | hook      | protected | 755
|   |-- git-context.sh                     <- system  | hook      | protected | 755
|-- skills/
|   |-- code-review-conventions.md         <- persona | skill     | protected | 644
|   |-- personal-bem-scss.md               <- persona | skill     | protected | 644
|   |-- personal-design-system.md          <- persona | skill     | protected | 644
|-- settings.json                          <- system  | plugin-config | guarded
|-- projects/
    |-- -home-adrian/
        |-- memory/                        <- only auto_load: true notes cached here
            |-- MEMORY.md                  <- search guide (see below)
            |-- personality.md
            |-- behavioral_rules.md
            |-- preferences.md
```

### CLAUDE.md vs MEMORY.md

| File | What it is | Storage |
|------|-----------|---------|
| **CLAUDE.md** | The agent's job description — personality, skills, tools, rules, behavior | Stored as a complete document in Ledger, synced as-is. NOT generated from fragments. |
| **MEMORY.md** | Search guide — tells the agent what exists in Ledger and when to look it up | Stored as a complete document in Ledger, synced as-is. NOT generated. |

**MEMORY.md is a search guide, not a file index.** Instead of pointing to local file copies, it tells the agent what knowledge domains exist in Ledger and when to search:

```markdown
# What I Know About You

## Auto-loaded (always in context)
- Personality, behavioral rules, preferences — already loaded

## Search Ledger when needed
- **Workspace:** dashboard, devlog, devices, dev environment
- **Projects:** search by project name for architecture, status, errors
- **Skills:** search by skill name for eval results, test cases
```

This means:
- `auto_load: true` notes sync locally and load into the AI's context every session
- `auto_load: false` notes stay in the database only — MEMORY.md tells the agent they exist and when to search
- Domain does not determine sync — only `is_auto_load` does
- The memory directory stays small and focused

**Install flow (`ledger init`):**
1. Query: all notes where `file_path IS NOT NULL` and `is_auto_load = true`
2. For each: create directory if missing, write content to `file_path`
3. Set file permissions via `chmod` (e.g. `755` for hooks, `644` for markdown)
4. Verify: hash written file, compare to `content_hash` — if mismatch, warn
5. Write CLAUDE.md and MEMORY.md from their stored notes (type: claude-md, memory-md)

**Permissions reference:**
- `644` — owner read+write, others read-only (documents, markdown)
- `755` — owner read+write+execute, others read+execute (scripts, hooks)

---

## Protection Flow

### Protected file change flow (CLAUDE.md, skills, hooks, personality)

```
User or agent requests change
    |
    v
Is protection = 'protected'?
    |
    +-- No (open/guarded) --> Apply change (guarded shows diff first)
    |
    +-- Yes --> Is requester the user?
                    |
                    +-- No --> BLOCK: "Only the user can modify protected files"
                    |
                    +-- Yes --> Show diff of changes
                                    |
                                    v
                                User confirms: "Yes, intentional"
                                    |
                                    v
                                Apply change locally
                                Write audit_log entry (stores previous version in diff)
                                Upload to Ledger (new source of truth)
                                    |
                                    v
                                Next sync on other machines pulls confirmed version
```

### Immutable notes

Cannot be edited through normal operations. Only the system (migrations, init) can replace them. Type registry and sync rules fall here.

---

## Type Migration Map

Old v1 types to new v2 types:

| v1 Type | v1 Delivery | v2 Domain | v2 Type | v2 Protection |
|---------|-------------|-----------|---------|---------------|
| `user-preference` | persona | persona | `preference` | guarded |
| `persona-rule` | persona | persona | `behavioral-rule` | protected |
| `system-rule` | persona | system | `sync-rule` or `hook` | protected/immutable |
| `code-craft` | persona | persona | `preference` | guarded |
| `architecture-decision` | project | project | `architecture` | guarded |
| `project-status` | project | project | `project-status` | open |
| `event` | project | project | `event` | open |
| `error` | project | project | `error` | open |
| `reference` | knowledge | general (or project if project-scoped) | `reference` | open |
| `knowledge-guide` | knowledge | general (or project if project-scoped) | `knowledge` | open |
| `general` | knowledge | general | `general` | open |
| `skill-reference` | protected | persona or system | `skill` | protected |

Notes:
- `system-rule` splits: some are persona behavioral rules, some are Ledger infrastructure
- `reference` and `knowledge-guide` default to `general` domain; notes with a `project` field go to `project` domain
- `general` type maps to `general` domain (no longer needs per-note reclassification)
- `code-craft` merges into `preference` (coding conventions are preferences)

---

## Backward Compatibility

### delivery field — dropped

`delivery` is replaced by `domain`. No coexistence period. Backfill migration adds `domain` to all notes, all code updated to read `domain`. Old `delivery` values remain as dead data in JSONB but nothing reads them.

### Type aliases

Old type names resolve to new types via alias map:

```typescript
const TYPE_MIGRATION: Record<string, { domain: string; type: string }> = {
  'user-preference':       { domain: 'persona',   type: 'preference' },
  'persona-rule':          { domain: 'persona',   type: 'behavioral-rule' },
  'code-craft':            { domain: 'persona',   type: 'preference' },
  'system-rule':           { domain: 'system',    type: 'sync-rule' },
  'architecture-decision': { domain: 'project',   type: 'architecture' },
  'project-status':        { domain: 'project',   type: 'project-status' },
  'skill-reference':       { domain: 'persona',   type: 'skill' },
  'knowledge-guide':       { domain: 'general',   type: 'knowledge' },
};
```

---

## Backfill Migration

A script that patches all existing ~200 notes:

1. Set `schema_version: 1` on all notes
2. Set `embedding_model: "openai/text-embedding-3-small"` on all notes
3. Set `embedding_dimensions: 1536` on all notes
4. Map old `type` + `delivery` to new `domain` + `type` using TYPE_MIGRATION
6. Set `protection` based on new type defaults
7. Set `auto_load` based on domain defaults
8. Set `owner_type: 'user'`, `owner_id: null` (single user for now)
9. Set `file_path` + `file_permissions` for notes that are files on disk
10. Skip notes that already have new fields (idempotent)

---

## Future: Team Model

Groundwork is laid via `owner_type` and `owner_id`. When teams are added:

```
Team persona   -> shared coding standards all members follow
User persona   -> personal preferences layered on top
Team workspace -> shared dashboards across the team
Team project   -> shared project state
```

Resolution order for conflicts: user overrides team overrides system.

No schema changes needed — just new values in `owner_type: 'team'` and `owner_id: team-uuid`.

---

## What This Enables

| Feature | How the data model supports it |
|---------|-------------------------------|
| **Audit & rollback** | audit_log with domain tracks every change, diff stores old values |
| **Cross-machine consistency** | domain-based sync ensures persona + system + workspace are identical |
| **General knowledge** | general domain gives personal/non-project notes a proper home |
| **Granular context loading** | auto_load prevents workspace/project/general notes from eating context |
| **Write protection** | protection levels prevent accidental overwrites of critical files |
| **Future team support** | owner_type/owner_id ready for multi-user without schema change |
| **Mixed embedding models** | embedding_model/dimensions track per-note, prevent cross-model pollution |
| **Schema evolution** | schema_version enables forward-compatible metadata migrations |
| **Skill organization** | skill type exists in all domains, linked by skill_ref |
| **File reconstruction** | file_path + file_permissions enable full machine rebuild from DB |

---

## Build Order

1. **Audit log migration** — CREATE TABLE audit_log (update draft 005-audit-log.sql with domain column)
2. **Backfill migration** — patch all existing notes with new metadata fields
3. **Update TypeScript** — NoteMetadata interface, inferDomain(), protection checks in all op* functions
4. **Update audit integration** — wire audit_log writes into opAddNote, opUpdateNote, opUpdateMetadata, opDeleteNote
5. **Update MCP server** — expose domain, protection in tool schemas
6. **Update CLI** — add command, config command, type picker reflect new types
7. **Update sync** — use domain instead of delivery for sync decisions
8. **File writer** — install/sync writes file_path notes to disk with correct permissions
9. **Protection flow** — confirmation gates on guarded/protected notes
