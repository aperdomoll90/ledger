import { describe, it, expect } from 'vitest';
import { getClaudeMdContent, getMemoryMdContent } from '../src/lib/notes.js';
import type { NoteRow } from '../src/lib/notes.js';

function makeNote(overrides: Partial<NoteRow> & { metadata: Record<string, unknown> }): NoteRow {
  return {
    id: 1,
    content: '',
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('getClaudeMdContent', () => {
  it('returns content from a claude-md type note', () => {
    const notes = [
      makeNote({
        content: '# My CLAUDE.md\nRules here.',
        metadata: { type: 'claude-md', domain: 'persona' },
      }),
    ];
    expect(getClaudeMdContent(notes)).toBe('# My CLAUDE.md\nRules here.');
  });

  it('returns content from a claude-md-backup upsert_key note', () => {
    const notes = [
      makeNote({
        content: '# Backup CLAUDE.md',
        metadata: { upsert_key: 'claude-md-backup', type: 'architecture' },
      }),
    ];
    expect(getClaudeMdContent(notes)).toBe('# Backup CLAUDE.md');
  });

  it('returns null when no claude-md note exists', () => {
    const notes = [
      makeNote({
        content: 'Some other note',
        metadata: { type: 'preference', domain: 'persona' },
      }),
    ];
    expect(getClaudeMdContent(notes)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(getClaudeMdContent([])).toBeNull();
  });
});

describe('getMemoryMdContent', () => {
  it('returns content from a memory-md type note', () => {
    const notes = [
      makeNote({
        content: '# What I Know About You\n\nSearch guide here.',
        metadata: { type: 'memory-md', domain: 'persona' },
      }),
    ];
    expect(getMemoryMdContent(notes)).toBe('# What I Know About You\n\nSearch guide here.');
  });

  it('returns content from a memory-md upsert_key note', () => {
    const notes = [
      makeNote({
        content: '# Memory Index',
        metadata: { upsert_key: 'memory-md', type: 'persona' },
      }),
    ];
    expect(getMemoryMdContent(notes)).toBe('# Memory Index');
  });

  it('returns null when no memory-md note exists', () => {
    const notes = [
      makeNote({
        content: 'Some other note',
        metadata: { type: 'preference' },
      }),
    ];
    expect(getMemoryMdContent(notes)).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(getMemoryMdContent([])).toBeNull();
  });
});
