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
