import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { ask, askMasked, confirm } from '../lib/prompt.js';
import { getLedgerDir, loadConfigFile, getDefaultConfig } from '../lib/config.js';
import { getMigrationFiles, readMigration } from '../lib/migrate.js';
import { enableBackupCron } from './backup.js';

export async function init(): Promise<void> {
  const ledgerDir = getLedgerDir();
  const envPath = resolve(ledgerDir, '.env');
  const configPath = resolve(ledgerDir, 'config.json');

  console.error('Welcome to Ledger.\n');

  mkdirSync(ledgerDir, { recursive: true });

  let supabaseUrl = '';
  let supabaseKey = '';
  let openaiKey = '';

  // Step 1: Check existing credentials
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

  // Step 2: Get credentials
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

  // Step 3: Write/merge config.json
  const existing = loadConfigFile();
  const defaults = getDefaultConfig();
  const merged = {
    ...defaults,
    ...existing,
    hooks: { ...defaults.hooks, ...existing.hooks },
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
  console.error('Config saved to ~/.ledger/config.json\n');

  // Step 4: Verify Supabase connection
  console.error('Connecting to Supabase...');
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { error: connError } = await supabase
    .from('schema_migrations')
    .select('version')
    .limit(1);

  const isNew = connError?.code === '42P01'; // relation does not exist
  if (connError && !isNew) {
    console.error(`Connection error: ${connError.message}`);
    console.error('Check your Supabase URL and service role key.');
    process.exit(1);
  }
  console.error('Connected.\n');

  // Step 5: Validate OpenAI key
  console.error('Validating OpenAI key...');
  try {
    const openai = new OpenAI({ apiKey: openaiKey });
    await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'test' });
    console.error('OpenAI key valid.\n');
  } catch (e) {
    console.error(`OpenAI key invalid: ${(e as Error).message}`);
    console.error('Check your OpenAI API key.');
    process.exit(1);
  }

  // Step 6: Run migrations or confirm existing
  if (isNew) {
    console.error('New database detected. Setting up schema...\n');
    const files = getMigrationFiles();
    const allSql = files.map(f => {
      const sql = readMigration(f);
      return `-- ${f}\n${sql}`;
    }).join('\n\n');

    console.error('Run the following SQL in Supabase Dashboard > SQL Editor:\n');
    console.error('='.repeat(60));
    console.error(allSql);
    console.error('='.repeat(60));
    console.error('');
    await ask('Press Enter after running the SQL...');

    // Verify
    const { error: verifyError } = await supabase
      .from('notes')
      .select('id')
      .limit(1);

    if (verifyError) {
      console.error('Notes table not found. Make sure you ran all the SQL above.');
      process.exit(1);
    }

    console.error('Schema verified.\n');
  } else {
    const { count } = await supabase
      .from('notes')
      .select('*', { count: 'exact', head: true });
    console.error(`Found existing Ledger with ${count ?? 0} notes.\n`);
  }

  // Step 7: Offer daily backup
  const wantBackup = await confirm('Enable daily local backup? (Saves all notes to ~/.ledger/backups/ at 1am)');
  if (wantBackup) {
    enableBackupCron();
  }

  console.error('\nInit complete.');
  console.error('Run `ledger setup <platform>` to connect an agent.');
  console.error('Platforms: claude-code, openclaw, chatgpt');
}
