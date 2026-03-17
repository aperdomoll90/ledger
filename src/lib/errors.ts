export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code: ExitCode,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export enum ExitCode {
  SUCCESS = 0,
  GENERAL_ERROR = 1,
  FILE_NOT_FOUND = 2,
  NOTE_NOT_FOUND = 3,
  SUPABASE_ERROR = 4,
  EMBEDDING_ERROR = 5,
  CONFLICT = 6,
  INVALID_INPUT = 7,
}

export function fatal(message: string, code: ExitCode = ExitCode.GENERAL_ERROR): never {
  console.error(message);
  process.exit(code);
}
