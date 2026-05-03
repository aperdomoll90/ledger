import { resolve } from 'path';
import { existsSync } from 'fs';
import type { LedgerConfig } from '../lib/config.js';
import type { IClientsProps, Domain, DocumentStatus, Protection } from '../lib/documents/classification.js';
import { createDocumentFromFile, VerifyMismatchError } from '../lib/documents/operations.js';
import { fatal, ExitCode } from '../lib/errors.js';

// =============================================================================
// Interfaces
// =============================================================================

export interface IAddDocumentFromFileOptionsProps {
  filePath:     string;
  name:         string;
  domain:       string;
  documentType: string;
  project?:     string;
  description?: string;
  agent:        string;
  status?:      string;
  protection?:  string;
}

// =============================================================================
// Command
// =============================================================================

/**
 * Add a new document by reading content from a file on disk. Auto-verified after create.
 *
 * Bytes flow file -> createDocumentFromFile() -> Postgres without retyping.
 * The composed-string path (`-c`) was removed in Phase 4 of the
 * file-based-write-api rollout to close the drift class of bug.
 *
 * Drift surfaces as VerifyMismatchError on stderr with exit code VERIFY_MISMATCH.
 * The document still exists on verify failure (audit_log preserves the create
 * event for manual cleanup if needed).
 */
export async function addDocumentFromFile(
  config: LedgerConfig,
  options: IAddDocumentFromFileOptionsProps,
): Promise<void> {
  const absPath = resolve(options.filePath);
  if (!existsSync(absPath)) {
    fatal(`File not found: ${absPath}`, ExitCode.FILE_NOT_FOUND);
  }

  const clients: IClientsProps = {
    supabase: config.supabase,
    openai:   config.openai,
  };

  process.stderr.write(`Adding document "${options.name}" from ${absPath} (${options.domain}/${options.documentType})...\n`);

  try {
    const result = await createDocumentFromFile(clients, {
      filePath:      absPath,
      name:          options.name,
      domain:        options.domain as Domain,
      document_type: options.documentType,
      description:   options.description,
      project:       options.project,
      agent:         options.agent,
      status:        options.status as DocumentStatus | undefined,
      protection:    options.protection as Protection | undefined,
    });

    process.stdout.write(`${result.id}\n`);
    process.stderr.write(`Document created (id: ${result.id}, ${result.bytes} bytes, verified)\n`);
  } catch (error) {
    if (error instanceof VerifyMismatchError) {
      process.stderr.write(`\nVerify failed on document ${error.id}.\n`);
      process.stderr.write(`Pushed ${error.expectedLength} bytes, pulled ${error.actualLength} bytes.\n`);
      process.stderr.write(`${error.diffPreview}\n`);
      process.stderr.write(`The document was created but the round-trip diff caught drift. Inspect the doc and re-run if needed.\n`);
      process.exit(ExitCode.VERIFY_MISMATCH);
    }
    throw error;
  }
}
