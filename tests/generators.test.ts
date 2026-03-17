import { describe, it, expect } from 'vitest';
import { generateClaudeMd, generateMemoryMd } from '../src/lib/generators.js';
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

describe('generateClaudeMd', () => {
  it('maps feedback-no-read-env to Security section', () => {
    const notes = [
      makeNote({
        content: '- Never read .env files',
        metadata: { upsert_key: 'feedback-no-read-env', type: 'feedback' },
      }),
    ];
    const result = generateClaudeMd(notes);
    expect(result).toContain('## Security');
    expect(result).toContain('Never read .env files');
  });

  it('maps feedback-coding-conventions to Coding Conventions section', () => {
    const notes = [
      makeNote({
        content: '- BEM naming with c- prefix',
        metadata: { upsert_key: 'feedback-coding-conventions', type: 'feedback' },
      }),
    ];
    const result = generateClaudeMd(notes);
    expect(result).toContain('## Coding Conventions');
    expect(result).toContain('BEM naming');
  });

  it('maps feedback-communication-style to Communication section', () => {
    const notes = [
      makeNote({
        content: '- No sycophancy\n- Structured outputs',
        metadata: { upsert_key: 'feedback-communication-style', type: 'feedback' },
      }),
    ];
    const result = generateClaudeMd(notes);
    expect(result).toContain('## Communication');
    expect(result).toContain('No sycophancy');
  });

  it('puts unmapped feedback notes in General section', () => {
    const notes = [
      makeNote({
        content: '- Some custom rule',
        metadata: { upsert_key: 'feedback-custom-thing', type: 'feedback' },
      }),
    ];
    const result = generateClaudeMd(notes);
    expect(result).toContain('## General');
    expect(result).toContain('Some custom rule');
  });

  it('ignores non-feedback notes', () => {
    const notes = [
      makeNote({
        content: '- Should not appear',
        metadata: { upsert_key: 'reference-something', type: 'reference' },
      }),
    ];
    const result = generateClaudeMd(notes);
    expect(result).not.toContain('Should not appear');
  });

  it('strips Why/How to apply lines', () => {
    const notes = [
      makeNote({
        content: '- Rule one\n**Why:** Because reasons\n**How to apply:** Do the thing',
        metadata: { upsert_key: 'feedback-no-read-env', type: 'feedback' },
      }),
    ];
    const result = generateClaudeMd(notes);
    expect(result).toContain('Rule one');
    expect(result).not.toContain('Because reasons');
    expect(result).not.toContain('Do the thing');
  });

  it('starts with # Global Rules', () => {
    const result = generateClaudeMd([]);
    expect(result.trim()).toBe('# Global Rules');
  });

  it('groups multiple Architecture notes under one section', () => {
    const notes = [
      makeNote({
        content: '- Use claude mcp add',
        metadata: { upsert_key: 'feedback-mcp-registration', type: 'feedback' },
      }),
      makeNote({
        id: 2,
        content: '- Always consider CLI tools',
        metadata: { upsert_key: 'feedback-prefer-cli-and-skills', type: 'feedback' },
      }),
    ];
    const result = generateClaudeMd(notes);
    const archSections = result.split('## Architecture');
    expect(archSections).toHaveLength(2); // exactly one Architecture section
    expect(result).toContain('claude mcp add');
    expect(result).toContain('CLI tools');
  });
});

describe('generateMemoryMd', () => {
  it('groups user_ files under User Profile', () => {
    const result = generateMemoryMd(['user_profile.md', 'user_style.md']);
    expect(result).toContain('## User Profile');
    expect(result).toContain('[user_profile.md]');
    expect(result).toContain('[user_style.md]');
  });

  it('groups feedback_ files under Feedback', () => {
    const result = generateMemoryMd(['feedback_coding.md']);
    expect(result).toContain('## Feedback (Behavioral Rules)');
    expect(result).toContain('[feedback_coding.md]');
  });

  it('groups project_ files under Project Status', () => {
    const result = generateMemoryMd(['project_status.md']);
    expect(result).toContain('## Project Status');
    expect(result).toContain('[project_status.md]');
  });

  it('includes Not Auto-Loaded section', () => {
    const result = generateMemoryMd([]);
    expect(result).toContain('## Not Auto-Loaded');
    expect(result).toContain('search on demand');
  });

  it('starts with Memory Index header', () => {
    const result = generateMemoryMd([]);
    expect(result).toContain('# Memory Index');
  });

  it('handles mixed file types', () => {
    const result = generateMemoryMd([
      'user_profile.md',
      'feedback_rules.md',
      'project_status.md',
      'reference_npm.md', // should not appear in any group
    ]);
    expect(result).toContain('## User Profile');
    expect(result).toContain('## Feedback (Behavioral Rules)');
    expect(result).toContain('## Project Status');
    expect(result).not.toContain('[reference_npm.md]');
  });
});
