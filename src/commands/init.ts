import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { ask, askMasked, confirm } from '../lib/prompt.js';
import { getLedgerDir, loadConfigFile, getDefaultConfig } from '../lib/config.js';
import { getMigrationFiles, readMigration } from '../lib/migrate.js';
import { enableBackupCron } from './backup.js';

// --- Exported types ---

export interface RawCredentials {
  supabaseUrl: string;
  supabaseKey: string;
  openaiKey: string;
}

export interface ConnectResult {
  supabase: SupabaseClient;
  openai: OpenAI;
  documentCount: number;
}

// --- Extracted helpers ---

/** Gather or load credentials. Returns raw values for use before loadConfig() is safe. */
export async function gatherCredentials(): Promise<RawCredentials> {
  const ledgerDir = getLedgerDir();
  const envPath = resolve(ledgerDir, '.env');
  const configPath = resolve(ledgerDir, 'config.json');

  mkdirSync(ledgerDir, { recursive: true });

  let supabaseUrl = '';
  let supabaseKey = '';
  let openaiKey = '';

  // Check existing credentials
  if (existsSync(envPath)) {
    const overwrite = await confirm('Existing credentials found. Overwrite?');
    if (!overwrite) {
      console.error('Keeping existing credentials.\n');
      const envContent = readFileSync(envPath, 'utf-8');
      for (const line of envContent.split('\n')) {
        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) continue;
        const key = line.slice(0, eqIndex);
        const value = line.slice(eqIndex + 1);
        if (key === 'SUPABASE_URL') supabaseUrl = value;
        if (key === 'SUPABASE_SERVICE_ROLE_KEY') supabaseKey = value;
        if (key === 'OPENAI_API_KEY') openaiKey = value;
      }
    }
  }

  // Prompt for credentials if not loaded
  if (!supabaseUrl) {
    const hasProject = await confirm('Do you have a Supabase project?');

    if (!hasProject) {
      console.error(`
To create a Supabase project:
  1. Go to https://supabase.com and create a free account
  2. Create a new project (any name, any region)
  3. Enable pgvector: Database > Extensions > search "vector" > Enable
  4. Go to Settings > API and copy:
     - Project URL
     - service_role key (under "Project API keys")
  5. Get an OpenAI API key from https://platform.openai.com/api-keys
`);
      await ask('Press Enter when ready...');
    }

    supabaseUrl = await ask('Supabase URL: ');
    supabaseKey = await askMasked('Service Role Key: ');
    openaiKey = await askMasked('OpenAI API Key (required for embeddings, even with Claude): ');

    const envContent = [
      `SUPABASE_URL=${supabaseUrl}`,
      `SUPABASE_SERVICE_ROLE_KEY=${supabaseKey}`,
      `OPENAI_API_KEY=${openaiKey}`,
      '',
    ].join('\n');
    writeFileSync(envPath, envContent, { mode: 0o600 });
    console.error('Credentials saved to ~/.ledger/.env\n');
  }

  // Write/merge config.json
  const existing = loadConfigFile();
  const defaults = getDefaultConfig();
  const merged = {
    ...defaults,
    ...existing,
    hooks: { ...defaults.hooks, ...existing.hooks },
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  console.error('Config saved to ~/.ledger/config.json\n');

  return { supabaseUrl, supabaseKey, openaiKey };
}

/** Check if credentials file exists and has all required keys. */
export function hasCredentials(): boolean {
  const envPath = resolve(getLedgerDir(), '.env');
  if (!existsSync(envPath)) return false;
  const content = readFileSync(envPath, 'utf-8');
  return content.includes('SUPABASE_URL=') &&
    content.includes('SUPABASE_SERVICE_ROLE_KEY=') &&
    content.includes('OPENAI_API_KEY=');
}

/** Read raw credentials from the .env file without prompting. */
export function readCredentials(): RawCredentials | null {
  const envPath = resolve(getLedgerDir(), '.env');
  if (!existsSync(envPath)) return null;

  let supabaseUrl = '';
  let supabaseKey = '';
  let openaiKey = '';

  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex);
    const value = line.slice(eqIndex + 1);
    if (key === 'SUPABASE_URL') supabaseUrl = value;
    if (key === 'SUPABASE_SERVICE_ROLE_KEY') supabaseKey = value;
    if (key === 'OPENAI_API_KEY') openaiKey = value;
  }

  if (!supabaseUrl || !supabaseKey || !openaiKey) return null;
  return { supabaseUrl, supabaseKey, openaiKey };
}

/** Connect to Supabase + OpenAI, run migrations if needed. Returns clients + document count. */
export async function connectAndMigrate(creds: RawCredentials): Promise<ConnectResult> {
  // Verify Supabase connection
  console.error('Connecting to Supabase...');
  const supabase = createClient(creds.supabaseUrl, creds.supabaseKey);

  const { error: connError } = await supabase
    .from('documents')
    .select('id')
    .limit(1);

  const isNew = connError !== null;
  if (isNew && !connError.message.includes('documents')) {
    throw new Error(`Connection error: ${connError.message}`);
  }
  if (isNew) {
    console.error('Connected (new database).\n');
  } else {
    console.error('Connected.\n');
  }

  // Validate OpenAI key
  console.error('Validating OpenAI key...');
  const openai = new OpenAI({ apiKey: creds.openaiKey });
  try {
    await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'test' });
    console.error('OpenAI key valid.\n');
  } catch (e) {
    throw new Error(`OpenAI key invalid: ${(e as Error).message}`);
  }

  // Run migrations if new database
  let documentCount = 0;
  if (isNew) {
    console.error('New database detected. Setting up schema...\n');
    const files = getMigrationFiles();
    const allSql = files.map(file => {
      const sql = readMigration(file);
      return `-- ${file}\n${sql}`;
    }).join('\n\n');

    console.error('Run the following SQL in Supabase Dashboard > SQL Editor:\n');
    console.error('='.repeat(60));
    console.error(allSql);
    console.error('='.repeat(60));
    console.error('');
    await ask('Press Enter after running the SQL...');

    const { error: verifyError } = await supabase
      .from('documents')
      .select('id')
      .limit(1);

    if (verifyError) {
      throw new Error('Documents table not found. Make sure you ran all the SQL above.');
    }

    console.error('Schema verified.\n');
  } else {
    const { count } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true });
    documentCount = count ?? 0;
    console.error(`Found existing Ledger with ${documentCount} documents.\n`);
  }

  return { supabase, openai, documentCount };
}

// --- Standalone init command (delegates to helpers) ---

export async function init(): Promise<void> {
  console.error('Welcome to Ledger.\n');

  const creds = await gatherCredentials();

  try {
    await connectAndMigrate(creds);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }

  const wantBackup = await confirm('Enable daily local backup? (Saves all documents to ~/.ledger/backups/ at 1am)');
  if (wantBackup) {
    enableBackupCron();
  }

  console.error('\nInit complete.');
}
