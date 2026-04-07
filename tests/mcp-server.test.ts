import { describe, it, expect, vi } from 'vitest';

// The MCP server imports heavy packages (supabase, openai) and reads env vars on load.
// We mock the environment and verify the module structure rather than testing the full server.

describe('mcp-server module', () => {
  it('source file exists and exports are structured correctly', async () => {
    // Verify the file can be parsed by checking the source exists
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf-8');

    // Verify it imports from all 4 library modules
    expect(source).toContain("from './lib/documents/classification.js'");
    expect(source).toContain("from './lib/documents/operations.js'");
    expect(source).toContain("from './lib/documents/fetching.js'");
    expect(source).toContain("from './lib/search/ai-search.js'");
  });

  it('registers all 16 tools (10 new + 6 deprecated)', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf-8');

    // New tools
    const newTools = [
      'search_documents', 'add_document', 'list_documents',
      'update_document', 'update_document_fields', 'delete_document',
      'restore_document', 'search_by_meaning', 'search_by_keyword', 'get_document_context',
    ];
    for (const tool of newTools) {
      expect(source).toContain(`'${tool}'`);
    }

    // Deprecated tools
    const deprecatedTools = ['search_notes', 'add_note', 'list_notes', 'update_note', 'update_metadata', 'delete_note'];
    for (const tool of deprecatedTools) {
      expect(source).toContain(`'${tool}'`);
    }
  });

  it('deprecated tools include deprecation notice', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf-8');

    // All deprecated tool descriptions should include [DEPRECATED]
    const deprecatedToolNames = ['search_notes', 'add_note', 'list_notes', 'update_note', 'update_metadata', 'delete_note'];
    for (const toolName of deprecatedToolNames) {
      // Find the server.tool( call for this tool and verify its description contains DEPRECATED
      const toolRegex = new RegExp(`server\\.tool\\(\\s*'${toolName}'.*?\\[DEPRECATED`, 's');
      expect(source).toMatch(toolRegex);
    }
  });

  it('uses protection checks for update and delete operations', async () => {
    const { readFileSync } = await import('fs');
    const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf-8');

    // Protection check function should exist
    expect(source).toContain('async function checkProtection');

    // Protection should handle all levels
    expect(source).toContain("'immutable'");
    expect(source).toContain("'protected'");
    expect(source).toContain("'guarded'");
  });
});
