#!/usr/bin/env node
// cli.ts — Ledger CLI entry point.
// 14 commands for managing the RAG knowledge base.

import { Command } from 'commander';
import { createRequire } from 'module';
import { loadConfig } from './lib/config.js';
import { shutdownObservability } from './lib/observability.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

// Commands
import { init } from './commands/init.js';
import { addDocument } from './commands/add.js';
import { list } from './commands/list.js';
import { show } from './commands/show.js';
import { get } from './commands/get.js';
import { exportDocument } from './commands/export.js';
import { push } from './commands/push.js';
import { update } from './commands/update.js';
import { removeDocument } from './commands/delete.js';
import { tag } from './commands/tag.js';
import { check } from './commands/check.js';
import { backup, enableBackupCron, disableBackupCron } from './commands/backup.js';
import { restore } from './commands/restore.js';
import { lint } from './commands/lint.js';
import { evalSearch, sweepThreshold, showEvalRun } from './commands/eval.js';
import { evalJudge } from './commands/eval-judge.js';

process.on('unhandledRejection', (rejection) => {
  console.error(rejection instanceof Error ? rejection.message : String(rejection));
  process.exit(1);
});

// Flush pending Langfuse traces before exit
const shutdown = async () => {
  await shutdownObservability();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const program = new Command();
program
  .name('ledger')
  .description('AI identity and memory system — RAG-powered knowledge base for agents')
  .version(version);

// =============================================================================
// Document management
// =============================================================================

program
  .command('add')
  .description('Add a new document to Ledger')
  .requiredOption('-c, --content <content>', 'document content')
  .requiredOption('-n, --name <name>', 'unique document name (lowercase, hyphens)')
  .option('-d, --domain <domain>', 'domain: system, persona, workspace, project, general', 'general')
  .option('-t, --type <type>', 'document type (architecture, reference, knowledge, etc.)', 'knowledge')
  .option('-p, --project <project>', 'project name')
  .option('--description <text>', 'one-line description')
  .option('-a, --agent <agent>', 'agent name', 'cli')
  .option('-s, --status <status>', 'status: idea, planning, active, done')
  .option('--protection <level>', 'protection: open, guarded, protected, immutable')
  .action(async (options) => {
    const config = loadConfig();
    await addDocument(config, {
      content: options.content,
      name: options.name,
      domain: options.domain,
      documentType: options.type,
      project: options.project,
      description: options.description,
      agent: options.agent,
      status: options.status,
      protection: options.protection,
    });
  });

program
  .command('list')
  .description('List recent documents from Ledger')
  .option('-n, --limit <number>', 'number of documents', '20')
  .option('-t, --type <type>', 'filter by document type')
  .option('-p, --project <project>', 'filter by project name')
  .action(async (options) => {
    const config = loadConfig();
    await list(config, {
      limit: parseInt(options.limit, 10),
      type: options.type,
      project: options.project,
    });
  });

program
  .command('get <name>')
  .description('Fetch a document by exact name and print its content')
  .action(async (name) => {
    const config = loadConfig();
    await get(config, name);
  });

program
  .command('show <query...>')
  .description('Search Ledger by meaning, open matching document')
  .option('-t, --type <type>', 'filter by document type')
  .option('-p, --project <project>', 'filter by project name')
  .action(async (queryParts, options) => {
    const config = loadConfig();
    await show(config, queryParts.join(' '), { type: options.type, project: options.project });
  });

program
  .command('export <query...>')
  .description('Download a document to a file')
  .option('-o, --output <path>', 'output directory (default: current directory)')
  .action(async (queryParts, options) => {
    const config = loadConfig();
    await exportDocument(config, queryParts.join(' '), options.output);
  });

program
  .command('push <file>')
  .description('Upload a local file to Ledger')
  .action(async (file) => {
    const config = loadConfig();
    await push(config, file);
  });

program
  .command('update <id>')
  .description('Update a document by ID')
  .requiredOption('-c, --content <content>', 'new content')
  .action(async (documentId, options) => {
    const config = loadConfig();
    await update(config, parseInt(documentId, 10), options.content);
  });

program
  .command('delete <id>')
  .description('Soft-delete a document by ID')
  .action(async (documentId) => {
    const config = loadConfig();
    await removeDocument(config, parseInt(documentId, 10));
  });

program
  .command('tag <id>')
  .description('Update metadata on a document (description, project, domain)')
  .option('-d, --description <text>', 'document description')
  .option('-p, --project <name>', 'project name')
  .option('--domain <domain>', 'domain: system, persona, workspace, project, general')
  .action(async (documentId, options) => {
    const config = loadConfig();
    await tag(config, parseInt(documentId, 10), {
      description: options.description,
      project: options.project,
      domain: options.domain,
    });
  });

// =============================================================================
// Search quality
// =============================================================================

program
  .command('eval')
  .description('Run search quality evaluation against golden dataset')
  .option('--dry-run', 'print report without saving to database')
  .action(async (options) => {
    const config = loadConfig();
    await evalSearch(config, { dryRun: options.dryRun ?? false });
  });

program
  .command('eval:sweep')
  .description('Test multiple similarity thresholds to find optimal value')
  .option('--thresholds <values>', 'comma-separated thresholds to test', '0.15,0.20,0.25,0.30,0.35,0.40')
  .action(async (options) => {
    const config = loadConfig();
    await sweepThreshold(config, { thresholds: options.thresholds });
  });

program
  .command('eval:show <runId>')
  .description('Inspect a saved eval run — summary metrics and missed queries with doc names')
  .option('--full', 'also dump per-query results as JSON', false)
  .action(async (runIdArg, options) => {
    const config = loadConfig();
    const runId  = parseInt(runIdArg, 10);
    if (isNaN(runId)) {
      process.stderr.write(`Invalid run id: ${runIdArg}\n`);
      process.exit(1);
    }
    await showEvalRun(config, runId, { full: options.full ?? false });
  });

program
  .command('eval:judge')
  .description('Resumable rejudging walkthrough — grade top-10 search results per query using TREC 4-level scale')
  .option('--query <id>', 'start at a specific golden query id', (value: string) => parseInt(value, 10))
  .action(async (options) => {
    const config = loadConfig();
    await evalJudge(config, { query: options.query });
  });

// =============================================================================
// Sync and maintenance
// =============================================================================

program
  .command('check')
  .description('Compare local files vs Ledger, report sync status')
  .action(async () => {
    const config = loadConfig();
    await check(config);
  });

program
  .command('backup')
  .description('Backup all documents to ~/.ledger/backups/')
  .option('-q, --quiet', 'suppress output unless error')
  .option('--enable-cron', 'enable daily backup at 1am')
  .option('--disable-cron', 'disable daily backup cron')
  .action(async (options) => {
    if (options.enableCron) {
      enableBackupCron();
      return;
    }
    if (options.disableCron) {
      disableBackupCron();
      return;
    }
    const config = loadConfig();
    await backup(config, { quiet: options.quiet ?? false });
  });

program
  .command('restore <file>')
  .description('Restore documents from a backup JSON file')
  .action(async (file) => {
    const config = loadConfig();
    await restore(config, file);
  });

// =============================================================================
// Setup and configuration
// =============================================================================

program
  .command('init')
  .description('Set up Ledger credentials and database')
  .action(async () => {
    await init();
  });

program
  .command('lint')
  .description('Add lint configs to the current project based on detected stack')
  .option('--personal', 'include personal conventions (BEM, SCSS patterns)')
  .option('--diff', 'compare local configs against Ledger versions')
  .action(async (options) => {
    await lint({ personal: options.personal ?? false, diff: options.diff ?? false });
  });

program.parseAsync().then(() => shutdownObservability());
