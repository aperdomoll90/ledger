// --- Domain Model ---
// Pure functions for domain, protection, type validation, and v1→v2 migration.
// No Supabase dependency — fully unit testable.

export type Domain = 'system' | 'persona' | 'workspace' | 'project' | 'general';
export type Protection = 'open' | 'guarded' | 'protected' | 'immutable';

// Shared types — used across multiple domains
export type ExtensionType = 'skill' | 'hook' | 'plugin-config';
export type ResourceType = 'reference' | 'knowledge' | 'eval-result';
export type DocType = 'claude-md' | 'memory-md';

// Domain-specific types — unique to one domain
export type PersonaType = 'personality' | 'behavioral-rule' | 'preference' | DocType | ExtensionType;
export type SystemType = 'type-registry' | 'sync-rule' | ExtensionType;
export type WorkspaceType = 'dashboard' | 'device-registry' | 'environment' | ResourceType;
export type ProjectType = 'architecture' | 'project-status' | 'event' | 'error' | DocType | ExtensionType | ResourceType;
export type GeneralType = 'general' | ResourceType;

export type NoteType = PersonaType | SystemType | WorkspaceType | ProjectType | GeneralType;

// --- Domain → Types mapping ---

export const DOMAIN_TYPES: Record<Domain, readonly string[]> = {
  persona:   ['personality', 'behavioral-rule', 'preference', 'claude-md', 'memory-md', 'skill', 'hook', 'plugin-config'],
  system:    ['hook', 'plugin-config', 'type-registry', 'sync-rule', 'skill'],
  workspace: ['dashboard', 'device-registry', 'environment', 'eval-result', 'reference', 'knowledge'],
  project:   ['architecture', 'project-status', 'event', 'error', 'claude-md', 'memory-md', 'reference', 'knowledge', 'skill', 'eval-result'],
  general:   ['reference', 'knowledge', 'general'],
} as const;

// --- Protection defaults per type ---

export const TYPE_DEFAULTS: Record<string, { protection: Protection; autoLoad: boolean }> = {
  // Persona
  'personality':      { protection: 'protected', autoLoad: true },
  'behavioral-rule':  { protection: 'protected', autoLoad: true },
  'preference':       { protection: 'guarded',   autoLoad: true },
  'claude-md':        { protection: 'protected', autoLoad: true },
  'memory-md':        { protection: 'protected', autoLoad: true },
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
  'knowledge-guide':       { domain: 'general',  type: 'knowledge' },
};

// --- Inference functions ---

/**
 * Given a v2 type name, return which domain it belongs to.
 * For ambiguous types (skill, reference, knowledge): returns first match based on DOMAIN_TYPES order.
 * Note: reference/knowledge appear in both project and general — project wins because it's listed first.
 * When creating a note without a project, callers should explicitly set domain: 'general'.
 */
export function inferDomain(type: string): Domain {
  // Types that exist in multiple domains — explicit defaults
  // Types that exist in multiple domains — explicit defaults
  if (type === 'hook') return 'system';          // most hooks are infrastructure; persona/workspace for personal ones
  if (type === 'plugin-config') return 'system'; // most plugins are system; persona/workspace for personal ones
  if (type === 'skill') return 'persona';        // most skills are personal; system/workspace/project to override
  if (type === 'claude-md') return 'persona';    // global CLAUDE.md; project for scoped ones
  if (type === 'memory-md') return 'persona';    // global MEMORY.md; project for scoped ones
  if (type === 'reference') return 'general';    // unscoped references; project if project-tagged
  if (type === 'knowledge') return 'general';    // unscoped knowledge; project if project-tagged

  for (const [domain, types] of Object.entries(DOMAIN_TYPES)) {
    if (types.includes(type)) return domain as Domain;
  }
  return 'general'; // default for unknown types
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
