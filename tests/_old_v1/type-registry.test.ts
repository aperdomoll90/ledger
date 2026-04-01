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
