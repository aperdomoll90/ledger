// eval-judge-session.test.ts
// Unit tests for pure functions in eval-judge-session.ts.

import { describe, it, expect } from 'vitest';
import {
  parseGradeInput,
  pickNextUngraded,
  formatProgressLine,
  type IUngradedCandidateProps,
} from '../src/lib/eval/eval-judge-session.js';

// =============================================================================
// parseGradeInput
// =============================================================================

describe('parseGradeInput', () => {
  it('parses 0/1/2/3 as grades', () => {
    expect(parseGradeInput('0')).toEqual({ kind: 'grade', value: 0 });
    expect(parseGradeInput('1')).toEqual({ kind: 'grade', value: 1 });
    expect(parseGradeInput('2')).toEqual({ kind: 'grade', value: 2 });
    expect(parseGradeInput('3')).toEqual({ kind: 'grade', value: 3 });
  });

  it('parses commands', () => {
    expect(parseGradeInput('s')).toEqual({ kind: 'skip' });
    expect(parseGradeInput('b')).toEqual({ kind: 'back' });
    expect(parseGradeInput('q')).toEqual({ kind: 'quit' });
    expect(parseGradeInput('n')).toEqual({ kind: 'note' });
    expect(parseGradeInput('?')).toEqual({ kind: 'rubric' });
  });

  it('rejects invalid input', () => {
    expect(parseGradeInput('4')).toEqual({ kind: 'invalid', raw: '4' });
    expect(parseGradeInput('xx')).toEqual({ kind: 'invalid', raw: 'xx' });
    expect(parseGradeInput('')).toEqual({ kind: 'invalid', raw: '' });
  });

  it('trims whitespace', () => {
    expect(parseGradeInput('  2  ')).toEqual({ kind: 'grade', value: 2 });
    expect(parseGradeInput(' q ')).toEqual({ kind: 'quit' });
  });
});

// =============================================================================
// pickNextUngraded
// =============================================================================

describe('pickNextUngraded', () => {
  const makeCandidate = (docId: number, graded: boolean): IUngradedCandidateProps => ({
    document_id: docId,
    graded,
  });

  it('returns first ungraded candidate', () => {
    const candidates = [makeCandidate(1, true), makeCandidate(2, false), makeCandidate(3, false)];
    expect(pickNextUngraded(candidates)).toEqual(makeCandidate(2, false));
  });

  it('returns null when all are graded', () => {
    const candidates = [makeCandidate(1, true), makeCandidate(2, true)];
    expect(pickNextUngraded(candidates)).toBeNull();
  });

  it('returns null for empty list', () => {
    expect(pickNextUngraded([])).toBeNull();
  });
});

// =============================================================================
// formatProgressLine
// =============================================================================

describe('formatProgressLine', () => {
  it('formats progress with percent', () => {
    const line = formatProgressLine({ queriesComplete: 37, queriesTotal: 144, judgmentsTotal: 296 });
    expect(line).toContain('37 / 144');
    expect(line).toContain('26%');
    expect(line).toContain('296');
  });

  it('handles zero total gracefully', () => {
    const line = formatProgressLine({ queriesComplete: 0, queriesTotal: 0, judgmentsTotal: 0 });
    expect(line).toContain('0 / 0');
    expect(line).toContain('0%');
  });
});
