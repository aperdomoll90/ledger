import { resolve } from 'path';
import { existsSync } from 'fs';
import type { LedgerConfig } from '../lib/config.js';
import type { IClientsProps, Domain, DocumentStatus, Protection } from '../lib/documents/classification.js';
import { createDocument, createDocumentFromFile, VerifyMismatchError } from '../lib/documents/operations.js';
import { fatal, ExitCode } from '../lib/errors.js';

// =============================================================================
// Interfaces
// =============================================================================

export interface IAddDocumentOptionsProps {
  content:      string;
  name:         string;
  domain:       string;
  documentType: string;
  project?:     string;
  description?: string;
  agent:        string;
  status?:      string;
  protection?:  string;
}

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
// Commands
// =============================================================================

/**
 * Add a new document by passing content inline as a CLI argument (-c).
 *
 * Convenient for short docs but breaks at ~128 KB (Linux ARG_MAX). For larger
 * docs or any case where drift safety matters, use addDocumentFromFile (-f).
 */
export async function addDocument(config: LedgerConfig, options: IAddDocumentOptionsProps): Promise<void> {
  const clients: IClientsProps = {
    supabase: config.supabase,
    openai:   config.openai,
  };

  process.stderr.write(`Adding document "${options.name}" (${options.domain}/${options.documentType})...\n`);

  const documentId = await createDocument(clients, {
    name:          options.name,
    domain:        options.domain as Domain,
    document_type: options.documentType,
    content:       options.content,
    description:   options.description,
    project:       options.project,
    agent:         options.agent,
    status:        options.status as DocumentStatus | undefined,
    protection:    options.protection as Protection | undefined,
  });

  process.stdout.write(`${documentId}\n`);
  process.stderr.write(`Document created (id: ${documentId})\n`);
}

/**
 * Add a new document by reading content from a file on disk (-f). Auto-verified after create.
 *
 * Bytes flow file -> createDocumentFromFile() -> Postgres, then we pull the new doc
 * back and byte-compare. Drift surfaces as VerifyMismatchError on stderr with
 * exit code VERIFY_MISMATCH; the document still exists (audit_log preserves the
 * create event for manual cleanup if needed).
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
