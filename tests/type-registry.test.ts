import { describe, it, expect } from 'vitest';
import { BUILTIN_TYPES, getTypeRegistry, inferDelivery, getRegisteredTypes, isRegisteredType, validateTypeName } from '../src/lib/notes.js';
import type { DeliveryTier } from '../src/lib/notes.js';

describe('BUILTIN_TYPES', () => {
  it('contains all 11 built-in types', () => {
    expect(Object.keys(BUILTIN_TYPES)).toHaveLength(11);
  });

  it('maps persona types correctly', () => {
    expect(BUILTIN_TYPES['user-preference']).toBe('persona');
    expect(BUILTIN_TYPES['persona-rule']).toBe('persona');
    expect(BUILTIN_TYPES['system-rule']).toBe('persona');
    expect(BUILTIN_TYPES['code-craft']).toBe('persona');
  });

  it('maps project types correctly', () => {
    expect(BUILTIN_TYPES['architecture-decision']).toBe('project');
    expect(BUILTIN_TYPES['project-status']).toBe('project');
    expect(BUILTIN_TYPES['event']).toBe('project');
    expect(BUILTIN_TYPES['error']).toBe('project');
  });

  it('maps knowledge types correctly', () => {
    expect(BUILTIN_TYPES['reference']).toBe('knowledge');
    expect(BUILTIN_TYPES['knowledge-guide']).toBe('knowledge');
    expect(BUILTIN_TYPES['general']).toBe('knowledge');
  });

  it('does not contain deprecated feedback type', () => {
    expect(BUILTIN_TYPES['feedback']).toBeUndefined();
  });
});

describe('getTypeRegistry', () => {
  it('returns built-ins when no config types exist', () => {
    const registry = getTypeRegistry();
    expect(registry['user-preference']).toBe('persona');
    expect(registry['general']).toBe('knowledge');
  });
});

describe('inferDelivery', () => {
  it('returns correct tier for built-in types', () => {
    expect(inferDelivery('user-preference')).toBe('persona');
    expect(inferDelivery('architecture-decision')).toBe('project');
    expect(inferDelivery('reference')).toBe('knowledge');
  });

  it('defaults unknown types to knowledge', () => {
    expect(inferDelivery('nonexistent-type')).toBe('knowledge');
  });

  it('resolves feedback alias to general → knowledge', () => {
    expect(inferDelivery('feedback')).toBe('knowledge');
  });
});

describe('getRegisteredTypes', () => {
  it('returns all built-in type names', () => {
    const types = getRegisteredTypes();
    expect(types).toContain('user-preference');
    expect(types).toContain('code-craft');
    expect(types).toContain('general');
    expect(types.length).toBeGreaterThanOrEqual(11);
  });
});

describe('isRegisteredType', () => {
  it('returns true for built-in types', () => {
    expect(isRegisteredType('user-preference')).toBe(true);
    expect(isRegisteredType('code-craft')).toBe(true);
  });

  it('returns false for unknown types', () => {
    expect(isRegisteredType('nonexistent-type')).toBe(false);
  });

  it('returns true for aliased types', () => {
    expect(isRegisteredType('feedback')).toBe(true);
  });
});

describe('unknown type flow (unit)', () => {
  it('isRegisteredType returns false for unregistered custom types', () => {
    expect(isRegisteredType('wine-log')).toBe(false);
  });

  it('validateTypeName accepts the type name that would be registered', () => {
    expect(validateTypeName('wine-log')).toBeNull();
  });

  it('validateTypeName rejects invalid names before registration', () => {
    expect(validateTypeName('Wine_Log')).not.toBeNull();
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

  it('adds remote-only types', () => {
    const local: Record<string, DeliveryTier> = {};
    const remote: Record<string, DeliveryTier> = { 'recipe': 'knowledge' };
    const merged = { ...remote, ...local };
    expect(merged['recipe']).toBe('knowledge');
  });
});
