import type { LedgerConfig } from '../lib/config.js';
import type { IClientsProps } from '../lib/documents/classification.js';
import { createDocument } from '../lib/documents/operations.js';

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

// =============================================================================
// Command
// =============================================================================

export async function addDocument(config: LedgerConfig, options: IAddDocumentOptionsProps): Promise<void> {
  const clients: IClientsProps = {
    supabase: config.supabase,
    openai:   config.openai,
  };

  process.stderr.write(`Adding document "${options.name}" (${options.domain}/${options.documentType})...\n`);

  const documentId = await createDocument(clients, {
    name:          options.name,
    domain:        options.domain as import('../lib/documents/classification.js').Domain,
    document_type: options.documentType,
    content:       options.content,
    description:   options.description,
    project:       options.project,
    agent:         options.agent,
    status:        options.status as import('../lib/documents/classification.js').DocumentStatus | undefined,
    protection:    options.protection as import('../lib/documents/classification.js').Protection | undefined,
  });

  process.stdout.write(`${documentId}\n`);
  process.stderr.write(`Document created (id: ${documentId})\n`);
}
