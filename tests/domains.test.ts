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
