import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import type { LedgerConfig } from '../lib/config.js';
import { getLedgerDir } from '../lib/config.js';

interface BackupOptions {
  quiet: boolean;
}

export async function backup(config: LedgerConfig, options: BackupOptions): Promise<void> {
  const { quiet } = options;
  const backupDir = resolve(getLedgerDir(), 'backups');
  mkdirSync(backupDir, { recursive: true });

  // Fetch all documents (not just cached)
  const { data, error } = await config.supabase
    .from('documents')
    .select('id, name, domain, document_type, project, protection, content, description, status, created_at, updated_at')
    .order('id', { ascending: true });

  if (error) {
    console.error(`Backup failed: ${error.message}`);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    if (!quiet) console.error('No documents to backup.');
    return;
  }

  const date = new Date().toISOString().split('T')[0];
  const filePath = resolve(backupDir, `${date}.json`);

  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');

  // Keep last 5 backups, delete older
  const backups = readdirSync(backupDir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .reverse();

  for (const old of backups.slice(5)) {
    unlinkSync(resolve(backupDir, old));
    if (!quiet) console.error(`  deleted old backup: ${old}`);
  }

  if (!quiet) {
    console.error(`Backed up ${data.length} documents to ${filePath}`);
  }
  console.log(filePath);
}

export function enableBackupCron(): void {
  const cronLine = '0 1 * * * ledger backup --quiet';

  // Check if already in crontab
  let existing = '';
  try {
    existing = execFileSync('crontab', ['-l'], { encoding: 'utf-8' });
  } catch {
    // No crontab yet
  }

  if (existing.includes('ledger backup')) {
    console.error('Backup cron already enabled.');
    return;
  }

  const newCrontab = existing.trimEnd() + '\n' + cronLine + '\n';

  try {
    const result = spawnSync('crontab', ['-'], { input: newCrontab, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error(result.stderr?.toString() || 'crontab failed');
    console.error('Daily backup enabled (1am). View with `crontab -l`.');
  } catch (cronError) {
    console.error(`Failed to set cron: ${(cronError as Error).message}`);
    console.error(`Add manually: ${cronLine}`);
  }
}

export function disableBackupCron(): void {
  let existing = '';
  try {
    existing = execFileSync('crontab', ['-l'], { encoding: 'utf-8' });
  } catch {
    console.error('No crontab found.');
    return;
  }

  const filtered = existing
    .split('\n')
    .filter(line => !line.includes('ledger backup'))
    .join('\n');

  try {
    const result = spawnSync('crontab', ['-'], { input: filtered, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error(result.stderr?.toString() || 'crontab failed');
    console.error('Backup cron disabled.');
  } catch (cronError) {
    console.error(`Failed to update cron: ${(cronError as Error).message}`);
  }
}
