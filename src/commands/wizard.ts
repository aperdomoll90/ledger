import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { ask, confirm, choose } from '../lib/prompt.js';
import { getLedgerDir, loadConfigFile, type LedgerConfig } from '../lib/config.js';
import { fetchPersonaNotes } from '../lib/notes.js';
import { gatherCredentials, connectAndMigrate, hasCredentials, readCredentials, type RawCredentials, type ConnectResult } from './init.js';
import { onboard } from './onboard.js';
import {
  setupClaudeCode, setupOpenclaw, setupChatgpt,
  detectPlatform, uninstallClaudeCode, uninstallOpenclaw,
  type PlatformName,
} from './setup.js';
import { sync } from './sync.js';
import { getMemoryFiles } from './migrate.js';
import { enableBackupCron } from './backup.js';

// --- Step status ---

interface StepResult {
  ran: boolean;
  skipped: boolean;
  error?: string;
}

function ok(): StepResult { return { ran: true, skipped: false }; }
function skipped(): StepResult { return { ran: false, skipped: true }; }
function failed(msg: string): StepResult { return { ran: true, skipped: false, error: msg }; }

// --- Wizard ---

export async function wizard(): Promise<void> {
  console.error('Ledger Init Wizard\n');

  // Detect what's already done
  const checks = detectAllSteps();

  if (checks.allDone) {
    await showAlreadySetUp(checks);
    return;
  }

  // Run steps sequentially
  let creds: RawCredentials | null = null;
  let connectResult: ConnectResult | null = null;
  let config: LedgerConfig | null = null;

  // Step 1: Credentials
  if (checks.credentials) {
    console.error('Step 1: Credentials: found (Supabase + OpenAI)\n');
    creds = readCredentials();
  } else {
    console.error('Step 1: Credentials\n');
    const result = await runNonSkippable('Credentials', async () => {
      creds = await gatherCredentials();
    });
    if (result.error) return;
  }

  // Step 2: Database
  if (!creds) {
    creds = readCredentials();
    if (!creds) {
      console.error('Cannot proceed without credentials.');
      return;
    }
  }

  if (checks.database) {
    console.error(`Step 2: Database: connected (${checks.noteCount} notes)\n`);
    // Construct clients from existing creds
    const supabase = createClient(creds.supabaseUrl, creds.supabaseKey);
    const openai = new OpenAI({ apiKey: creds.openaiKey });
    connectResult = { supabase, openai, noteCount: checks.noteCount };
  } else {
    console.error('Step 2: Connect to database\n');
    const result = await runNonSkippable('Database', async () => {
      connectResult = await connectAndMigrate(creds!);
    });
    if (result.error) return;
  }

  // Build LedgerConfig for remaining steps
  if (connectResult) {
    const configFile = loadConfigFile();
    const HOME_PROJECT_DIR = homedir().replace(/\//g, '-');
    config = {
      memoryDir: configFile.memoryDir || resolve(homedir(), `.claude/projects/${HOME_PROJECT_DIR}/memory`),
      claudeMdPath: configFile.claudeMdPath || resolve(homedir(), 'CLAUDE.md'),
      supabase: connectResult.supabase,
      openai: connectResult.openai,
    };
  }

  if (!config) {
    console.error('Cannot proceed without database connection.');
    return;
  }

  // Step 3: Device alias
  if (checks.device) {
    console.error(`Step 3: Device: ${checks.deviceAlias}\n`);
  } else {
    console.error('Step 3: Device alias (optional)\n');
    await runSkippable('Device alias', () => stepDeviceAlias(config!));
  }

  // Step 4: Persona
  if (checks.persona) {
    console.error(`Step 4: Persona: found\n`);
    const update = await confirm('  Update persona?');
    if (update) {
      await onboard(config, { skipExistingCheck: true });
    }
  } else {
    console.error('Step 4: Build persona\n');
    await runSkippable('Persona', () => onboard(config!, { skipExistingCheck: true }));
  }

  // Step 5: Platforms
  console.error('Step 5: Platform setup\n');
  await runSkippable('Platform setup', () => stepPlatforms(config!));

  // Step 6: Sync (always runs)
  console.error('Step 6: Sync\n');
  const syncResult = await sync(config, { quiet: false, force: false, dryRun: false });

  // Step 7: Migrate local files
  const unknownFiles = getMemoryFiles(config);
  const personaNotes = await fetchPersonaNotes(config.supabase);
  const knownFiles = new Set(personaNotes.map(n => n.metadata.local_file).filter(Boolean));
  const unknowns = unknownFiles.filter(f => !knownFiles.has(f));

  if (unknowns.length === 0) {
    console.error('Step 7: Migration: no unknown files\n');
  } else {
    console.error(`Step 7: Migration: ${unknowns.length} unknown file(s) found\n`);
    console.error('  Run `ledger migrate` to process these files.\n');
  }

  // Summary
  console.error('='.repeat(40));
  console.error('Wizard complete.\n');
  const parts = [
    syncResult.downloaded.length > 0 ? `${syncResult.downloaded.length} downloaded` : null,
    syncResult.uploaded.length > 0 ? `${syncResult.uploaded.length} uploaded` : null,
    syncResult.conflicts.length > 0 ? `${syncResult.conflicts.length} conflicts` : null,
  ].filter(Boolean);
  if (parts.length > 0) {
    console.error(`  Sync: ${parts.join(', ')}`);
  }
  console.error('  Run `ledger show <query>` to search your knowledge.');
}

// --- Step detection ---

interface StepChecks {
  credentials: boolean;
  database: boolean;
  noteCount: number;
  device: boolean;
  deviceAlias: string;
  persona: boolean;
  allDone: boolean;
}

function detectAllSteps(): StepChecks {
  const credentials = hasCredentials();

  let database = false;
  let noteCount = 0;
  let device = false;
  let deviceAlias = '';
  let persona = false;

  if (credentials) {
    // We can't check database without connecting, so we'll trust config
    // The actual connection test happens in step 2
    const creds = readCredentials();
    database = creds !== null; // If we can read creds, assume DB was set up before
  }

  const configFile = loadConfigFile();
  if (configFile.device?.alias) {
    device = true;
    deviceAlias = configFile.device.alias;
  }

  // We can't check persona or noteCount without connecting — these will be
  // checked at runtime if credentials exist. For the allDone check,
  // we conservatively say not all done if we can't verify.

  return {
    credentials,
    database,
    noteCount,
    device,
    deviceAlias,
    persona,
    allDone: false, // Full allDone check requires DB connection, done in showAlreadySetUp
  };
}

async function showAlreadySetUp(checks: StepChecks): Promise<void> {
  // If we got here, credentials exist. Connect to verify everything.
  const creds = readCredentials();
  if (!creds) return;

  let connectResult: ConnectResult;
  try {
    const supabase = createClient(creds.supabaseUrl, creds.supabaseKey);
    const { count } = await supabase
      .from('notes')
      .select('*', { count: 'exact', head: true });
    const noteCount = count ?? 0;
    const openai = new OpenAI({ apiKey: creds.openaiKey });

    // Check persona
    const { data: personaData } = await supabase
      .from('notes')
      .select('id')
      .eq('metadata->>delivery', 'persona')
      .limit(1);

    const hasPersona = personaData !== null && personaData.length > 0;

    // Check platforms
    const claudeCode = detectPlatform('claude-code');
    const openclaw = detectPlatform('openclaw');

    const platforms = [
      claudeCode.installed ? 'Claude Code' : null,
      openclaw.installed ? 'OpenClaw' : null,
    ].filter(Boolean);

    const configFile = loadConfigFile();

    // Now check if truly everything is set up
    const allDone = hasPersona && checks.credentials;

    if (!allDone) {
      // Not everything is done — let the main flow handle it
      // Reset and run wizard normally
      checks.noteCount = noteCount;
      checks.persona = hasPersona;
      checks.database = true;
      return;
    }

    console.error('Ledger is already set up.');
    console.error(`  Credentials: found (Supabase + OpenAI)`);
    console.error(`  Database: connected (${noteCount} notes)`);
    console.error(`  Device: ${configFile.device?.alias || '(not set)'}`);
    console.error(`  Persona: found`);
    console.error(`  Platforms: ${platforms.length > 0 ? platforms.join(', ') : '(none)'}`);
    console.error('');

    const rerun = await ask('Re-run a step? [1-7 or Enter to skip] ');
    if (!rerun) return;

    const step = parseInt(rerun, 10);
    if (step < 1 || step > 7) return;

    // Build config for re-running
    const config: LedgerConfig = {
      memoryDir: configFile.memoryDir || resolve(homedir(), `.claude/projects/${homedir().replace(/\//g, '-')}/memory`),
      claudeMdPath: configFile.claudeMdPath || resolve(homedir(), 'CLAUDE.md'),
      supabase,
      openai,
    };

    // Re-running steps 1-2 re-runs all subsequent steps
    if (step <= 2) {
      // Re-run from the beginning by falling through
      console.error('Re-running from step 1 will re-run all subsequent steps.\n');
      const confirmRerun = await confirm('Continue?');
      if (!confirmRerun) return;
      // Recursively call wizard (which won't hit allDone since we're forcing re-run)
      // For simplicity, just call the individual steps
      if (step === 1) {
        await gatherCredentials();
        const newCreds = readCredentials()!;
        await connectAndMigrate(newCreds);
      } else {
        await connectAndMigrate(creds);
      }
      await stepDeviceAlias(config);
      await onboard(config);
      await stepPlatforms(config);
      await sync(config, { quiet: false, force: false, dryRun: false });
      return;
    }

    switch (step) {
      case 3: await stepDeviceAlias(config); break;
      case 4: await onboard(config); break;
      case 5: await stepPlatforms(config); break;
      case 6: await sync(config, { quiet: false, force: false, dryRun: false }); break;
      case 7: {
        const { migrate } = await import('./migrate.js');
        await migrate(config);
        break;
      }
    }
  } catch {
    // Connection failed — re-run wizard from scratch
    console.error('Could not verify setup. Running wizard...\n');
  }
}

// --- Step implementations ---

async function stepDeviceAlias(config: LedgerConfig): Promise<void> {
  const configFile = loadConfigFile();
  const current = configFile.device?.alias;

  if (current) {
    console.error(`  Current device alias: ${current}`);
    const change = await confirm('  Change it?');
    if (!change) return;
  }

  const alias = await ask('  Name this device? (optional, press Enter to skip) ');
  if (!alias) return;

  // Save to config.json
  const ledgerDir = getLedgerDir();
  const configPath = resolve(ledgerDir, 'config.json');
  const updated = { ...configFile, device: { alias } };
  writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n');
  console.error(`  Device alias set to "${alias}"\n`);

  // Update user-devices note in Ledger
  const today = new Date().toISOString().split('T')[0];

  const { data: existing } = await config.supabase
    .from('notes')
    .select('id, content, metadata')
    .eq('metadata->>upsert_key', 'user-devices')
    .limit(1)
    .single();

  if (existing) {
    // Check if device already listed
    if (!existing.content.includes(alias)) {
      const newContent = `${existing.content}\n- ${alias} (registered ${today})`;
      await config.supabase
        .from('notes')
        .update({ content: newContent, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      console.error(`  Added "${alias}" to device registry.\n`);
    }
  } else {
    // Create device registry note
    const content = `## Devices\n- ${alias} (registered ${today})`;
    const openai = config.openai;
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: content,
    });

    await config.supabase
      .from('notes')
      .insert({
        content,
        metadata: {
          type: 'reference',
          delivery: 'knowledge',
          agent: 'ledger-wizard',
          scope: 'user',
          upsert_key: 'user-devices',
          description: 'Registry of all devices connected to this Ledger instance.',
        },
        embedding: embeddingResponse.data[0].embedding,
      });
    console.error(`  Created device registry with "${alias}".\n`);
  }
}

async function stepPlatforms(_config: LedgerConfig): Promise<void> {
  const platforms: PlatformName[] = ['claude-code', 'openclaw', 'chatgpt'];

  for (const name of platforms) {
    const status = detectPlatform(name);
    const label = name === 'claude-code' ? 'Claude Code' : name === 'openclaw' ? 'OpenClaw' : 'ChatGPT';

    if (status.installed) {
      console.error(`  ${label} (installed)`);
      const action = await choose(`  Action for ${label}:`, ['Keep', 'Reinstall', 'Uninstall']);

      if (action === 'Reinstall') {
        console.error(`  Reinstalling ${label}...\n`);
        if (name === 'claude-code') {
          uninstallClaudeCode();
          await setupClaudeCode();
        } else if (name === 'openclaw') {
          uninstallOpenclaw();
          await setupOpenclaw();
        }
      } else if (action === 'Uninstall') {
        console.error(`  Uninstalling ${label}...\n`);
        if (name === 'claude-code') {
          uninstallClaudeCode();
        } else if (name === 'openclaw') {
          uninstallOpenclaw();
        }
      } else {
        console.error(`  Keeping ${label}.\n`);
      }
    } else {
      // ChatGPT never shows as installed but is always available to install
      if (name === 'chatgpt') {
        console.error(`  ${label} (static snapshot)`);
      } else if (status.detail === 'Claude Code CLI not found') {
        console.error(`  ${label}: CLI not found — skipping. Install it and run 'ledger setup claude-code' later.\n`);
        continue;
      } else {
        console.error(`  ${label} (not installed)`);
      }

      const action = await choose(`  Action for ${label}:`, ['Install', 'Skip']);

      if (action === 'Install') {
        console.error(`  Installing ${label}...\n`);
        if (name === 'claude-code') {
          await setupClaudeCode();
        } else if (name === 'openclaw') {
          await setupOpenclaw();
        } else {
          await setupChatgpt();
        }
      } else {
        console.error(`  Skipped.\n`);
      }
    }
  }
}

// --- Error handling wrappers ---

async function runNonSkippable(label: string, fn: () => Promise<void>): Promise<StepResult> {
  while (true) {
    try {
      await fn();
      return ok();
    } catch (e) {
      console.error(`  ${label} failed: ${(e as Error).message}\n`);
      const action = await choose('  What to do?', ['Retry', 'Quit']);
      if (action === 'Quit') {
        console.error('Wizard cancelled.');
        return failed((e as Error).message);
      }
    }
  }
}

async function runSkippable(label: string, fn: () => Promise<void>): Promise<StepResult> {
  try {
    await fn();
    return ok();
  } catch (e) {
    console.error(`  ${label} failed: ${(e as Error).message}\n`);
    const action = await choose('  What to do?', ['Retry', 'Skip', 'Quit']);
    if (action === 'Quit') {
      console.error('Wizard cancelled.');
      return failed((e as Error).message);
    }
    if (action === 'Skip') {
      return skipped();
    }
    // Retry
    return runSkippable(label, fn);
  }
}
