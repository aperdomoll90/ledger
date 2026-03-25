import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigFile } from './config.js';

/**
 * Tests for opAddNote's type registry integration:
 * - Unknown type → confirm prompt
 * - Unknown type + register_type → registers then saves
 * - Unknown type + register_type + invalid name → error
 * - Alias resolution in add flow
 *
 * These tests mock config (filesystem) and force interactive OFF
 * so we only hit the type-checking code path before any DB calls.
 */

const mockConfigState: { current: ConfigFile } = { current: {} };

vi.mock('./config.js', () => ({
  loadConfigFile: () => mockConfigState.current,
  saveConfigFile: (config: ConfigFile) => { mockConfigState.current = config; },
}));

// Mock hash module (used in opAddNote for content_hash)
vi.mock('./hash.js', () => ({
  contentHash: (s: string) => `hash-${s.length}`,
}));

const { opAddNote, BUILTIN_TYPES } = await import('./notes.js');

// --- Mock Clients ---

function createMockClients() {
  const insertResult = { data: { id: 999, created_at: '2026-01-01' }, error: null };
  const selectChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  const insertChain = {
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue(insertResult),
    }),
  };

  const supabase = {
    from: vi.fn().mockReturnValue({
      ...selectChain,
      insert: vi.fn().mockReturnValue(insertChain),
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  };

  const openai = {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0) }],
      }),
    },
  };

  return { supabase, openai } as unknown as Parameters<typeof opAddNote>[0];
}

// --- Helpers ---

function resetConfig(): void {
  mockConfigState.current = { naming: { interactive: false } };
}

beforeEach(() => {
  resetConfig();
});

// ============================================================
// Unknown type → confirm prompt
// ============================================================

describe('opAddNote — unknown type handling', () => {
  it('returns confirm when type is unknown and register_type is false', async () => {
    const clients = createMockClients();
    const result = await opAddNote(
      clients,
      'Some content',
      'wine-log',
      'claude-code',
      { upsert_key: 'test', description: 'test' },
      false, // force
      false, // register_type
    );

    expect(result.status).toBe('confirm');
    expect(result.message).toContain('wine-log');
    expect(result.message).toContain('not registered');
    expect(result.message).toContain('Options');
  });

  it('confirm message lists all registered types', async () => {
    const clients = createMockClients();
    const result = await opAddNote(
      clients,
      'Content',
      'unknown-type',
      'agent',
      { upsert_key: 'test', description: 'test' },
      false,
      false,
    );

    expect(result.status).toBe('confirm');
    // Should list built-in types
    expect(result.message).toContain('code-craft');
    expect(result.message).toContain('architecture-decision');
    expect(result.message).toContain('reference');
  });
});

// ============================================================
// Unknown type + register_type → registers then proceeds
// ============================================================

describe('opAddNote — type registration', () => {
  it('registers type and saves note when register_type is true', async () => {
    const clients = createMockClients();
    const result = await opAddNote(
      clients,
      'Tasting notes for 2024 Malbec',
      'wine-log',
      'claude-code',
      { upsert_key: 'wine-2024-malbec', description: 'Tasting notes', delivery: 'project' },
      false,
      true, // register_type
    );

    // Should succeed (type got registered mid-call)
    expect(result.status).toBe('ok');
    // Type should now be in config
    expect(mockConfigState.current.types?.['wine-log']).toBe('project');
  });

  it('defaults delivery to knowledge when not specified', async () => {
    const clients = createMockClients();
    await opAddNote(
      clients,
      'My recipe content',
      'recipe',
      'claude-code',
      { upsert_key: 'recipe-pasta', description: 'Pasta recipe' },
      false,
      true,
    );

    expect(mockConfigState.current.types?.['recipe']).toBe('knowledge');
  });

  it('registered type persists for subsequent calls', async () => {
    const clients = createMockClients();

    // First call: register
    await opAddNote(
      clients,
      'First wine note',
      'wine-log',
      'claude-code',
      { upsert_key: 'wine-1', description: 'First', delivery: 'project' },
      false,
      true,
    );

    // Second call: should NOT need register_type anymore
    const result = await opAddNote(
      clients,
      'Second wine note',
      'wine-log',
      'claude-code',
      { upsert_key: 'wine-2', description: 'Second' },
      false,
      false, // no registration flag
    );

    expect(result.status).toBe('ok');
  });
});

// ============================================================
// Invalid type name with register_type
// ============================================================

describe('opAddNote — invalid type name rejection', () => {
  it('returns error for uppercase type name', async () => {
    const clients = createMockClients();
    const result = await opAddNote(
      clients,
      'Content',
      'Wine-Log',
      'agent',
      { upsert_key: 'test', description: 'test' },
      false,
      true,
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('Invalid type name');
  });

  it('returns error for single-character type name', async () => {
    const clients = createMockClients();
    const result = await opAddNote(
      clients,
      'Content',
      'x',
      'agent',
      { upsert_key: 'test', description: 'test' },
      false,
      true,
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('at least 2');
  });

  it('returns error for type name with underscores', async () => {
    const clients = createMockClients();
    const result = await opAddNote(
      clients,
      'Content',
      'wine_log',
      'agent',
      { upsert_key: 'test', description: 'test' },
      false,
      true,
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('Invalid type name');
  });
});

// ============================================================
// Alias resolution in opAddNote
// ============================================================

describe('opAddNote — alias resolution', () => {
  it('feedback alias resolves to general and saves successfully', async () => {
    const clients = createMockClients();
    const result = await opAddNote(
      clients,
      'Some feedback content',
      'feedback',
      'claude-code',
      { upsert_key: 'test-feedback', description: 'Test feedback' },
      false,
      false,
    );

    // 'feedback' aliases to 'general' which is a built-in — should work
    expect(result.status).toBe('ok');
  });
});

// ============================================================
// Built-in types work without registration
// ============================================================

describe('opAddNote — built-in types', () => {
  it('accepts all built-in types without register_type flag', async () => {
    const clients = createMockClients();

    for (const builtinType of Object.keys(BUILTIN_TYPES)) {
      const result = await opAddNote(
        clients,
        `Content for ${builtinType}`,
        builtinType,
        'claude-code',
        {
          upsert_key: `test-${builtinType}`,
          description: `Test ${builtinType}`,
          ...(builtinType === 'architecture-decision' || builtinType === 'project-status' || builtinType === 'event' || builtinType === 'error'
            ? { status: 'active' }
            : {}),
        },
        false,
        false,
      );

      expect(result.status, `Built-in type "${builtinType}" should be accepted`).toBe('ok');
    }
  });
});
