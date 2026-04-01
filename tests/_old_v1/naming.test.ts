import { describe, it, expect } from 'vitest';
import { validateNaming, deriveFilePath, checkMetadataCompleteness } from '../src/lib/notes.js';

describe('validateNaming', () => {
  // --- Valid keys ---

  it('accepts feedback-{topic}', () => {
    expect(validateNaming('feedback-communication-style', 'feedback', 'How to communicate')).toBeNull();
  });

  it('accepts user-{topic}', () => {
    expect(validateNaming('user-profile', 'user-preference', 'User profile')).toBeNull();
  });

  it('accepts project-scoped key: {project}-{prefix}-{topic}', () => {
    expect(validateNaming('ledger-spec-init', 'architecture-decision', 'Init wizard spec')).toBeNull();
  });

  it('accepts architecture-{topic}', () => {
    expect(validateNaming('ledger-architecture-system-map', 'architecture-decision', 'System map')).toBeNull();
  });

  it('accepts reference-{topic}', () => {
    expect(validateNaming('reference-repo-docs-structure', 'reference', 'How to structure docs')).toBeNull();
  });

  it('accepts project-scoped devlog', () => {
    expect(validateNaming('ledger-devlog', 'event', 'Dev log')).toBeNull();
  });

  it('accepts project-scoped errorlog', () => {
    expect(validateNaming('ledger-errorlog', 'error', 'Error log')).toBeNull();
  });

  it('accepts project-status', () => {
    expect(validateNaming('project-status', 'project-status', 'Big-picture status')).toBeNull();
  });

  // --- Invalid keys ---

  it('rejects empty upsert_key', () => {
    const result = validateNaming('', 'feedback', 'Some description');
    expect(result).toContain('upsert_key is required');
  });

  it('rejects missing description', () => {
    const result = validateNaming('feedback-style', 'feedback', undefined);
    expect(result).toContain('description is required');
  });

  it('rejects underscores', () => {
    const result = validateNaming('feedback_style', 'feedback', 'Style rules');
    expect(result).toContain('lowercase-hyphenated');
  });

  it('rejects uppercase', () => {
    const result = validateNaming('Feedback-Style', 'feedback', 'Style rules');
    expect(result).toContain('lowercase-hyphenated');
  });

  it('rejects wrong prefix for type', () => {
    const result = validateNaming('user-something', 'feedback', 'Some rule');
    expect(result).toContain("doesn't match type");
    expect(result).toContain('feedback');
  });

  it('rejects feedback prefix for user-preference type', () => {
    const result = validateNaming('feedback-something', 'user-preference', 'Profile data');
    expect(result).toContain("doesn't match type");
    expect(result).toContain('user');
  });

  // --- Edge cases ---

  it('accepts unknown types without prefix validation', () => {
    // Types not in TYPE_PREFIXES skip prefix check
    expect(validateNaming('custom-something', 'unknown-custom-type', 'A guide')).toBeNull();
  });

  it('rejects special characters', () => {
    const result = validateNaming('feedback-style!', 'feedback', 'Style');
    expect(result).toContain('lowercase-hyphenated');
  });

  it('rejects trailing hyphens', () => {
    const result = validateNaming('feedback-', 'feedback', 'Style');
    expect(result).toContain('lowercase-hyphenated');
  });
});

describe('deriveFilePath', () => {
  it('converts hyphens to underscores and adds .md', () => {
    expect(deriveFilePath('feedback-communication-style')).toBe('feedback_communication_style.md');
  });

  it('handles single-segment key', () => {
    expect(deriveFilePath('profile')).toBe('profile.md');
  });

  it('handles project-scoped key', () => {
    expect(deriveFilePath('ledger-spec-init')).toBe('ledger_spec_init.md');
  });
});

describe('checkMetadataCompleteness', () => {
  it('returns null when all fields present', () => {
    const metadata = {
      description: 'My note',
      upsert_key: 'feedback-style',
    };
    expect(checkMetadataCompleteness(metadata, 'feedback')).toBeNull();
  });

  it('asks for description when missing', () => {
    const metadata = { upsert_key: 'feedback-style' };
    const result = checkMetadataCompleteness(metadata, 'feedback');
    expect(result).toContain('description');
    expect(result).toContain('METADATA NEEDED');
  });

  it('asks for upsert_key when missing', () => {
    const metadata = { description: 'My note' };
    const result = checkMetadataCompleteness(metadata, 'feedback');
    expect(result).toContain('upsert_key');
  });

  it('asks for status on project-scoped types', () => {
    const metadata = {
      description: 'System map',
      upsert_key: 'ledger-architecture',
    };
    const result = checkMetadataCompleteness(metadata, 'architecture-decision');
    expect(result).toContain('status');
  });

  it('does not ask for status on persona types', () => {
    const metadata = {
      description: 'Style rules',
      upsert_key: 'feedback-style',
    };
    expect(checkMetadataCompleteness(metadata, 'feedback')).toBeNull();
  });

  it('returns null when all fields present including status', () => {
    const metadata = {
      description: 'System map',
      upsert_key: 'ledger-architecture',
      status: 'active',
    };
    expect(checkMetadataCompleteness(metadata, 'architecture-decision')).toBeNull();
  });

  it('includes interactive_skip instruction', () => {
    const metadata = {};
    const result = checkMetadataCompleteness(metadata, 'general');
    expect(result).toContain('interactive_skip');
  });

  it('asks for multiple missing fields at once', () => {
    const metadata = {};
    const result = checkMetadataCompleteness(metadata, 'architecture-decision');
    expect(result).toContain('description');
    expect(result).toContain('upsert_key');
    expect(result).toContain('status');
  });
});
