import { describe, it, expect } from 'vitest';
import { LedgerError, ExitCode } from '../src/lib/errors.js';

describe('LedgerError', () => {
  it('creates error with message and code', () => {
    const err = new LedgerError('something broke', ExitCode.SUPABASE_ERROR);
    expect(err.message).toBe('something broke');
    expect(err.code).toBe(ExitCode.SUPABASE_ERROR);
    expect(err.name).toBe('LedgerError');
  });

  it('is an instance of Error', () => {
    const err = new LedgerError('test', ExitCode.GENERAL_ERROR);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ExitCode', () => {
  it('has expected values', () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.FILE_NOT_FOUND).toBe(2);
    expect(ExitCode.NOTE_NOT_FOUND).toBe(3);
    expect(ExitCode.SUPABASE_ERROR).toBe(4);
    expect(ExitCode.EMBEDDING_ERROR).toBe(5);
    expect(ExitCode.CONFLICT).toBe(6);
    expect(ExitCode.INVALID_INPUT).toBe(7);
  });

  it('has unique values', () => {
    const values = Object.values(ExitCode).filter(v => typeof v === 'number');
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
