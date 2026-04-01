# Ledger v2 Phase 1: Data Model & Audit Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ledger's `delivery`-based organization with a `domain` + `protection` + `auto_load` model, add audit logging, and backfill all ~250 existing notes.

**Architecture:** New `src/lib/domains.ts` module owns all domain/protection/type logic (pure functions, fully testable). New `src/lib/audit.ts` handles audit_log writes. Existing `notes.ts` delegates to both. Backfill is a CLI command that patches metadata in-place. Sync switches from `delivery: persona` to domain-based queries. File writer replaces `local_file` with `file_path` + `file_permissions`.

**Tech Stack:** TypeScript (strict), Supabase (Postgres + pgvector), Vitest, Node.js fs

**Spec:** `docs/superpowers/specs/2026-03-28-v2-data-model-design.txt` and Ledger note #265

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/domains.ts` | Domain model: types, constants, validation, migration map, inference functions |
| `src/lib/audit.ts` | Audit log: write entries to `audit_log` table |
| `src/lib/backfill.ts` | Backfill logic: map v1 metadata → v2 metadata (pure function) |
| `src/lib/file-writer.ts` | Write notes with `file_path` to disk with correct permissions |
| `src/commands/backfill.ts` | CLI command to run the v2 backfill migration |
| `tests/domains.test.ts` | Domain model unit tests |
| `tests/backfill.test.ts` | Backfill logic unit tests |
| `tests/file-writer.test.ts` | File writer unit tests |

### Modified Files

| File | What Changes |
|------|-------------|
| `src/migrations/005-audit-log.sql` | Add `domain` column + index |
| `src/lib/notes.ts` | Update `NoteMetadata` interface, replace `inferDelivery` with `inferDomain`, wire audit + protection into ops |
| `src/lib/generators.ts` | Rewrite `generateMemoryMd()` as search guide; deprecate `generateClaudeMd()` |
| `src/mcp-server.ts` | Add `domain`, `protection` to tool schemas; add domain filter |
| `src/commands/add.ts` | Replace delivery picker with domain-aware type picker |
| `src/commands/sync.ts` | Domain-based sync; `file_path` instead of `local_file`; direct CLAUDE.md from note |
| `src/cli.ts` | Add `backfill` command |
| `tests/type-registry.test.ts` | Update for domain model |

---

## Task 1: Audit Log Migration (SQL)

**Files:**
- Modify: `src/migrations/005-audit-log.sql`

The existing draft is missing the `domain` column specified in the v2 spec. Add it so audit entries record which domain was affected.

- [ ] **Step 1: Update the migration SQL**

Replace the contents of `src/migrations/005-audit-log.sql` with:

```sql
-- Migration 005: Audit Log Table
-- Phase 1 of v2 roadmap
-- Append-only log of every write operation for rollback, sync, rate limiting, and observability
--
-- Design decisions:
--   - No FK on note_id (audit entries must survive note deletion)
--   - JSONB diff column stores old values for rollback
--   - Indexes on note_id (lookup by note), created_at (time-range), domain (filter by domain)

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial    PRIMARY KEY,
  note_id    bigint,
  domain     text,
  operation  text         NOT NULL,
  agent      text         NOT NULL,
  diff       jsonb,
  created_at timestamptz  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_note_id ON audit_log (note_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_domain  ON audit_log (domain);
```

- [ ] **Step 2: Verify the migration file reads correctly**

Run: `cat src/migrations/005-audit-log.sql`

Expected: The updated SQL with `domain text` column and 3 indexes.

- [ ] **Step 3: Commit**

```bash
git add src/migrations/005-audit-log.sql
git commit -m "feat(v2): add domain column to audit_log migration"
```

---

## Task 2: Domain Model Module

**Files:**
- Create: `src/lib/domains.ts`
- Create: `tests/domains.test.ts`

This is the core of v2. All domain, protection, and type logic lives here as pure functions. No Supabase dependency — fully unit testable.

- [ ] **Step 1: Write the failing tests for domain types and constants**

Create `tests/domains.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  type Domain,
  type Protection,
  DOMAIN_TYPES,
  TYPE_DEFAULTS,
  TYPE_MIGRATION,
  inferDomain,
  getProtectionDefault,
  getAutoLoadDefault,
  validateDomainType,
  resolveV1Type,
  getAllV2Types,
} from '../src/lib/domains.js';

describe('DOMAIN_TYPES', () => {
  it('has 4 domains', () => {
    expect(Object.keys(DOMAIN_TYPES)).toHaveLength(4);
  });

  it('persona domain has 5 types', () => {
    expect(DOMAIN_TYPES.persona).toEqual([
      'personality', 'behavioral-rule', 'preference', 'skill', 'claude-md',
    ]);
  });

  it('system domain has 5 types', () => {
    expect(DOMAIN_TYPES.system).toEqual([
      'hook', 'plugin-config', 'type-registry', 'sync-rule', 'skill',
    ]);
  });

  it('workspace domain has 5 types', () => {
    expect(DOMAIN_TYPES.workspace).toEqual([
      'dashboard', 'device-registry', 'environment', 'eval-result', 'skill',
    ]);
  });

  it('project domain has 8 types', () => {
    expect(DOMAIN_TYPES.project).toEqual([
      'architecture', 'project-status', 'event', 'error',
      'reference', 'knowledge', 'skill', 'eval-result',
    ]);
  });
});

describe('inferDomain', () => {
  it('returns persona for personality', () => {
    expect(inferDomain('personality')).toBe('persona');
  });

  it('returns system for hook', () => {
    expect(inferDomain('hook')).toBe('system');
  });

  it('returns workspace for dashboard', () => {
    expect(inferDomain('dashboard')).toBe('workspace');
  });

  it('returns project for architecture', () => {
    expect(inferDomain('architecture')).toBe('project');
  });

  it('handles skill ambiguity by returning first match (persona)', () => {
    expect(inferDomain('skill')).toBe('persona');
  });

  it('returns project for unknown types', () => {
    expect(inferDomain('nonexistent')).toBe('project');
  });
});

describe('getProtectionDefault', () => {
  it('returns protected for personality', () => {
    expect(getProtectionDefault('personality')).toBe('protected');
  });

  it('returns guarded for preference', () => {
    expect(getProtectionDefault('preference')).toBe('guarded');
  });

  it('returns immutable for type-registry', () => {
    expect(getProtectionDefault('type-registry')).toBe('immutable');
  });

  it('returns open for error', () => {
    expect(getProtectionDefault('error')).toBe('open');
  });

  it('returns open for unknown types', () => {
    expect(getProtectionDefault('nonexistent')).toBe('open');
  });
});

describe('getAutoLoadDefault', () => {
  it('system domain always true', () => {
    expect(getAutoLoadDefault('system', 'hook')).toBe(true);
  });

  it('persona domain defaults true', () => {
    expect(getAutoLoadDefault('persona', 'personality')).toBe(true);
  });

  it('workspace domain defaults false', () => {
    expect(getAutoLoadDefault('workspace', 'dashboard')).toBe(false);
  });

  it('project domain always false', () => {
    expect(getAutoLoadDefault('project', 'architecture')).toBe(false);
  });
});

describe('validateDomainType', () => {
  it('accepts valid domain+type pair', () => {
    expect(validateDomainType('persona', 'preference')).toBeNull();
  });

  it('rejects invalid domain+type pair', () => {
    expect(validateDomainType('persona', 'hook')).not.toBeNull();
  });

  it('accepts skill in any domain', () => {
    expect(validateDomainType('persona', 'skill')).toBeNull();
    expect(validateDomainType('system', 'skill')).toBeNull();
    expect(validateDomainType('workspace', 'skill')).toBeNull();
    expect(validateDomainType('project', 'skill')).toBeNull();
  });
});

describe('resolveV1Type', () => {
  it('maps user-preference to persona/preference', () => {
    expect(resolveV1Type('user-preference')).toEqual({ domain: 'persona', type: 'preference' });
  });

  it('maps persona-rule to persona/behavioral-rule', () => {
    expect(resolveV1Type('persona-rule')).toEqual({ domain: 'persona', type: 'behavioral-rule' });
  });

  it('maps code-craft to persona/preference', () => {
    expect(resolveV1Type('code-craft')).toEqual({ domain: 'persona', type: 'preference' });
  });

  it('maps architecture-decision to project/architecture', () => {
    expect(resolveV1Type('architecture-decision')).toEqual({ domain: 'project', type: 'architecture' });
  });

  it('maps skill-reference to persona/skill', () => {
    expect(resolveV1Type('skill-reference')).toEqual({ domain: 'persona', type: 'skill' });
  });

  it('returns null for types not in migration map', () => {
    expect(resolveV1Type('event')).toBeNull();
  });

  it('returns null for unknown types', () => {
    expect(resolveV1Type('nonexistent')).toBeNull();
  });
});

describe('TYPE_MIGRATION', () => {
  it('maps all 8 v1 types that need renaming', () => {
    expect(Object.keys(TYPE_MIGRATION)).toHaveLength(8);
  });
});

describe('getAllV2Types', () => {
  it('returns flat list of all unique type names', () => {
    const types = getAllV2Types();
    expect(types).toContain('personality');
    expect(types).toContain('hook');
    expect(types).toContain('dashboard');
    expect(types).toContain('architecture');
    // skill appears in multiple domains but should only appear once
    expect(types.filter(t => t === 'skill')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/adrian/repos/ledger && npm test -- tests/domains.test.ts`

Expected: FAIL — module `../src/lib/domains.js` not found.

- [ ] **Step 3: Implement the domain model module**

Create `src/lib/domains.ts`:

```typescript
// --- Domain Model ---
// Pure functions for domain, protection, type validation, and v1→v2 migration.
// No Supabase dependency — fully unit testable.

export type Domain = 'system' | 'persona' | 'workspace' | 'project';
export type Protection = 'open' | 'guarded' | 'protected' | 'immutable';

export type PersonaType = 'personality' | 'behavioral-rule' | 'preference' | 'skill' | 'claude-md';
export type SystemType = 'hook' | 'plugin-config' | 'type-registry' | 'sync-rule' | 'skill';
export type WorkspaceType = 'dashboard' | 'device-registry' | 'environment' | 'eval-result' | 'skill';
export type ProjectType = 'architecture' | 'project-status' | 'event' | 'error' | 'reference' | 'knowledge' | 'skill' | 'eval-result';

export type NoteType = PersonaType | SystemType | WorkspaceType | ProjectType;

// --- Domain → Types mapping ---

export const DOMAIN_TYPES: Record<Domain, readonly string[]> = {
  persona:   ['personality', 'behavioral-rule', 'preference', 'skill', 'claude-md'],
  system:    ['hook', 'plugin-config', 'type-registry', 'sync-rule', 'skill'],
  workspace: ['dashboard', 'device-registry', 'environment', 'eval-result', 'skill'],
  project:   ['architecture', 'project-status', 'event', 'error', 'reference', 'knowledge', 'skill', 'eval-result'],
} as const;

// --- Protection defaults per type ---

export const TYPE_DEFAULTS: Record<string, { protection: Protection; autoLoad: boolean }> = {
  // Persona
  'personality':      { protection: 'protected', autoLoad: true },
  'behavioral-rule':  { protection: 'protected', autoLoad: true },
  'preference':       { protection: 'guarded',   autoLoad: true },
  'claude-md':        { protection: 'protected', autoLoad: true },
  // System
  'hook':             { protection: 'protected', autoLoad: false },
  'plugin-config':    { protection: 'guarded',   autoLoad: false },
  'type-registry':    { protection: 'immutable', autoLoad: false },
  'sync-rule':        { protection: 'immutable', autoLoad: false },
  // Workspace
  'dashboard':        { protection: 'guarded',   autoLoad: false },
  'device-registry':  { protection: 'guarded',   autoLoad: false },
  'environment':      { protection: 'guarded',   autoLoad: false },
  // Project
  'architecture':     { protection: 'guarded',   autoLoad: false },
  'project-status':   { protection: 'open',      autoLoad: false },
  'event':            { protection: 'open',      autoLoad: false },
  'error':            { protection: 'open',      autoLoad: false },
  'reference':        { protection: 'open',      autoLoad: false },
  'knowledge':        { protection: 'open',      autoLoad: false },
  'eval-result':      { protection: 'open',      autoLoad: false },
};

// Note: 'skill' has domain-dependent defaults handled by getProtectionDefault/getAutoLoadDefault

// --- v1 → v2 type migration map ---

export const TYPE_MIGRATION: Record<string, { domain: Domain; type: string }> = {
  'user-preference':       { domain: 'persona',  type: 'preference' },
  'persona-rule':          { domain: 'persona',  type: 'behavioral-rule' },
  'code-craft':            { domain: 'persona',  type: 'preference' },
  'system-rule':           { domain: 'system',   type: 'sync-rule' },
  'architecture-decision': { domain: 'project',  type: 'architecture' },
  'project-status':        { domain: 'project',  type: 'project-status' },
  'skill-reference':       { domain: 'persona',  type: 'skill' },
  'knowledge-guide':       { domain: 'project',  type: 'knowledge' },
};

// --- Inference functions ---

/** Given a v2 type name, return which domain it belongs to. Returns first match for ambiguous types (skill). */
export function inferDomain(type: string): Domain {
  for (const [domain, types] of Object.entries(DOMAIN_TYPES)) {
    if (types.includes(type)) return domain as Domain;
  }
  return 'project'; // default for unknown types
}

/** Given a type name, return the default protection level. */
export function getProtectionDefault(type: string): Protection {
  // Skill defaults depend on context; use protected as sensible default
  if (type === 'skill') return 'protected';
  return TYPE_DEFAULTS[type]?.protection ?? 'open';
}

/** Given a domain and type, return the default auto_load value. */
export function getAutoLoadDefault(domain: Domain, _type: string): boolean {
  if (domain === 'system') return true;
  if (domain === 'persona') return true;
  return false;
}

/** Validate that a type belongs to the specified domain. Returns null if valid, error string if not. */
export function validateDomainType(domain: Domain, type: string): string | null {
  const validTypes = DOMAIN_TYPES[domain];
  if (!validTypes) return `Unknown domain: ${domain}`;
  if (!validTypes.includes(type)) {
    return `Type "${type}" is not valid for domain "${domain}". Valid types: ${validTypes.join(', ')}`;
  }
  return null;
}

/** Resolve a v1 type name to its v2 domain + type. Returns null if no migration needed. */
export function resolveV1Type(oldType: string): { domain: Domain; type: string } | null {
  return TYPE_MIGRATION[oldType] ?? null;
}

/** Get a flat, deduplicated list of all v2 type names. */
export function getAllV2Types(): string[] {
  const seen = new Set<string>();
  for (const types of Object.values(DOMAIN_TYPES)) {
    for (const type of types) seen.add(type);
  }
  return [...seen];
}

/** Check if a type name is a valid v2 type (exists in any domain). */
export function isV2Type(type: string): boolean {
  return getAllV2Types().includes(type);
}

/** Check if a type name is a v1 type that needs migration. */
export function isV1Type(type: string): boolean {
  return type in TYPE_MIGRATION;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/adrian/repos/ledger && npm test -- tests/domains.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domains.ts tests/domains.test.ts
git commit -m "feat(v2): add domain model module with types, constants, and inference functions"
```

---

## Task 3: Backfill Module

**Files:**
- Create: `src/lib/backfill.ts`
- Create: `tests/backfill.test.ts`

Pure function that takes v1 note metadata and returns v2 metadata. No DB calls — the CLI command (Task 4) handles the DB loop.

- [ ] **Step 1: Write the failing tests**

Create `tests/backfill.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { backfillMetadata } from '../src/lib/backfill.js';

describe('backfillMetadata', () => {
  it('sets schema_version to 1', () => {
    const result = backfillMetadata({ type: 'event', delivery: 'project' });
    expect(result.schema_version).toBe(1);
  });

  it('sets embedding tracking fields', () => {
    const result = backfillMetadata({ type: 'event' });
    expect(result.embedding_model).toBe('openai/text-embedding-3-small');
    expect(result.embedding_dimensions).toBe(1536);
  });

  it('sets owner_type to user and owner_id to null', () => {
    const result = backfillMetadata({ type: 'event' });
    expect(result.owner_type).toBe('user');
    expect(result.owner_id).toBeNull();
  });

  it('migrates user-preference to persona/preference', () => {
    const result = backfillMetadata({ type: 'user-preference', delivery: 'persona' });
    expect(result.type).toBe('preference');
    expect(result.domain).toBe('persona');
  });

  it('migrates persona-rule to persona/behavioral-rule', () => {
    const result = backfillMetadata({ type: 'persona-rule', delivery: 'persona' });
    expect(result.type).toBe('behavioral-rule');
    expect(result.domain).toBe('persona');
  });

  it('migrates code-craft to persona/preference', () => {
    const result = backfillMetadata({ type: 'code-craft', delivery: 'persona' });
    expect(result.type).toBe('preference');
    expect(result.domain).toBe('persona');
  });

  it('migrates system-rule to system/sync-rule', () => {
    const result = backfillMetadata({ type: 'system-rule', delivery: 'persona' });
    expect(result.type).toBe('sync-rule');
    expect(result.domain).toBe('system');
  });

  it('migrates architecture-decision to project/architecture', () => {
    const result = backfillMetadata({ type: 'architecture-decision', delivery: 'project' });
    expect(result.type).toBe('architecture');
    expect(result.domain).toBe('project');
  });

  it('migrates skill-reference to persona/skill', () => {
    const result = backfillMetadata({ type: 'skill-reference', delivery: 'protected' });
    expect(result.type).toBe('skill');
    expect(result.domain).toBe('persona');
  });

  it('migrates knowledge-guide to project/knowledge', () => {
    const result = backfillMetadata({ type: 'knowledge-guide', delivery: 'knowledge' });
    expect(result.type).toBe('knowledge');
    expect(result.domain).toBe('project');
  });

  it('keeps event type, infers project domain', () => {
    const result = backfillMetadata({ type: 'event', delivery: 'project' });
    expect(result.type).toBe('event');
    expect(result.domain).toBe('project');
  });

  it('keeps error type, infers project domain', () => {
    const result = backfillMetadata({ type: 'error', delivery: 'project' });
    expect(result.type).toBe('error');
    expect(result.domain).toBe('project');
  });

  it('maps reference with delivery=knowledge to project/reference', () => {
    const result = backfillMetadata({ type: 'reference', delivery: 'knowledge' });
    expect(result.type).toBe('reference');
    expect(result.domain).toBe('project');
  });

  it('maps general with delivery=knowledge to project/knowledge', () => {
    const result = backfillMetadata({ type: 'general', delivery: 'knowledge' });
    expect(result.type).toBe('knowledge');
    expect(result.domain).toBe('project');
  });

  it('sets protection from type defaults', () => {
    const result = backfillMetadata({ type: 'persona-rule', delivery: 'persona' });
    expect(result.protection).toBe('protected');
  });

  it('sets auto_load from domain defaults', () => {
    const persona = backfillMetadata({ type: 'persona-rule', delivery: 'persona' });
    expect(persona.auto_load).toBe(true);

    const project = backfillMetadata({ type: 'event', delivery: 'project' });
    expect(project.auto_load).toBe(false);
  });

  it('is idempotent — skips notes that already have domain', () => {
    const alreadyMigrated = {
      type: 'preference',
      domain: 'persona',
      protection: 'guarded',
      auto_load: true,
      schema_version: 1,
    };
    const result = backfillMetadata(alreadyMigrated);
    expect(result).toEqual(alreadyMigrated);
  });

  it('preserves existing metadata fields', () => {
    const result = backfillMetadata({
      type: 'event',
      delivery: 'project',
      project: 'ledger',
      upsert_key: 'ledger-devlog',
      description: 'Dev timeline',
    });
    expect(result.project).toBe('ledger');
    expect(result.upsert_key).toBe('ledger-devlog');
    expect(result.description).toBe('Dev timeline');
  });

  it('derives file_path from local_file for persona notes', () => {
    const result = backfillMetadata({
      type: 'persona-rule',
      delivery: 'persona',
      local_file: 'feedback_communication_style.md',
    });
    expect(result.file_path).toContain('feedback_communication_style.md');
    expect(result.file_permissions).toBe('644');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/adrian/repos/ledger && npm test -- tests/backfill.test.ts`

Expected: FAIL — module `../src/lib/backfill.js` not found.

- [ ] **Step 3: Implement the backfill module**

Create `src/lib/backfill.ts`:

```typescript
import { homedir } from 'os';
import { resolve } from 'path';
import {
  type Domain,
  TYPE_MIGRATION,
  inferDomain,
  getProtectionDefault,
  getAutoLoadDefault,
  isV2Type,
} from './domains.js';

const HOME_PROJECT_DIR = homedir().replace(/\//g, '-');
const MEMORY_DIR = resolve(homedir(), `.claude/projects/${HOME_PROJECT_DIR}/memory`);

/**
 * Backfill v1 note metadata to v2 format.
 * Pure function — no DB calls. Idempotent: skips notes that already have `domain`.
 */
export function backfillMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  // Idempotent: if already has domain + schema_version, skip
  if (metadata.domain && metadata.schema_version) {
    return metadata;
  }

  const result = { ...metadata };
  const oldType = metadata.type as string | undefined;

  // --- Step 1: Migrate type + infer domain ---
  let newType = oldType ?? 'knowledge';
  let domain: Domain;

  const migration = oldType ? TYPE_MIGRATION[oldType] : undefined;
  if (migration) {
    newType = migration.type;
    domain = migration.domain;
  } else if (oldType === 'general') {
    newType = 'knowledge';
    domain = 'project';
  } else if (oldType && isV2Type(oldType)) {
    domain = inferDomain(oldType);
  } else {
    newType = 'knowledge';
    domain = 'project';
  }

  result.type = newType;
  result.domain = domain;

  // --- Step 2: Set protection and auto_load from defaults ---
  result.protection = getProtectionDefault(newType);
  result.auto_load = getAutoLoadDefault(domain, newType);

  // --- Step 3: Ownership (single user for now) ---
  result.owner_type = 'user';
  result.owner_id = null;

  // --- Step 4: Schema + embedding tracking ---
  result.schema_version = 1;
  result.embedding_model = 'openai/text-embedding-3-small';
  result.embedding_dimensions = 1536;

  // --- Step 5: Derive file_path from local_file for persona notes ---
  const localFile = metadata.local_file as string | undefined;
  if (localFile && domain === 'persona' && !result.file_path) {
    result.file_path = resolve(MEMORY_DIR, localFile);
    result.file_permissions = '644';
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/adrian/repos/ledger && npm test -- tests/backfill.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backfill.ts tests/backfill.test.ts
git commit -m "feat(v2): add backfill module for v1→v2 metadata migration"
```

---

## Task 4: Backfill CLI Command

**Files:**
- Create: `src/commands/backfill.ts`
- Modify: `src/cli.ts` (add backfill command registration)

This command fetches all notes from Supabase, runs `backfillMetadata()` on each, and writes the updated metadata back. Idempotent — safe to run multiple times.

- [ ] **Step 1: Implement the backfill command**

Create `src/commands/backfill.ts`:

```typescript
import type { LedgerConfig } from '../lib/config.js';
import { backfillMetadata } from '../lib/backfill.js';

interface BackfillOptions {
  dryRun: boolean;
}

export async function backfill(config: LedgerConfig, options: BackfillOptions): Promise<void> {
  const { dryRun } = options;

  console.error('Fetching all notes...');
  const { data: notes, error } = await config.supabase
    .from('notes')
    .select('id, metadata')
    .order('id', { ascending: true });

  if (error) {
    console.error(`Error fetching notes: ${error.message}`);
    process.exit(1);
  }

  if (!notes || notes.length === 0) {
    console.error('No notes found.');
    return;
  }

  console.error(`Found ${notes.length} notes. Running v2 backfill...`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const note of notes) {
    const oldMeta = note.metadata as Record<string, unknown>;
    const newMeta = backfillMetadata(oldMeta);

    // Check if anything changed (idempotent skip)
    if (JSON.stringify(oldMeta) === JSON.stringify(newMeta)) {
      skipped++;
      continue;
    }

    if (dryRun) {
      const oldType = oldMeta.type as string ?? '?';
      const newType = newMeta.type as string ?? '?';
      const domain = newMeta.domain as string ?? '?';
      const key = oldMeta.upsert_key as string ?? `id-${note.id}`;
      console.error(`  [${note.id}] ${key}: ${oldType} → ${domain}/${newType}`);
      migrated++;
      continue;
    }

    const { error: updateError } = await config.supabase
      .from('notes')
      .update({ metadata: newMeta })
      .eq('id', note.id);

    if (updateError) {
      console.error(`  [${note.id}] ERROR: ${updateError.message}`);
      errors++;
    } else {
      migrated++;
    }
  }

  console.error(`\nBackfill ${dryRun ? '(dry run) ' : ''}complete:`);
  console.error(`  ${migrated} migrated, ${skipped} already up-to-date, ${errors} errors`);

  if (dryRun && migrated > 0) {
    console.error('\nRun without --dry-run to apply changes.');
  }
}
```

- [ ] **Step 2: Register the backfill command in the CLI**

In `src/cli.ts`, add after the existing command registrations (find the section where commands are defined with `program.command()`):

```typescript
program
  .command('backfill')
  .description('Migrate all notes to v2 metadata format (domain, protection, auto_load)')
  .option('--dry-run', 'Show what would change without modifying anything', false)
  .action(async (opts) => {
    const config = loadConfig();
    const { backfill } = await import('./commands/backfill.js');
    await backfill(config, { dryRun: opts.dryRun });
  });
```

- [ ] **Step 3: Verify the command registers**

Run: `cd /home/adrian/repos/ledger && npx tsx src/cli.ts backfill --help`

Expected: Shows usage for the backfill command with `--dry-run` option.

- [ ] **Step 4: Commit**

```bash
git add src/commands/backfill.ts src/cli.ts
git commit -m "feat(v2): add backfill CLI command for v1→v2 metadata migration"
```

---

## Task 5: Update NoteMetadata & Type Registry

**Files:**
- Modify: `src/lib/notes.ts:12-26` (NoteMetadata interface)
- Modify: `src/lib/notes.ts:47-99` (type registry functions)
- Modify: `tests/type-registry.test.ts` (update for new model)

Updates the core types to support v2 while keeping backward compatibility via the domain module's `resolveV1Type`.

- [ ] **Step 1: Update the NoteMetadata interface**

In `src/lib/notes.ts`, replace the `NoteMetadata` interface (lines 12-26) with:

```typescript
export interface NoteMetadata {
  // v2 domain model
  domain?: 'system' | 'persona' | 'workspace' | 'project';
  type?: string;
  protection?: 'open' | 'guarded' | 'protected' | 'immutable';
  auto_load?: boolean;

  // Ownership
  owner_type?: 'system' | 'user' | 'team';
  owner_id?: string | null;

  // Identity & dedup
  upsert_key?: string;
  description?: string;
  content_hash?: string;
  schema_version?: number;

  // Provenance
  agent?: string;
  project?: string;
  status?: NoteStatus;

  // Embedding tracking
  embedding_model?: string;
  embedding_dimensions?: number;

  // File-based notes
  file_path?: string | null;
  file_permissions?: string | null;

  // Skill linking
  skill_ref?: string | null;

  // Legacy (kept for backward compat during migration)
  delivery?: 'persona' | 'project' | 'knowledge' | 'protected';
  local_file?: string;

  // Chunking
  chunk_group?: string;
  chunk_index?: number;
  total_chunks?: number;

  [key: string]: unknown;
}
```

- [ ] **Step 2: Add domain module import and update type registry**

At the top of `src/lib/notes.ts`, after the existing imports, add:

```typescript
import {
  type Domain,
  type Protection,
  inferDomain as inferDomainFromType,
  getProtectionDefault,
  getAutoLoadDefault,
  resolveV1Type,
  isV2Type,
  getAllV2Types,
  DOMAIN_TYPES,
} from './domains.js';
```

Replace the `DeliveryTier` type, `BUILTIN_TYPES`, `TYPE_ALIASES`, `resolveTypeAlias`, `getTypeRegistry`, `inferDelivery`, `getRegisteredTypes`, `isRegisteredType`, and `registerType` (lines 47-99) with:

```typescript
// Re-export for backward compat
export type DeliveryTier = 'persona' | 'project' | 'knowledge' | 'protected';
export type { Domain, Protection };

// --- Built-in Type Registry (v2: domain-based) ---

export const BUILTIN_TYPES: Record<string, DeliveryTier> = {
  // v2 types mapped to legacy delivery tier for backward compat
  'personality':      'persona',
  'behavioral-rule':  'persona',
  'preference':       'persona',
  'skill':            'persona',
  'claude-md':        'persona',
  'hook':             'persona',
  'plugin-config':    'persona',
  'type-registry':    'persona',
  'sync-rule':        'persona',
  'dashboard':        'project',
  'device-registry':  'project',
  'environment':      'project',
  'eval-result':      'project',
  'architecture':     'project',
  'project-status':   'project',
  'event':            'project',
  'error':            'project',
  'reference':        'knowledge',
  'knowledge':        'knowledge',
  'general':          'knowledge',
  // Legacy v1 names still accepted
  'user-preference':       'persona',
  'persona-rule':          'persona',
  'system-rule':           'persona',
  'code-craft':            'persona',
  'architecture-decision': 'project',
  'knowledge-guide':       'knowledge',
  'skill-reference':       'persona',
};

function resolveTypeAlias(type: string): string {
  const migration = resolveV1Type(type);
  if (migration) return migration.type;
  if (type === 'feedback') return 'general';
  return type;
}

export function getTypeRegistry(): Record<string, DeliveryTier> {
  const config = loadConfigFile();
  return { ...BUILTIN_TYPES, ...(config.types ?? {}) };
}

/** Infer domain from a note type. Handles both v1 and v2 type names. */
export function inferDomain(noteType: string): Domain {
  const v1 = resolveV1Type(noteType);
  if (v1) return v1.domain;
  return inferDomainFromType(noteType);
}

/** Legacy: infer delivery tier from note type. Use inferDomain for new code. */
export function inferDelivery(noteType: string): DeliveryTier {
  const resolved = resolveTypeAlias(noteType);
  return getTypeRegistry()[resolved] ?? 'knowledge';
}

export function getRegisteredTypes(): string[] {
  return Object.keys(getTypeRegistry());
}

export function isRegisteredType(noteType: string): boolean {
  const resolved = resolveTypeAlias(noteType);
  return isV2Type(resolved) || resolved in getTypeRegistry();
}

export function registerType(name: string, delivery: DeliveryTier): void {
  const config = loadConfigFile();
  if (!config.types) config.types = {};
  config.types[name] = delivery;
  saveConfigFile(config);
}
```

- [ ] **Step 3: Update type-registry tests**

Replace the contents of `tests/type-registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BUILTIN_TYPES, getTypeRegistry, inferDelivery, inferDomain, getRegisteredTypes, isRegisteredType, validateTypeName } from '../src/lib/notes.js';
import type { DeliveryTier } from '../src/lib/notes.js';

describe('BUILTIN_TYPES', () => {
  it('contains v2 types and legacy v1 types', () => {
    expect(BUILTIN_TYPES['personality']).toBe('persona');
    expect(BUILTIN_TYPES['preference']).toBe('persona');
    expect(BUILTIN_TYPES['behavioral-rule']).toBe('persona');
    expect(BUILTIN_TYPES['user-preference']).toBe('persona');
    expect(BUILTIN_TYPES['code-craft']).toBe('persona');
  });

  it('maps project types correctly', () => {
    expect(BUILTIN_TYPES['architecture']).toBe('project');
    expect(BUILTIN_TYPES['project-status']).toBe('project');
    expect(BUILTIN_TYPES['event']).toBe('project');
    expect(BUILTIN_TYPES['error']).toBe('project');
  });

  it('maps knowledge types correctly', () => {
    expect(BUILTIN_TYPES['reference']).toBe('knowledge');
    expect(BUILTIN_TYPES['knowledge']).toBe('knowledge');
    expect(BUILTIN_TYPES['general']).toBe('knowledge');
  });
});

describe('inferDomain', () => {
  it('returns persona for persona types', () => {
    expect(inferDomain('personality')).toBe('persona');
    expect(inferDomain('preference')).toBe('persona');
    expect(inferDomain('behavioral-rule')).toBe('persona');
  });

  it('returns project for project types', () => {
    expect(inferDomain('architecture')).toBe('project');
    expect(inferDomain('event')).toBe('project');
  });

  it('handles v1 type names via migration', () => {
    expect(inferDomain('user-preference')).toBe('persona');
    expect(inferDomain('architecture-decision')).toBe('project');
    expect(inferDomain('code-craft')).toBe('persona');
  });
});

describe('inferDelivery (legacy)', () => {
  it('returns correct tier for v2 types', () => {
    expect(inferDelivery('preference')).toBe('persona');
    expect(inferDelivery('architecture')).toBe('project');
    expect(inferDelivery('reference')).toBe('knowledge');
  });

  it('resolves v1 types via alias', () => {
    expect(inferDelivery('user-preference')).toBe('persona');
    expect(inferDelivery('architecture-decision')).toBe('project');
  });

  it('defaults unknown types to knowledge', () => {
    expect(inferDelivery('nonexistent-type')).toBe('knowledge');
  });

  it('resolves feedback alias to general → knowledge', () => {
    expect(inferDelivery('feedback')).toBe('knowledge');
  });
});

describe('getRegisteredTypes', () => {
  it('returns all type names including v2 types', () => {
    const types = getRegisteredTypes();
    expect(types).toContain('personality');
    expect(types).toContain('preference');
    expect(types).toContain('behavioral-rule');
    expect(types).toContain('hook');
    expect(types).toContain('dashboard');
    expect(types).toContain('architecture');
  });
});

describe('isRegisteredType', () => {
  it('returns true for v2 types', () => {
    expect(isRegisteredType('personality')).toBe(true);
    expect(isRegisteredType('preference')).toBe(true);
    expect(isRegisteredType('hook')).toBe(true);
  });

  it('returns true for v1 types (resolved via alias)', () => {
    expect(isRegisteredType('user-preference')).toBe(true);
    expect(isRegisteredType('code-craft')).toBe(true);
    expect(isRegisteredType('feedback')).toBe(true);
  });

  it('returns false for unknown types', () => {
    expect(isRegisteredType('nonexistent-type')).toBe(false);
  });
});

describe('validateTypeName', () => {
  it('accepts valid type names', () => {
    expect(validateTypeName('wine-log')).toBeNull();
    expect(validateTypeName('my-custom-type')).toBeNull();
    expect(validateTypeName('ab')).toBeNull();
  });

  it('rejects names starting with number', () => {
    expect(validateTypeName('1bad')).not.toBeNull();
  });

  it('rejects uppercase', () => {
    expect(validateTypeName('Wine-Log')).not.toBeNull();
  });

  it('rejects special characters', () => {
    expect(validateTypeName('wine_log')).not.toBeNull();
    expect(validateTypeName('wine.log')).not.toBeNull();
  });

  it('rejects too short', () => {
    expect(validateTypeName('a')).not.toBeNull();
  });

  it('rejects too long', () => {
    expect(validateTypeName('a'.repeat(51))).not.toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateTypeName('')).not.toBeNull();
  });
});

describe('type registry sync merge', () => {
  it('union merges non-conflicting types', () => {
    const local: Record<string, DeliveryTier> = { 'wine-log': 'project' };
    const remote: Record<string, DeliveryTier> = { 'recipe': 'knowledge' };
    const merged = { ...remote, ...local };
    expect(merged).toEqual({ 'wine-log': 'project', 'recipe': 'knowledge' });
  });

  it('local wins on conflict', () => {
    const local: Record<string, DeliveryTier> = { 'wine-log': 'project' };
    const remote: Record<string, DeliveryTier> = { 'wine-log': 'persona' };
    const merged = { ...remote, ...local };
    expect(merged['wine-log']).toBe('project');
  });
});
```

- [ ] **Step 4: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS (domains, backfill, type-registry, and all existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notes.ts tests/type-registry.test.ts
git commit -m "feat(v2): update NoteMetadata interface and type registry for domain model"
```

---

## Task 6: Audit Log Module & Integration

**Files:**
- Create: `src/lib/audit.ts`
- Modify: `src/lib/notes.ts` (wire audit into `createNewNote`, `upsertExistingNote`, `opUpdateNote`, `opUpdateMetadata`, `opDeleteNote`)

- [ ] **Step 1: Implement the audit module**

Create `src/lib/audit.ts`:

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';

export type AuditOperation = 'create' | 'update' | 'delete' | 'update_metadata';

/**
 * Write an entry to the audit_log table.
 * Silently fails if the audit_log table doesn't exist yet (pre-migration).
 */
export async function writeAuditEntry(
  supabase: SupabaseClient,
  noteId: number | null,
  domain: string | null,
  operation: AuditOperation,
  agent: string,
  diff: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await supabase
    .from('audit_log')
    .insert({
      note_id: noteId,
      domain,
      operation,
      agent,
      diff,
    });

  if (error) {
    console.error(`[audit] Warning: failed to write audit entry: ${error.message}`);
  }
}
```

- [ ] **Step 2: Wire audit into notes.ts**

In `src/lib/notes.ts`, add import at the top:

```typescript
import { writeAuditEntry } from './audit.js';
```

In `createNewNote`, after the successful single-chunk insert (`if (error) return ...` around line 791), add:

```typescript
    await writeAuditEntry(
      clients.supabase, data.id,
      (fullMetadata.domain as string) ?? null,
      'create', (fullMetadata.agent as string) ?? 'unknown', null,
    );
```

After the multi-chunk loop success (around line 808), add:

```typescript
  await writeAuditEntry(
    clients.supabase, ids[0],
    (fullMetadata.domain as string) ?? null,
    'create', (fullMetadata.agent as string) ?? 'unknown', null,
  );
```

In `upsertExistingNote`, after the successful single→single SQL UPDATE (around line 733), add:

```typescript
    await writeAuditEntry(
      clients.supabase, data.id,
      (fullMetadata.domain as string) ?? null,
      'update', (fullMetadata.agent as string) ?? 'unknown',
      { content: existing.metadata.content_hash, metadata: existing.metadata },
    );
```

In `opUpdateNote`, after the successful single→single update (around line 871), add:

```typescript
    await writeAuditEntry(
      clients.supabase, data.id,
      (existingMeta.domain as string) ?? null,
      'update', (baseMeta.agent as string) ?? 'unknown',
      { content: existing.content, metadata: existingMeta },
    );
```

In `opUpdateMetadata`, after the successful metadata update (around line 966), add:

```typescript
  const changedFields: Record<string, unknown> = {};
  for (const key of Object.keys(metadata)) {
    const oldVal = (existing.metadata as Record<string, unknown>)[key];
    if (oldVal !== metadata[key]) changedFields[key] = oldVal;
  }
  await writeAuditEntry(
    clients.supabase, id,
    (merged.domain as string) ?? null,
    'update_metadata', (merged.agent as string) ?? 'unknown',
    { metadata: changedFields },
  );
```

In `opDeleteNote`, before the delete operations (around line 1010), add:

```typescript
  await writeAuditEntry(
    clients.supabase, id,
    (meta.domain as string) ?? null,
    'delete', 'user',
    { content: existing.content, metadata: meta },
  );
```

- [ ] **Step 3: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/audit.ts src/lib/notes.ts
git commit -m "feat(v2): add audit log module and wire into all note operations"
```

---

## Task 7: Protection Flow

**Files:**
- Modify: `src/lib/notes.ts`

Replace delivery-based protection gates with the new 4-level system (open, guarded, protected, immutable).

- [ ] **Step 1: Create a protection check helper**

In `src/lib/notes.ts`, add after the shared helpers section (around line 300):

```typescript
/**
 * Check if an operation should be blocked or confirmed based on protection level.
 * Returns null if operation is allowed, or an OperationResult if blocked/needs approval.
 */
function checkProtection(
  noteId: number,
  meta: Record<string, unknown>,
  operation: string,
  confirmed: boolean,
): OperationResult | null {
  const protection = (meta.protection as string) ?? (meta.delivery === 'protected' ? 'protected' : 'open');
  const uKey = meta.upsert_key as string | undefined;
  const label = uKey || `id ${noteId}`;
  const noteType = meta.type as string | undefined;

  if (protection === 'immutable') {
    return {
      status: 'error',
      message: `BLOCKED — "${label}" (type: ${noteType ?? 'unknown'}) is immutable and cannot be ${operation}d. Immutable notes are system-managed only.`,
    };
  }

  if (protection === 'protected' && !confirmed) {
    return {
      status: 'confirm',
      message: `PROTECTED NOTE — "${label}" (type: ${noteType ?? 'unknown'}) requires explicit user approval to ${operation}.\n\nTo proceed, re-call with confirmed: true.`,
    };
  }

  if (protection === 'guarded' && !confirmed) {
    return {
      status: 'confirm',
      message: `GUARDED NOTE — "${label}" (type: ${noteType ?? 'unknown'}) requires confirmation to ${operation}.\n\nTo proceed, re-call with confirmed: true.`,
    };
  }

  return null;
}
```

- [ ] **Step 2: Replace protection checks in opUpdateNote**

In `opUpdateNote` (around lines 828-837), replace the `existingDelivery === 'protected'` block with:

```typescript
  const protectionCheck = checkProtection(id, existing.metadata as Record<string, unknown>, 'update', confirmed);
  if (protectionCheck) return protectionCheck;
```

- [ ] **Step 3: Replace protection checks in opUpdateMetadata**

In `opUpdateMetadata` (around lines 934-943), replace the `existingDelivery === 'protected'` block with:

```typescript
  const protectionCheck = checkProtection(id, existing.metadata as Record<string, unknown>, 'update', confirmed);
  if (protectionCheck) return protectionCheck;
```

- [ ] **Step 4: Replace protection checks in opDeleteNote**

In `opDeleteNote` (around lines 991-998), replace the `meta.delivery === 'protected'` block with:

```typescript
  const protectionCheck = checkProtection(id, meta, 'delete', confirmed);
  if (protectionCheck) return protectionCheck;
```

- [ ] **Step 5: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/notes.ts
git commit -m "feat(v2): replace delivery-based protection with 4-level protection system"
```

---

## Task 8: Update MCP Server

**Files:**
- Modify: `src/mcp-server.ts`
- Modify: `src/lib/notes.ts` (add domain filter to opSearchNotes and opListNotes)

- [ ] **Step 1: Update type description and imports**

In `src/mcp-server.ts`, add import and replace the typeList builder (lines 39-42):

```typescript
import { DOMAIN_TYPES } from './lib/domains.js';

const domainTypeList = Object.entries(DOMAIN_TYPES)
  .map(([domain, types]) => `${domain}: ${(types as readonly string[]).join(', ')}`)
  .join('; ');
```

- [ ] **Step 2: Update add_note tool description**

Replace the `type` parameter description in the `add_note` tool:

```typescript
    type: z.string().describe(`Note type. By domain — ${domainTypeList}. v1 type names (user-preference, persona-rule, etc.) are auto-migrated.`),
    metadata: z.record(z.string(), z.unknown()).default({}).describe('Optional: domain, protection, auto_load, project, upsert_key, description, file_path, file_permissions, skill_ref'),
```

- [ ] **Step 3: Add domain filter to search_notes and list_notes**

Add `domain` parameter to `search_notes`:

```typescript
    domain: z.string().optional().describe('Filter by domain (system, persona, workspace, project)'),
```

Update handler:

```typescript
  async ({ query, threshold, limit, type, project, domain }) => {
    const result = await opSearchNotes(clients, query, threshold, limit, type, project, domain);
    return { content: [{ type: 'text' as const, text: result.message }] };
  }
```

Add same `domain` parameter to `list_notes` and update its handler similarly.

- [ ] **Step 4: Update opSearchNotes in notes.ts**

Update the signature to accept `domain`:

```typescript
export async function opSearchNotes(
  clients: Clients,
  query: string,
  threshold: number,
  limit: number,
  type?: string,
  project?: string,
  domain?: string,
): Promise<OperationResult> {
```

Add domain filtering after the type/project filters (around line 478):

```typescript
  if (domain) results = results.filter(n => (n.metadata.domain ?? n.metadata.delivery) === domain);
```

Apply the same domain filter in the fallback search path (around line 494).

- [ ] **Step 5: Update opListNotes in notes.ts**

Update the signature:

```typescript
export async function opListNotes(
  clients: Clients,
  limit: number,
  type?: string,
  project?: string,
  domain?: string,
): Promise<OperationResult> {
```

Add domain filter to the query builder (around line 556):

```typescript
  if (domain) query = query.eq('metadata->>domain', domain);
```

- [ ] **Step 6: Update tool descriptions for protection**

In `update_note` and `update_metadata`, update descriptions to mention protection levels:

```typescript
  'Update an existing note by ID. Respects protection levels: immutable notes cannot be edited, protected/guarded notes require confirmed: true.',
```

```typescript
  'Update metadata fields on an existing note. Respects protection levels: immutable notes cannot be edited, protected/guarded notes require confirmed: true.',
```

- [ ] **Step 7: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/mcp-server.ts src/lib/notes.ts
git commit -m "feat(v2): update MCP server with domain/protection in tool schemas"
```

---

## Task 9: Update CLI Add Command

**Files:**
- Modify: `src/commands/add.ts`

Replace delivery tier picker with domain-aware type picker grouped by domain.

- [ ] **Step 1: Update the add command**

Replace the contents of `src/commands/add.ts`:

```typescript
import type { LedgerConfig } from '../lib/config.js';
import { loadConfigFile } from '../lib/config.js';
import {
  opAddNote,
  getRegisteredTypes,
  isRegisteredType,
  registerType,
  validateTypeName,
  inferDomain,
  NOTE_STATUSES,
  type NoteStatus,
  type DeliveryTier,
} from '../lib/notes.js';
import { DOMAIN_TYPES, getProtectionDefault, getAutoLoadDefault, type Domain } from '../lib/domains.js';
import { ask, confirm, choose } from '../lib/prompt.js';

export async function add(
  config: LedgerConfig,
  content: string,
  options: { type?: string; agent?: string; project?: string; upsertKey?: string; description?: string; status?: string; force?: boolean; domain?: string },
): Promise<void> {
  const configFile = loadConfigFile();
  const interactive = configFile.naming?.interactive !== false;

  let type = options.type || '';
  const metadata: Record<string, unknown> = {};
  if (options.project) metadata.project = options.project;
  if (options.upsertKey) metadata.upsert_key = options.upsertKey;
  if (options.description) metadata.description = options.description;
  if (options.status) metadata.status = options.status;
  if (options.domain) metadata.domain = options.domain;

  if (interactive && !options.force) {
    // Type — show grouped by domain
    if (!type) {
      const domainChoices = Object.entries(DOMAIN_TYPES).flatMap(([domain, types]) =>
        (types as readonly string[]).map(t => `${t} (${domain})`)
      );
      const typeChoice = await choose('What type of note is this?', [
        ...domainChoices,
        'skip — use default (knowledge)',
      ]);
      if (typeChoice.startsWith('skip')) {
        type = 'knowledge';
      } else {
        type = typeChoice.split(' (')[0];
      }
    }

    // Handle unknown type from --type flag
    if (type && !isRegisteredType(type)) {
      console.error(`\nType "${type}" is not registered.`);
      const action = await choose('What would you like to do?', [
        'register — register it now',
        'existing — use an existing type instead',
        'proceed — save anyway (defaults to project/knowledge)',
      ]);

      if (action.startsWith('register')) {
        const nameError = validateTypeName(type);
        if (nameError) {
          console.error(nameError);
          process.exit(1);
        }
        const deliveryChoice = await choose('Delivery tier?', ['persona', 'project', 'knowledge', 'protected']);
        registerType(type, deliveryChoice as DeliveryTier);
        console.error(`Registered type "${type}" with delivery "${deliveryChoice}".`);
      } else if (action.startsWith('existing')) {
        const registeredTypes = getRegisteredTypes();
        type = await choose('Choose a type:', registeredTypes);
      }
    }

    // Auto-set domain, protection, auto_load from type
    if (!metadata.domain && type) {
      metadata.domain = inferDomain(type);
    }
    if (!metadata.protection && type) {
      metadata.protection = getProtectionDefault(type);
    }
    if (metadata.auto_load === undefined && metadata.domain) {
      metadata.auto_load = getAutoLoadDefault(metadata.domain as Domain, type);
    }

    // Description
    if (!metadata.description) {
      const desc = await ask('One-line description (what is this note for?): ');
      if (desc) metadata.description = desc;
    }

    // upsert_key
    if (!metadata.upsert_key) {
      const key = await ask('Unique key for this note (lowercase-hyphenated, or Enter to auto-generate): ');
      if (key) metadata.upsert_key = key;
    }

    // Project
    if (!metadata.project) {
      const proj = await ask('Project name (or Enter to skip): ');
      if (proj) metadata.project = proj;
    }

    // Status (only for project domain)
    if (metadata.domain === 'project' && !metadata.status) {
      const statusChoice = await choose('What stage is this?', [
        ...NOTE_STATUSES,
        'skip — no status',
      ]);
      if (!statusChoice.startsWith('skip')) {
        metadata.status = statusChoice as NoteStatus;
      }
    }
  }

  if (!type) type = 'knowledge';

  metadata.interactive_skip = true;

  const result = await opAddNote(
    { supabase: config.supabase, openai: config.openai },
    content,
    type,
    options.agent || 'cli',
    metadata,
    options.force ?? false,
  );

  if (result.status === 'confirm') {
    console.error(result.message);
    const proceed = await confirm('\nCreate new note anyway?');
    if (proceed) {
      const forced = await opAddNote(
        { supabase: config.supabase, openai: config.openai },
        content,
        type,
        options.agent || 'cli',
        { ...metadata, interactive_skip: true },
        true,
      );
      console.error(forced.message);
    } else {
      console.error('Cancelled.');
    }
    return;
  }

  console.error(result.message);
  if (result.status === 'error') process.exit(1);
}
```

- [ ] **Step 2: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/commands/add.ts
git commit -m "feat(v2): update CLI add command with domain-aware type picker"
```

---

## Task 10: Auto-set Domain Metadata in opAddNote

**Files:**
- Modify: `src/lib/notes.ts` (in opAddNote, around line 660)

When a note is created via MCP (not CLI), domain/protection/auto_load may not be set. Auto-infer them from the type before saving.

- [ ] **Step 1: Add domain inference to opAddNote**

In `src/lib/notes.ts`, in the `opAddNote` function, after type resolution and before the `fullMetadata` assembly (around line 660), add:

```typescript
  // --- Auto-set v2 metadata from type ---
  if (!metadata.domain) {
    metadata.domain = inferDomain(type);
  }
  if (!metadata.protection) {
    metadata.protection = getProtectionDefault(type);
  }
  if (metadata.auto_load === undefined) {
    metadata.auto_load = getAutoLoadDefault(metadata.domain as Domain, type);
  }
  if (!metadata.owner_type) {
    metadata.owner_type = 'user';
    metadata.owner_id = null;
  }
  if (!metadata.schema_version) {
    metadata.schema_version = 1;
  }
  if (!metadata.embedding_model) {
    metadata.embedding_model = 'openai/text-embedding-3-small';
    metadata.embedding_dimensions = 1536;
  }
```

Ensure `getAutoLoadDefault` is included in the domains.js import at the top of the file (from Task 5).

- [ ] **Step 2: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/notes.ts
git commit -m "feat(v2): auto-infer domain/protection/auto_load in opAddNote"
```

---

## Task 11: Update Sync Command

**Files:**
- Modify: `src/commands/sync.ts`
- Modify: `src/lib/notes.ts` (add `fetchSyncableNotes`)
- Modify: `src/lib/generators.ts` (rewrite `generateMemoryMd`, deprecate `generateClaudeMd`)

- [ ] **Step 1: Add fetchSyncableNotes to notes.ts**

In `src/lib/notes.ts`, after `fetchPersonaNotes` (around line 127), add:

```typescript
/**
 * Fetch notes that should sync to every machine.
 * v2: domain IN (system, persona, workspace).
 * Falls back to delivery='persona' for unmigrated notes.
 */
export async function fetchSyncableNotes(supabase: SupabaseClient): Promise<NoteRow[]> {
  const { data: domainNotes, error: domainError } = await supabase
    .from('notes')
    .select('id, content, metadata, created_at, updated_at')
    .in('metadata->>domain', ['system', 'persona', 'workspace']);

  if (!domainError && domainNotes && domainNotes.length > 0) {
    return domainNotes as NoteRow[];
  }

  return fetchPersonaNotes(supabase);
}
```

- [ ] **Step 2: Rewrite generateMemoryMd and deprecate generateClaudeMd**

Replace the contents of `src/lib/generators.ts`:

```typescript
import type { NoteRow } from './notes.js';

/**
 * Generate MEMORY.md as a search guide (v2).
 * NOT a file index — tells agents what knowledge domains exist and when to search.
 */
export function generateMemoryMd(autoLoadFiles: string[]): string {
  const lines = [
    '# What I Know About You',
    '',
    '## Auto-loaded (always in context)',
    '',
  ];

  if (autoLoadFiles.length > 0) {
    for (const f of autoLoadFiles) {
      lines.push(`- [${f}](${f})`);
    }
  } else {
    lines.push('- Personality, behavioral rules, preferences — loaded from Ledger');
  }

  lines.push('');
  lines.push('## Search Ledger when needed');
  lines.push('');
  lines.push('- **System:** hooks, plugin configs, sync rules — `search_notes` with domain: system');
  lines.push('- **Workspace:** dashboards, device registry, dev environment — `search_notes` with domain: workspace');
  lines.push('- **Projects:** architecture, status, errors, events — `search_notes` with project name or domain: project');
  lines.push('- **Skills:** eval results, test cases — `search_notes` with skill name or type: skill');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate CLAUDE.md. In v2, prefers the claude-md note stored as a complete document.
 * Falls back to legacy generation from feedback notes if no claude-md note exists.
 * @deprecated v2 stores CLAUDE.md as a complete document (type: claude-md). This fallback will be removed.
 */
export function generateClaudeMd(notes: NoteRow[]): string {
  const claudeMdNote = notes.find(n =>
    (n.metadata.type as string) === 'claude-md' ||
    (n.metadata.upsert_key as string) === 'claude-md-backup'
  );

  if (claudeMdNote) {
    return claudeMdNote.content;
  }

  return legacyGenerateClaudeMd(notes);
}

// --- Legacy helpers (pre-v2) ---

const SECTION_MAP: Record<string, string[]> = {
  'Security': ['feedback-no-read-env'],
  'Coding Conventions': ['feedback-coding-conventions'],
  'Architecture': [
    'feedback-mcp-registration',
    'feedback-prefer-cli-and-skills',
    'feedback-repo-docs-structure',
    'feedback-project-logs',
  ],
  'Communication': ['feedback-communication-style'],
};

function extractBulletPoints(content: string): string {
  const lines = content.split('\n');
  const bullets: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('---') || trimmed.startsWith('#') || trimmed === '') continue;
    if (trimmed.startsWith('Why:') || trimmed.startsWith('**Why:**')) continue;
    if (trimmed.startsWith('How to apply:') || trimmed.startsWith('**How to apply:**')) continue;
    if (
      trimmed.startsWith('Follow these') ||
      trimmed.startsWith('Never') ||
      trimmed.startsWith('Always') ||
      trimmed.startsWith('When') ||
      trimmed.startsWith('Before')
    ) {
      bullets.push(`- ${trimmed}`);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bullets.push(trimmed);
    }
  }
  return bullets.join('\n');
}

function legacyGenerateClaudeMd(notes: NoteRow[]): string {
  const notesByKey = new Map<string, NoteRow>();
  for (const note of notes) {
    const key = note.metadata.upsert_key as string;
    if (key) notesByKey.set(key, note);
  }

  const sections: string[] = ['# Global Rules'];
  const usedKeys = new Set<string>();

  for (const [sectionName, keys] of Object.entries(SECTION_MAP)) {
    const sectionBullets: string[] = [];
    for (const key of keys) {
      const note = notesByKey.get(key);
      if (note) {
        sectionBullets.push(extractBulletPoints(note.content));
        usedKeys.add(key);
      }
    }
    if (sectionBullets.length > 0) {
      sections.push(`\n## ${sectionName}\n${sectionBullets.join('\n')}`);
    }
  }

  const unmapped: string[] = [];
  for (const note of notes) {
    const key = note.metadata.upsert_key as string;
    const type = note.metadata.type as string;
    if (key && !usedKeys.has(key) && type === 'feedback') {
      unmapped.push(extractBulletPoints(note.content));
      usedKeys.add(key);
    }
  }

  if (unmapped.length > 0) {
    sections.push(`\n## General\n${unmapped.join('\n')}`);
  }

  return sections.join('\n') + '\n';
}
```

- [ ] **Step 3: Update sync.ts for domain-based sync**

In `src/commands/sync.ts`:

1. Update import to use `fetchSyncableNotes`:

```typescript
import { fetchSyncableNotes, updateNoteContent, updateNoteHash, opAddNote, type NoteRow, type Clients, type DeliveryTier } from '../lib/notes.js';
```

2. Replace `fetchPersonaNotes` call (line 25):

```typescript
  const notes = await fetchSyncableNotes(config.supabase);
```

3. Update the file mapping loop (lines 46-49) to support both `file_path` and `local_file`:

```typescript
  const notesByFile = new Map<string, NoteRow>();
  for (const note of notes) {
    const localFile = note.metadata.local_file as string | undefined;
    const filePath = note.metadata.file_path as string | undefined;
    const fileKey = localFile ?? (filePath ? filePath.split('/').pop() : undefined);
    if (fileKey) notesByFile.set(fileKey, note);
  }
```

4. In Phase 3, update MEMORY.md and CLAUDE.md generation:

Replace the Phase 3 section (around lines 199-218) with:

```typescript
  // --- Phase 3: Regenerate MEMORY.md and CLAUDE.md ---
  if (!dryRun) {
    const autoLoadFiles = notes
      .filter(n => n.metadata.auto_load === true && n.metadata.local_file)
      .map(n => n.metadata.local_file as string);
    // Include all synced files for backward compat
    const allLocalFiles = [...new Set([...autoLoadFiles, ...result.downloaded, ...result.uploaded, ...result.skipped])];

    const memoryPath = resolve(config.memoryDir, 'MEMORY.md');
    writeFileSync(memoryPath, generateMemoryMd(allLocalFiles), 'utf-8');

    // CLAUDE.md: prefer claude-md note, fall back to legacy generation
    const claudeMdNote = notes.find(n =>
      (n.metadata.type as string) === 'claude-md' ||
      (n.metadata.upsert_key as string) === 'claude-md-backup'
    );

    if (claudeMdNote) {
      writeFileSync(config.claudeMdPath, claudeMdNote.content, 'utf-8');
      if (!quiet) console.error('  wrote ~/CLAUDE.md (from claude-md note)');
    } else {
      // Legacy fallback
      const feedbackNotes = notes.filter(n => (n.metadata.type as string) === 'feedback');
      const newClaudeMd = generateClaudeMd(feedbackNotes);
      if (existsSync(config.claudeMdPath)) {
        const existing = readFileSync(config.claudeMdPath, 'utf-8');
        if (existing.startsWith('# Global Rules') || force) {
          writeFileSync(config.claudeMdPath, newClaudeMd, 'utf-8');
          if (!quiet) console.error('  wrote ~/CLAUDE.md');
        }
      } else {
        writeFileSync(config.claudeMdPath, newClaudeMd, 'utf-8');
        if (!quiet) console.error('  wrote ~/CLAUDE.md');
      }
    }
  }
```

- [ ] **Step 4: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notes.ts src/lib/generators.ts src/commands/sync.ts
git commit -m "feat(v2): domain-based sync, MEMORY.md as search guide, direct CLAUDE.md from note"
```

---

## Task 12: File Writer Module

**Files:**
- Create: `src/lib/file-writer.ts`
- Create: `tests/file-writer.test.ts`

Writes notes with `file_path` to disk during install/sync.

- [ ] **Step 1: Write the failing tests**

Create `tests/file-writer.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeNoteFile } from '../src/lib/file-writer.js';
import { existsSync, readFileSync, mkdirSync, rmSync, statSync } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = resolve(tmpdir(), 'ledger-file-writer-test');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeNoteFile', () => {
  it('writes content to the specified path', () => {
    const filePath = resolve(TEST_DIR, 'test-note.md');
    const result = writeNoteFile('Hello world', filePath, '644');
    expect(result.status).toBe('written');
    expect(readFileSync(filePath, 'utf-8')).toBe('Hello world');
  });

  it('creates parent directories if they do not exist', () => {
    const filePath = resolve(TEST_DIR, 'deep/nested/dir/note.md');
    const result = writeNoteFile('Nested content', filePath, '644');
    expect(result.status).toBe('written');
    expect(existsSync(filePath)).toBe(true);
  });

  it('sets file permissions', () => {
    const filePath = resolve(TEST_DIR, 'hook.sh');
    writeNoteFile('#!/bin/bash', filePath, '755');
    const stats = statSync(filePath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('755');
  });

  it('defaults to 644 if no permissions specified', () => {
    const filePath = resolve(TEST_DIR, 'default.md');
    writeNoteFile('content', filePath, null);
    const stats = statSync(filePath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe('644');
  });

  it('returns skip status if content matches existing file', () => {
    const filePath = resolve(TEST_DIR, 'existing.md');
    writeNoteFile('same content', filePath, '644');
    const result = writeNoteFile('same content', filePath, '644');
    expect(result.status).toBe('skipped');
  });

  it('overwrites if content differs', () => {
    const filePath = resolve(TEST_DIR, 'changing.md');
    writeNoteFile('old content', filePath, '644');
    const result = writeNoteFile('new content', filePath, '644');
    expect(result.status).toBe('written');
    expect(readFileSync(filePath, 'utf-8')).toBe('new content');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/adrian/repos/ledger && npm test -- tests/file-writer.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the file writer**

Create `src/lib/file-writer.ts`:

```typescript
import { writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'fs';
import { dirname } from 'path';

export interface FileWriteResult {
  status: 'written' | 'skipped' | 'error';
  path: string;
  message?: string;
}

/**
 * Write a note's content to disk at the specified file_path.
 * Creates parent directories if needed. Sets Unix permissions.
 * Skips write if content matches existing file (idempotent).
 */
export function writeNoteFile(
  content: string,
  filePath: string,
  permissions: string | null,
): FileWriteResult {
  const dir = dirname(filePath);
  const mode = permissions ? parseInt(permissions, 8) : 0o644;

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing === content) {
      return { status: 'skipped', path: filePath };
    }
  }

  writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);

  return { status: 'written', path: filePath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/adrian/repos/ledger && npm test -- tests/file-writer.test.ts`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/file-writer.ts tests/file-writer.test.ts
git commit -m "feat(v2): add file writer module for writing notes to disk with permissions"
```

---

## Task 13: Wire File Writer into Sync

**Files:**
- Modify: `src/commands/sync.ts`

After the standard sync loop, write notes with absolute `file_path` (hooks, skills, configs) to disk.

- [ ] **Step 1: Add file writer integration to sync**

In `src/commands/sync.ts`, add import:

```typescript
import { writeNoteFile } from '../lib/file-writer.js';
```

After the Phase 2 orphan cleanup section, add:

```typescript
  // --- Phase 2.5: Write file_path notes to disk (hooks, skills, configs) ---
  const filePathNotes = notes.filter(n => {
    const fp = n.metadata.file_path as string | undefined;
    return fp && fp.startsWith('/') && !fp.includes('/memory/');
  });

  for (const note of filePathNotes) {
    const fp = note.metadata.file_path as string;
    const perms = note.metadata.file_permissions as string | null ?? null;

    if (dryRun) {
      if (!quiet) console.error(`  ${fp} — would write (file_path note)`);
      continue;
    }

    const writeResult = writeNoteFile(note.content, fp, perms);
    if (writeResult.status === 'written') {
      if (!quiet) console.error(`  ${fp} — written`);
    }
  }
```

- [ ] **Step 2: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/commands/sync.ts
git commit -m "feat(v2): wire file writer into sync for file_path notes"
```

---

## Task 14: Full Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `cd /home/adrian/repos/ledger && npm test`

Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `cd /home/adrian/repos/ledger && npm run typecheck`

Expected: No type errors.

- [ ] **Step 3: Run build**

Run: `cd /home/adrian/repos/ledger && npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Verify MCP server starts**

Run: `cd /home/adrian/repos/ledger && echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | npx tsx src/mcp-server.ts 2>/dev/null | head -1`

Expected: JSON response with server capabilities.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(v2): address typecheck and build issues from phase 1 implementation"
```

---

## Post-Implementation: Run Backfill on Production

After all code is merged and tests pass:

1. **Backup first:** `ledger backup`
2. **Dry run:** `ledger backfill --dry-run` — review the output
3. **Run backfill:** `ledger backfill` — migrate all ~250 notes
4. **Apply migration 004:** Run the SQL in Supabase Dashboard (upsert_key unique index)
5. **Apply migration 005:** Run the audit_log SQL in Supabase Dashboard
6. **Verify:** `ledger list --limit 5` — check notes have domain, protection fields
7. **Sync:** `ledger sync` — verify domain-based sync works

---

## Summary

| Task | What | New Files | Modified Files |
|------|------|-----------|----------------|
| 1 | Audit log migration SQL | — | `005-audit-log.sql` |
| 2 | Domain model module | `domains.ts`, `domains.test.ts` | — |
| 3 | Backfill module | `backfill.ts`, `backfill.test.ts` | — |
| 4 | Backfill CLI command | `commands/backfill.ts` | `cli.ts` |
| 5 | Update NoteMetadata & type registry | — | `notes.ts`, `type-registry.test.ts` |
| 6 | Audit log module + wire into ops | `audit.ts` | `notes.ts` |
| 7 | Protection flow | — | `notes.ts` |
| 8 | Update MCP server | — | `mcp-server.ts`, `notes.ts` |
| 9 | Update CLI add command | — | `commands/add.ts` |
| 10 | Auto-set domain in opAddNote | — | `notes.ts` |
| 11 | Sync refactor + generators | — | `sync.ts`, `notes.ts`, `generators.ts` |
| 12 | File writer module | `file-writer.ts`, `file-writer.test.ts` | — |
| 13 | Wire file writer into sync | — | `sync.ts` |
| 14 | Full verification | — | — |
