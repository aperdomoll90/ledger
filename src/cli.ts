#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './lib/config.js';
import { pull } from './commands/pull.js';
import { push } from './commands/push.js';
import { check } from './commands/check.js';
import { show } from './commands/show.js';
import { exportNote } from './commands/export.js';
import { ingest } from './commands/ingest.js';
import { init } from './commands/init.js';
import { setupClaudeCode, setupOpenclaw, setupChatgpt } from './commands/setup.js';
import { backup, enableBackupCron, disableBackupCron } from './commands/backup.js';
import { restore } from './commands/restore.js';
import { onboard } from './commands/onboard.js';
import { configGet, configSet, configList } from './commands/config.js';
import { migrate } from './commands/migrate.js';

process.on('unhandledRejection', (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

const program = new Command();

program
  .name('ledger')
  .description('AI identity and memory system — sync knowledge across agents and devices')
  .version('1.0.0');

program
  .command('pull')
  .description('Download notes from Ledger to local cache')
  .option('-q, --quiet', 'suppress non-conflict output')
  .option('-f, --force', 'overwrite local changes without conflict check')
  .action(async (options) => {
    const config = loadConfig();
    await pull(config, { quiet: options.quiet ?? false, force: options.force ?? false });
  });

program
  .command('push <file>')
  .description('Upload a local file to Ledger')
  .action(async (file) => {
    const config = loadConfig();
    await push(config, file);
  });

program
  .command('check')
  .description('Compare local files vs Ledger, report sync status')
  .action(async () => {
    const config = loadConfig();
    await check(config);
  });

program
  .command('show <query...>')
  .description('Search Ledger by meaning, open matching note')
  .option('-t, --type <type>', 'filter by note type (e.g. feedback, reference)')
  .option('-p, --project <project>', 'filter by project name')
  .action(async (queryParts: string[], options) => {
    const config = loadConfig();
    await show(config, queryParts.join(' '), { type: options.type, project: options.project });
  });

program
  .command('export <query...>')
  .description('Download a note to a custom location (untracked)')
  .option('-o, --output <path>', 'output directory (default: current directory)')
  .action(async (queryParts: string[], options) => {
    const config = loadConfig();
    await exportNote(config, queryParts.join(' '), options.output);
  });

program
  .command('ingest [file]')
  .description('Scan for unknown files and add them to Ledger with duplicate detection')
  .option('-a, --auto', 'auto-ingest without prompts (for hooks)')
  .action(async (file, options) => {
    const config = loadConfig();
    await ingest(config, { file, auto: options.auto ?? false });
  });

program
  .command('backup')
  .description('Backup all notes to ~/.ledger/backups/')
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
  .description('Restore notes from a backup JSON file')
  .action(async (file) => {
    const config = loadConfig();
    await restore(config, file);
  });

const configCmd = program
  .command('config')
  .description('View or change Ledger settings');

configCmd
  .command('get <key>')
  .description('Get a config value (or "all" for full config)')
  .action(async (key: string) => {
    await configGet(key);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value')
  .action(async (key: string, value: string) => {
    await configSet(key, value);
  });

configCmd
  .command('list')
  .description('Show all settings')
  .action(async () => {
    await configList();
  });

program
  .command('onboard')
  .description('Create your AI persona (profile, communication style, rules)')
  .action(async () => {
    const config = loadConfig();
    await onboard(config);
  });

program
  .command('init')
  .description('Set up Ledger on this machine (credentials, database schema)')
  .action(async () => {
    await init();
  });

const setupCmd = program
  .command('setup')
  .description('Configure an agent platform to use Ledger');

setupCmd
  .command('claude-code')
  .description('Register MCP, install hooks, pull cache (live sync)')
  .action(async () => {
    await setupClaudeCode();
  });

setupCmd
  .command('openclaw [path]')
  .description('Generate persona files for OpenClaw (live sync via CLI)')
  .action(async (path?: string) => {
    await setupOpenclaw(path);
  });

setupCmd
  .command('chatgpt')
  .description('Generate system prompt for ChatGPT (static snapshot)')
  .action(async () => {
    await setupChatgpt();
  });

program
  .command('migrate')
  .description('Safely migrate local files to Ledger (backup, compare, upload)')
  .action(async () => {
    const config = loadConfig();
    await migrate(config);
  });

program.parse();
