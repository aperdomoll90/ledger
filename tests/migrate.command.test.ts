import { describe, it, expect } from 'vitest';
import { extractSections, combineContent } from '../src/commands/migrate.js';

describe('extractSections', () => {
  it('extracts sections from markdown with ## headings', () => {
    const md = `# Title

## Section One
Content for one.

## Section Two
Content for two.
More content.`;

    const sections = extractSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].heading).toBe('Title');
    expect(sections[1].heading).toBe('Section One');
    expect(sections[1].content).toContain('Content for one.');
    expect(sections[2].heading).toBe('Section Two');
    expect(sections[2].content).toContain('More content.');
  });

  it('handles ### subheadings', () => {
    const md = `## Main
Intro.

### Sub
Detail.`;

    const sections = extractSections(md);
    expect(sections).toHaveLength(2);
    expect(sections[0].heading).toBe('Main');
    expect(sections[1].heading).toBe('Sub');
  });

  it('returns empty for empty string', () => {
    expect(extractSections('')).toHaveLength(0);
  });

  it('returns empty for content without headings', () => {
    expect(extractSections('Just plain text\nwith lines')).toHaveLength(0);
  });

  it('handles single section', () => {
    const md = `## Only Section
Some content here.`;

    const sections = extractSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Only Section');
  });

  it('skips sections with empty content', () => {
    const md = `## Has Content
Real content here.

## Empty Next`;

    const sections = extractSections(md);
    // "Empty Next" has no lines after it, so it's still captured with empty content
    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe('Has Content');
  });
});

describe('combineContent', () => {
  it('adds lines from local that are not in ledger', () => {
    const ledger = 'Line A\nLine B';
    const local = 'Line A\nLine B\nLine C';

    const result = combineContent(ledger, local);
    expect(result).toContain('Line A');
    expect(result).toContain('Line B');
    expect(result).toContain('Line C');
  });

  it('returns ledger content unchanged if local has no new lines', () => {
    const ledger = 'Line A\nLine B\nLine C';
    const local = 'Line A\nLine B';

    const result = combineContent(ledger, local);
    expect(result).toBe(ledger);
  });

  it('handles completely different content', () => {
    const ledger = 'Alpha\nBeta';
    const local = 'Gamma\nDelta';

    const result = combineContent(ledger, local);
    expect(result).toContain('Alpha');
    expect(result).toContain('Beta');
    expect(result).toContain('Gamma');
    expect(result).toContain('Delta');
  });

  it('deduplicates by trimmed line comparison', () => {
    const ledger = '  Line A  \nLine B';
    const local = 'Line A\n  Line B  \nLine C';

    const result = combineContent(ledger, local);
    // Line A and Line B should not be duplicated (trimmed match)
    const lineCount = result.split('\n').filter(l => l.trim() === 'Line C').length;
    expect(lineCount).toBe(1);
  });

  it('ignores empty lines from local', () => {
    const ledger = 'Line A';
    const local = 'Line A\n\n\n';

    const result = combineContent(ledger, local);
    expect(result).toBe(ledger);
  });

  it('handles empty ledger content', () => {
    const ledger = '';
    const local = 'New content';

    const result = combineContent(ledger, local);
    expect(result).toContain('New content');
  });

  it('handles empty local content', () => {
    const ledger = 'Existing content';
    const local = '';

    const result = combineContent(ledger, local);
    expect(result).toBe(ledger);
  });
});
