import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { LedgerConfig } from '../lib/config.js';
import { getDocumentById } from '../lib/documents/fetching.js';
import { updateDocumentFromFile, VerifyMismatchError } from '../lib/documents/operations.js';
import { confirm } from '../lib/prompt.js';
import { fatal, ExitCode } from '../lib/errors.js';

interface IUpdateOptionsProps {
  yes?: boolean;
}

/**
 * Update an existing document by reading new content from a file on disk.
 * Auto-verified after push: the doc is pulled back and byte-compared against
 * the file we sent. VerifyMismatchError on round-trip drift.
 *
 * Bytes flow file -> updateDocumentFromFile() -> Postgres without retyping.
 * The composed-string path (`-c`) was removed in Phase 4 of the
 * file-based-write-api rollout to close the drift class of bug.
 */
export async function updateFromFile(
  config: LedgerConfig,
  id: number,
  filePath: string,
  options: IUpdateOptionsProps = {},
): Promise<void> {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    fatal(`File not found: ${absPath}`, ExitCode.FILE_NOT_FOUND);
  }

  const document = await getDocumentById(config.supabase, id);
  if (!document) {
    fatal(`Document ${id} not found.`, ExitCode.DOCUMENT_NOT_FOUND);
  }
  if (document.protection === 'immutable') {
    fatal(
      `Document "${document.name}" (id: ${id}) is immutable and cannot be updated.`,
      ExitCode.PROTECTED,
    );
  }

  const newContent = readFileSync(absPath, 'utf8');
  process.stderr.write(`Document: "${document.name}" (id: ${id})\n`);
  process.stderr.write(`Current content preview: ${document.content.slice(0, 200)}${document.content.length > 200 ? '...' : ''}\n`);
  process.stderr.write(`\nNew content preview: ${newContent.slice(0, 200)}${newContent.length > 200 ? '...' : ''}\n`);
  process.stderr.write(`Source file: ${absPath} (${newContent.length} bytes)\n`);

  if (!options.yes) {
    const proceed = await confirm('\nProceed with update?');
    if (!proceed) {
      process.stderr.write('Cancelled.\n');
      return;
    }
  }

  try {
    const result = await updateDocumentFromFile(
      { supabase: config.supabase, openai: config.openai },
      { id, filePath: absPath, agent: 'cli' },
    );
    process.stderr.write(`Document ${id} updated successfully (${result.bytes} bytes, verified).\n`);
  } catch (error) {
    if (error instanceof VerifyMismatchError) {
      process.stderr.write(`\nVerify failed on document ${error.id}.\n`);
      process.stderr.write(`Pushed ${error.expectedLength} bytes, pulled ${error.actualLength} bytes.\n`);
      process.stderr.write(`${error.diffPreview}\n`);
      process.stderr.write(`The push completed but the round-trip diff caught drift. Re-pull and re-edit.\n`);
      process.exit(ExitCode.VERIFY_MISMATCH);
    }
    throw error;
  }
}
