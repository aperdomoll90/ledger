import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigFile } from './config.js';

// Mock config module — isolates tests from filesystem
const mockConfigState: { current: ConfigFile } = { current: {} };

vi.mock('./config.js', () => ({
  loadConfigFile: () => mockConfigState.current,
  saveConfigFile: (config: ConfigFile) => { mockConfigState.current = config; },
}));

// Import AFTER mock setup so modules pick up the mocked config
const {
  BUILTIN_TYPES,
  getTypeRegistry,
  inferDelivery,
  getRegisteredTypes,
  isRegisteredType,
  registerType,
  validateTypeName,
  checkMetadataCompleteness,
} = await import('./notes.js');

// --- Helpers ---

function setUserTypes(types: Record<string, 'persona' | 'project' | 'knowledge' | 'protected'>): void {
  mockConfigState.current = { types };
}

function resetConfig(): void {
  mockConfigState.current = {};
}

// --- Tests ---

beforeEach(() => {
  resetConfig();
});

// ============================================================
// 1. getTypeRegistry
// ============================================================

describe('getTypeRegistry', () => {
  it('returns built-ins when no user config', () => {
    const registry = getTypeRegistry();
    expect(registry).toEqual(BUILTIN_TYPES);
  });

  it('merges user overrides with built-ins', () => {
    setUserTypes({ 'wine-log': 'project' });
    const registry = getTypeRegistry();
    expect(registry['wine-log']).toBe('project');
    expect(registry['code-craft']).toBe('persona'); // built-in still present
  });

  it('user overrides win over built-in defaults', () => {
    setUserTypes({ 'code-craft': 'knowledge' });
    const registry = getTypeRegistry();
    expect(registry['code-craft']).toBe('knowledge');
  });
});

// ============================================================
// 2. inferDelivery
// ============================================================

describe('inferDelivery', () => {
  it('returns correct tier for built-in types', () => {
    expect(inferDelivery('persona-rule')).toBe('persona');
    expect(inferDelivery('architecture-decision')).toBe('project');
    expect(inferDelivery('reference')).toBe('knowledge');
  });

  it('respects user overrides', () => {
    setUserTypes({ 'code-craft': 'project' });
    expect(inferDelivery('code-craft')).toBe('project');
  });

  it('defaults unknown types to knowledge', () => {
    expect(inferDelivery('nonexistent-type')).toBe('knowledge');
  });

  it('resolves aliases — feedback maps to general (knowledge)', () => {
    expect(inferDelivery('feedback')).toBe('knowledge');
  });

  it('resolves aliases before checking overrides', () => {
    // Override 'general' (which 'feedback' aliases to)
    setUserTypes({ 'general': 'project' });
    expect(inferDelivery('feedback')).toBe('project');
  });
});

// ============================================================
// 3. isRegisteredType
// ============================================================

describe('isRegisteredType', () => {
  it('returns true for built-in types', () => {
    expect(isRegisteredType('code-craft')).toBe(true);
    expect(isRegisteredType('event')).toBe(true);
  });

  it('returns true for custom types', () => {
    setUserTypes({ 'wine-log': 'project' });
    expect(isRegisteredType('wine-log')).toBe(true);
  });

  it('returns false for unknown types', () => {
    expect(isRegisteredType('nonexistent')).toBe(false);
  });

  it('returns true for aliased types (feedback → general)', () => {
    expect(isRegisteredType('feedback')).toBe(true);
  });
});

// ============================================================
// 4. getRegisteredTypes
// ============================================================

describe('getRegisteredTypes', () => {
  it('returns all built-in type names when no custom types', () => {
    const types = getRegisteredTypes();
    expect(types).toContain('code-craft');
    expect(types).toContain('architecture-decision');
    expect(types).toContain('reference');
    expect(types.length).toBe(Object.keys(BUILTIN_TYPES).length);
  });

  it('includes custom types in the list', () => {
    setUserTypes({ 'wine-log': 'project', 'recipe': 'knowledge' });
    const types = getRegisteredTypes();
    expect(types).toContain('wine-log');
    expect(types).toContain('recipe');
    expect(types.length).toBe(Object.keys(BUILTIN_TYPES).length + 2);
  });

  it('does not duplicate when overriding a built-in', () => {
    setUserTypes({ 'code-craft': 'knowledge' });
    const types = getRegisteredTypes();
    const codeCraftCount = types.filter(t => t === 'code-craft').length;
    expect(codeCraftCount).toBe(1);
    expect(types.length).toBe(Object.keys(BUILTIN_TYPES).length);
  });
});

// ============================================================
// 5. registerType
// ============================================================

describe('registerType', () => {
  it('writes a new custom type to config', () => {
    registerType('wine-log', 'project');
    expect(mockConfigState.current.types?.['wine-log']).toBe('project');
  });

  it('does not clobber existing config keys', () => {
    mockConfigState.current = {
      device: { alias: 'test-machine' },
      types: { 'existing': 'knowledge' },
    };
    registerType('wine-log', 'project');
    expect(mockConfigState.current.device?.alias).toBe('test-machine');
    expect(mockConfigState.current.types?.['existing']).toBe('knowledge');
    expect(mockConfigState.current.types?.['wine-log']).toBe('project');
  });

  it('initializes types object if missing', () => {
    mockConfigState.current = {};
    registerType('recipe', 'knowledge');
    expect(mockConfigState.current.types).toBeDefined();
    expect(mockConfigState.current.types?.['recipe']).toBe('knowledge');
  });

  it('registered type becomes discoverable immediately', () => {
    expect(isRegisteredType('wine-log')).toBe(false);
    registerType('wine-log', 'project');
    expect(isRegisteredType('wine-log')).toBe(true);
    expect(inferDelivery('wine-log')).toBe('project');
  });
});

// ============================================================
// 6. validateTypeName
// ============================================================

describe('validateTypeName', () => {
  it('accepts valid names', () => {
    expect(validateTypeName('wine-log')).toBeNull();
    expect(validateTypeName('ab')).toBeNull();
    expect(validateTypeName('my-custom-type-123')).toBeNull();
    expect(validateTypeName('a1')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateTypeName('')).toContain('at least 2');
  });

  it('rejects single character', () => {
    expect(validateTypeName('a')).toContain('at least 2');
  });

  it('rejects names over 50 characters', () => {
    const longName = 'a' + '-long'.repeat(10) + '-name';
    expect(validateTypeName(longName.length > 50 ? longName : 'a'.repeat(51))).toContain('50 characters');
  });

  it('rejects uppercase letters', () => {
    expect(validateTypeName('Wine-Log')).toContain('lowercase');
  });

  it('rejects names starting with a number', () => {
    expect(validateTypeName('1-bad')).toContain('lowercase');
  });

  it('rejects special characters', () => {
    expect(validateTypeName('wine_log')).toContain('lowercase');
    expect(validateTypeName('wine.log')).toContain('lowercase');
    expect(validateTypeName('wine log')).toContain('lowercase');
  });

  it('rejects consecutive hyphens', () => {
    expect(validateTypeName('wine--log')).toContain('lowercase');
  });

  it('rejects trailing hyphen', () => {
    expect(validateTypeName('wine-')).toContain('lowercase');
  });
});

// ============================================================
// 7. checkMetadataCompleteness (dynamic delivery check)
// ============================================================

describe('checkMetadataCompleteness', () => {
  it('returns null when all fields are present for project type', () => {
    const result = checkMetadataCompleteness(
      { description: 'test', upsert_key: 'test-key', status: 'active' },
      'architecture-decision',
    );
    expect(result).toBeNull();
  });

  it('returns null when all fields are present for persona type (no status needed)', () => {
    const result = checkMetadataCompleteness(
      { description: 'test', upsert_key: 'test-key' },
      'code-craft',
    );
    expect(result).toBeNull();
  });

  it('prompts for status on project-delivery types', () => {
    const result = checkMetadataCompleteness(
      { description: 'test', upsert_key: 'test-key' },
      'architecture-decision',
    );
    expect(result).toContain('status');
  });

  it('does NOT prompt for status on persona-delivery types', () => {
    const result = checkMetadataCompleteness(
      { description: 'test', upsert_key: 'test-key' },
      'persona-rule',
    );
    expect(result).toBeNull();
  });

  it('uses inferDelivery for custom types — project custom type requires status', () => {
    setUserTypes({ 'wine-log': 'project' });
    const result = checkMetadataCompleteness(
      { description: 'test', upsert_key: 'test-key' },
      'wine-log',
    );
    expect(result).toContain('status');
  });

  it('uses inferDelivery for custom types — knowledge custom type skips status', () => {
    setUserTypes({ 'recipe': 'knowledge' });
    const result = checkMetadataCompleteness(
      { description: 'test', upsert_key: 'test-key' },
      'recipe',
    );
    expect(result).toBeNull();
  });

  it('prompts for missing description and upsert_key', () => {
    const result = checkMetadataCompleteness({}, 'general');
    expect(result).toContain('description');
    expect(result).toContain('upsert_key');
  });
});

// ============================================================
// 8. Type alias resolution (feedback → general)
// ============================================================

describe('type alias resolution', () => {
  it('feedback resolves to general in inferDelivery', () => {
    expect(inferDelivery('feedback')).toBe(inferDelivery('general'));
  });

  it('feedback is recognized as registered', () => {
    expect(isRegisteredType('feedback')).toBe(true);
  });

  it('unknown aliases pass through unchanged', () => {
    expect(isRegisteredType('totally-unknown')).toBe(false);
    expect(inferDelivery('totally-unknown')).toBe('knowledge');
  });
});

// ============================================================
// 9. Edge cases
// ============================================================

describe('edge cases', () => {
  it('empty config file (no types key) falls back to built-ins', () => {
    mockConfigState.current = {};
    const registry = getTypeRegistry();
    expect(registry).toEqual(BUILTIN_TYPES);
  });

  it('config with empty types object works', () => {
    mockConfigState.current = { types: {} };
    const registry = getTypeRegistry();
    expect(registry).toEqual(BUILTIN_TYPES);
  });

  it('overriding a built-in then unsetting reverts to default', () => {
    setUserTypes({ 'code-craft': 'knowledge' });
    expect(inferDelivery('code-craft')).toBe('knowledge');

    // Simulate unsetting — remove from user types
    mockConfigState.current = {};
    expect(inferDelivery('code-craft')).toBe('persona'); // reverts to built-in
  });

  it('registering mid-session is immediately visible', () => {
    expect(getRegisteredTypes()).not.toContain('wine-log');
    registerType('wine-log', 'project');
    expect(getRegisteredTypes()).toContain('wine-log');
    expect(inferDelivery('wine-log')).toBe('project');
  });
});
