import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { LedgerConfig } from '../lib/config.js';
import { getDocumentById } from '../lib/documents/fetching.js';
import { updateDocument, updateDocumentFromFile, VerifyMismatchError } from '../lib/documents/operations.js';
import { confirm } from '../lib/prompt.js';
import { fatal, ExitCode } from '../lib/errors.js';

interface IUpdateOptionsProps {
  yes?: boolean;
}

// Shared pre-flight: validate the doc exists and is mutable, return it for preview rendering.
async function loadAndValidate(
  config: LedgerConfig,
  id: number,
): Promise<{ name: string; content: string }> {
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
  return { name: document.name, content: document.content };
}

function renderPreview(name: string, id: number, oldContent: string, newContent: string): void {
  process.stderr.write(`Document: "${name}" (id: ${id})\n`);
  process.stderr.write(`Current content preview: ${oldContent.slice(0, 200)}${oldContent.length > 200 ? '...' : ''}\n`);
  process.stderr.write(`\nNew content preview: ${newContent.slice(0, 200)}${newContent.length > 200 ? '...' : ''}\n`);
}

function reportVerifyError(error: VerifyMismatchError): never {
  process.stderr.write(`\nVerify failed on document ${error.id}.\n`);
  process.stderr.write(`Pushed ${error.expectedLength} bytes, pulled ${error.actualLength} bytes.\n`);
  process.stderr.write(`${error.diffPreview}\n`);
  process.stderr.write(`The push completed but the round-trip diff caught drift. Re-pull and re-edit.\n`);
  process.exit(ExitCode.VERIFY_MISMATCH);
}

/**
 * Update by passing content inline as a CLI argument (-c).
 *
 * This path is convenient for one-line edits but breaks at ~128 KB (Linux ARG_MAX).
 * For anything bigger, or anything where drift safety matters, use updateFromFile (-f).
 */
export async function update(
  config: LedgerConfig,
  id: number,
  content: string,
  options: IUpdateOptionsProps = {},
): Promise<void> {
  const document = await loadAndValidate(config, id);
  renderPreview(document.name, id, document.content, content);

  if (!options.yes) {
    const proceed = await confirm('\nProceed with update?');
    if (!proceed) {
      process.stderr.write('Cancelled.\n');
      return;
    }
  }

  await updateDocument(
    { supabase: config.supabase, openai: config.openai },
    { id, content, agent: 'cli' },
  );
  process.stderr.write(`Document ${id} updated successfully.\n`);
}

/**
 * Update by reading content from a file on disk (-f). Auto-verified after push.
 *
 * Bytes flow file -> updateDocumentFromFile() -> Postgres, then we pull the doc
 * back and byte-compare. Any drift throws VerifyMismatchError, which we surface
 * to stderr and exit with VERIFY_MISMATCH.
 *
 * Use this for any edit you want to be sure round-tripped cleanly, and for any
 * doc that would push past the ARG_MAX limit on the -c path.
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

  const document = await loadAndValidate(config, id);
  const newContent = readFileSync(absPath, 'utf8');
  renderPreview(document.name, id, document.content, newContent);
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
    if (error instanceof VerifyMismatchError) reportVerifyError(error);
    throw error;
  }
}
